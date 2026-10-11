/**
 * reconcile-positions — settle open live_positions using Polymarket's
 * /positions API (the authoritative view of what the proxy holds and what
 * each position is worth).
 *
 * The bot's `simple-copy-trader` closes positions only on `target_sold`
 * events. It has no "close on resolution" path. When a market resolves and
 * auto-redeem (or manual UI redemption) sweeps the payout into the wallet,
 * the position is settled — but our DB still says status='open'. This script
 * fixes that.
 *
 * Methodology:
 *   1. Pull /positions?user=POLY_FUNDER for every position the proxy still
 *      visibly holds. Polymarket pre-computes `cashPnl` per position, which
 *      is the source of truth (it knows your full cost basis from Polymarket
 *      history we don't have).
 *
 *   2. For every status='open' position in our DB, match by conditionId +
 *      outcome:
 *
 *      a. If Polymarket returns it AND `redeemable=true` → market resolved,
 *         settle using Polymarket's cashPnl directly.
 *
 *      b. If Polymarket returns it AND `redeemable=false` → market still
 *         open. Leave as-is (it'll close naturally on target_sold or a
 *         future reconcile).
 *
 *      c. If Polymarket doesn't return it at all → the position is already
 *         fully redeemed (auto-redeem fired and converted shares to USDC).
 *         We can't get cashPnl from /positions for these. Fall back: if our
 *         markets table has resolved_to, compute pnl manually
 *         (win = shares − size_usd; loss = −size_usd). If we don't know,
 *         mark as 'unknown' and skip — leave open so a human can investigate.
 *
 *   3. Also opportunistically refresh `markets.resolved_to` from Polymarket
 *      so the scorer's view of resolution stays current.
 *
 * Usage:
 *   tsx packages/core/src/cli/reconcile-positions.ts          # dry-run
 *   tsx packages/core/src/cli/reconcile-positions.ts --apply  # write
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';
import { request as undiciRequest } from 'undici';
import { fetchOnChainWinner } from '../services/ctf-resolution.js';

void config;

const POLY_DATA_API = 'https://data-api.polymarket.com';
const UA = 'Mozilla/5.0 (compatible; palpha-reconcile/1.0)';

interface PolymarketPosition {
  proxyWallet: string;
  conditionId: string;
  asset: string;
  outcome: string;
  outcomeIndex?: number;
  size: number;            // shares currently held
  avgPrice: number;        // cost basis
  initialValue: number;    // shares * avgPrice
  currentValue: number;    // mark-to-market value now (0 if lost-and-resolved)
  cashPnl: number;         // Polymarket's authoritative PnL
  percentPnl?: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable?: boolean;
  title?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

async function fetchAllPositions(funder: string): Promise<PolymarketPosition[]> {
  // sizeThreshold=0 + omit redeemable filter → returns every position the proxy
  // currently holds, regardless of size or resolution state.
  const all: PolymarketPosition[] = [];
  let offset = 0;
  while (true) {
    const url = `${POLY_DATA_API}/positions?user=${funder}&limit=500&offset=${offset}&sizeThreshold=0`;
    const res = await undiciRequest(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.statusCode !== 200) {
      const body = await res.body.text();
      throw new Error(`Polymarket API HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
    }
    const batch = (await res.body.json()) as PolymarketPosition[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 500) break;
    offset += 500;
    if (offset > 5000) break; // safety
  }
  return all;
}

const CLOB_API = 'https://clob.polymarket.com';

/** Winning outcome string for a resolved market, or null if not
 *  resolved/unavailable. Used to settle positions that Polymarket no longer
 *  reports (already redeemed) and that we never recorded a resolution for.
 *
 *  Asks the CLOB first, then the CTF payout on chain — sports props settle on
 *  chain only and the CLOB reports them as no-winner forever. */
async function winningOutcome(conditionId: string): Promise<string | null> {
  let tokens: { token_id: string; outcome: string; winner: boolean }[] = [];
  try {
    const res = await fetch(`${CLOB_API}/markets/${conditionId}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const m = (await res.json()) as { closed?: boolean; tokens?: typeof tokens };
      tokens = m.tokens ?? [];
      if (m.closed) {
        const winner = tokens.find((t) => t.winner)?.outcome;
        if (winner) return winner;
      }
    }
  } catch { /* fall through to the chain */ }

  try {
    return await fetchOnChainWinner(
      conditionId,
      tokens.map((t) => ({ tokenId: t.token_id, outcome: t.outcome })),
    );
  } catch {
    return null;
  }
}

const sameOutcome = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function main() {
  const apply = process.argv.includes('--apply');

  const funder = process.env.POLY_FUNDER;
  if (!funder) throw new Error('POLY_FUNDER not set in .env');

  console.log('=== reconcile-positions ===');
  console.log(`  Mode:   ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  Funder: ${funder}`);
  console.log('');

  const openRes = await query(
    `SELECT id, condition_id, outcome, side, entry_price, size_usd, shares,
            opened_at, metadata
       FROM live_positions
      WHERE status='open'
      ORDER BY opened_at ASC`,
  );
  const open = openRes.rows;
  console.log(`Found ${open.length} open live_positions in DB.\n`);
  if (open.length === 0) {
    await shutdown();
    return;
  }

  console.log('Fetching all positions for proxy from Polymarket Data API...');
  const polyPositions = await fetchAllPositions(funder);
  console.log(`  → Polymarket reports ${polyPositions.length} positions still held.\n`);

  // Index Polymarket positions by (conditionId, outcome) for O(1) lookup
  const byKey = new Map<string, PolymarketPosition>();
  for (const p of polyPositions) {
    byKey.set(`${p.conditionId.toLowerCase()}:${p.outcome}`, p);
  }

  type Plan = {
    id: number;
    row: typeof open[number];
    poly?: PolymarketPosition;
    action: 'settle_via_poly' | 'still_open' | 'fallback_won' | 'fallback_lost' | 'unknown';
    exit: number;
    pnl: number;
    reason: string;
  };
  const plans: Plan[] = [];

  for (const r of open) {
    const key = `${r.condition_id.toLowerCase()}:${r.outcome}`;
    const poly = byKey.get(key);

    if (poly) {
      if (poly.redeemable) {
        // Market resolved AND we still hold shares (auto-redeem hasn't fired
        // yet for these). cashPnl is authoritative.
        const exit = poly.size > 0 ? poly.currentValue / poly.size : 0;
        plans.push({
          id: r.id, row: r, poly,
          action: 'settle_via_poly',
          exit,
          pnl: poly.cashPnl,
          reason: poly.currentValue > 0 ? 'redeemed_win' : 'redeemed_loss',
        });
      } else {
        plans.push({
          id: r.id, row: r, poly,
          action: 'still_open',
          exit: 0, pnl: 0,
          reason: 'market_not_resolved',
        });
      }
    } else {
      // Not in Polymarket's holdings → likely fully redeemed already.
      // Fallback: read our own markets table.
      const mRes = await query(
        `SELECT resolved_to FROM markets WHERE condition_id = $1 LIMIT 1`,
        [r.condition_id],
      );
      let resolvedTo = mRes.rows[0]?.resolved_to;
      // Redeemed on-chain but we never recorded the outcome — ask CLOB directly.
      if (!resolvedTo) {
        resolvedTo = await winningOutcome(r.condition_id);
      }
      if (!resolvedTo) {
        plans.push({
          id: r.id, row: r,
          action: 'unknown',
          exit: 0, pnl: 0,
          reason: 'not_in_poly_positions_and_no_resolution_in_db',
        });
      } else if (sameOutcome(resolvedTo, r.outcome)) {
        plans.push({
          id: r.id, row: r,
          action: 'fallback_won',
          exit: 1.0,
          pnl: r.shares - r.size_usd,
          reason: 'redeemed_win_inferred',
        });
      } else {
        plans.push({
          id: r.id, row: r,
          action: 'fallback_lost',
          exit: 0.0,
          pnl: -r.size_usd,
          reason: 'redeemed_loss_inferred',
        });
      }
    }
  }

  // Summary
  const counts = plans.reduce((acc, p) => { acc[p.action] = (acc[p.action] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log('--- Summary ---');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
  const totalPnl = plans.filter(p => p.action !== 'still_open' && p.action !== 'unknown')
                        .reduce((s, p) => s + p.pnl, 0);
  console.log(`  total realized pnl    ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)}`);
  console.log('');

  console.log('--- Plan ---');
  for (const p of plans) {
    const title = (p.poly?.title ?? '(not in poly)').slice(0, 45).padEnd(45);
    console.log(
      `  id=${String(p.id).padStart(4)} ${p.action.padEnd(18)} ${title}  outcome=${p.row.outcome.slice(0,15).padEnd(15)} pnl=${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(4)}  (${p.reason})`,
    );
  }
  console.log('');

  if (!apply) {
    console.log('Dry-run. Re-run with --apply to write changes.');
    await shutdown();
    return;
  }

  // Apply
  let updated = 0;
  for (const p of plans) {
    if (p.action === 'still_open' || p.action === 'unknown') continue;
    await query(
      `UPDATE live_positions
          SET status='closed',
              closed_at = NOW(),
              exit_price = $1,
              pnl = $2,
              metadata = metadata || jsonb_build_object('close_reason', $3::text)
        WHERE id = $4`,
      [p.exit, p.pnl, p.reason, p.id],
    );
    updated++;
  }
  console.log(`✓ Updated ${updated} positions to status='closed'.`);
  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
