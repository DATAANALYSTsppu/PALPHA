/**
 * redeem-positions — Reconcile `redeem_pending` live positions with on-chain reality.
 *
 * When a market resolves, the bot marks positions as `redeem_pending` rather
 * than placing a CLOB SELL (which won't fill at $1.0 / $0.0). The proxy
 * wallet still holds the outcome tokens at this point.
 *
 * Polymarket's UI auto-redeems winning positions when you visit your portfolio.
 * This script reconciles redemptions:
 *
 *   1. For each `redeem_pending` position, check the proxy wallet's current
 *      Polymarket positions. If the conditionId is no longer in the active
 *      positions list, the redemption already happened — mark `closed`.
 *
 *   2. For positions still showing on-chain, print a manual redemption list.
 *      User can either:
 *      a) Visit polymarket.com/portfolio → auto-redeems winners
 *      b) Run a manual redeemPositions tx via Polygonscan
 *
 *   3. By default this is a DRY RUN: prints what it would do but doesn't
 *      update the DB. Use --apply to actually update.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/redeem-positions.ts            # dry run
 *   npx tsx packages/core/src/cli/redeem-positions.ts --apply    # real
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';
import { fetchPositionsRaw } from '../api/data.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:redeem-positions');

const CLOB = config.api.clobUrl || 'https://clob.polymarket.com';

/** Winning token id from CLOB tokens[].winner, or null if not resolved. */
async function winningTokenId(conditionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${CLOB}/markets/${conditionId}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const m = (await res.json()) as { closed?: boolean; tokens?: { token_id: string; winner: boolean }[] };
    if (!m.closed || !Array.isArray(m.tokens)) return null;
    return m.tokens.find((t) => t.winner)?.token_id ?? null;
  } catch {
    return null;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}

interface RedeemPendingRow {
  id: number;
  condition_id: string;
  side: string;
  shares: number;
  size_usd: number;
  exit_price: number | null;
  pnl: number | null;
  closed_at: string | null;
  metadata: Record<string, unknown>;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const proxyWallet = process.env.POLY_FUNDER;

  if (!proxyWallet) {
    console.error('POLY_FUNDER not set in .env (need proxy wallet address to query positions)');
    process.exit(1);
  }

  console.log('=== Redeem Positions Reconciliation ===');
  console.log(`  Proxy wallet:     ${proxyWallet}`);
  console.log(`  Mode:             ${apply ? 'APPLY (will update DB)' : 'DRY RUN (read-only)'}`);
  console.log('');

  // 1. Get all redeem_pending live positions
  const pendingRes = await query(
    `SELECT id, condition_id, side, shares, size_usd, exit_price, pnl, closed_at, metadata
     FROM live_positions
     WHERE status = 'redeem_pending'
     ORDER BY closed_at ASC NULLS LAST`
  );
  const pending = pendingRes.rows as RedeemPendingRow[];

  if (pending.length === 0) {
    console.log('No positions in redeem_pending state. Nothing to do.');
    await shutdown();
    return;
  }

  console.log(`Found ${pending.length} redeem_pending positions.\n`);

  // 2. Fetch current positions from Polymarket for the proxy
  let activeConditionIds: Set<string>;
  try {
    const positions = await fetchPositionsRaw(proxyWallet);
    activeConditionIds = new Set(
      positions
        .filter(p => parseFloat(String(p.size ?? 0)) > 0)
        .map(p => String(p.conditionId ?? ''))
        .filter(Boolean)
    );
    console.log(`Polymarket reports ${activeConditionIds.size} currently held positions for proxy.\n`);
  } catch (err) {
    console.error('Failed to fetch on-chain positions:', (err as Error).message);
    await shutdown();
    process.exit(1);
  }

  // 3. Categorize: redeemed vs still on-chain
  const redeemed: RedeemPendingRow[] = [];
  const stillHeld: RedeemPendingRow[] = [];

  for (const pos of pending) {
    if (activeConditionIds.has(pos.condition_id)) {
      stillHeld.push(pos);
    } else {
      redeemed.push(pos);
    }
  }

  console.log('=== Reconciliation Results ===');
  console.log(`  Already redeemed (off-chain): ${redeemed.length}`);
  console.log(`  Still held on-chain:          ${stillHeld.length}`);
  console.log('');

  // 4. Update redeemed positions to 'closed' — computing realized P/L.
  // We don't just flip status: that left pnl=NULL, which understated the
  // dashboard's realized P/L and win rate. Win/loss is decided by the WINNING
  // TOKEN id (robust for multi-outcome markets where side is 'BUY' and outcomes
  // are team names), then pnl = (won ? shares : 0) - size_usd.
  if (redeemed.length > 0) {
    console.log('--- Already redeemed → mark closed (with P/L) ---');
    let updated = 0;
    for (const r of redeemed) {
      const meta = typeof r.metadata === 'string' ? safeParse(r.metadata) : (r.metadata || {});
      const tokenId = meta.token_id as string | undefined;
      const winId = await winningTokenId(r.condition_id);

      // Default to existing values if we can't resolve the winner this run.
      let pnl: number | null = r.pnl;
      let exitPrice: number | null = r.exit_price;
      let outcome = 'pnl?';
      if (tokenId && winId) {
        const won = winId === tokenId;
        exitPrice = won ? 1 : 0;
        pnl = (won ? r.shares : 0) - r.size_usd;
        outcome = won ? 'WON' : 'LOST';
      }
      console.log(`  position ${r.id}: ${r.condition_id.slice(0, 16)}... ${outcome} pnl=${pnl?.toFixed(4) ?? 'null'}`);

      if (apply) {
        const res = await query(
          `UPDATE live_positions
             SET status = 'closed',
                 pnl = COALESCE($1, pnl),
                 exit_price = COALESCE($2, exit_price),
                 metadata = metadata || $3::jsonb
           WHERE id = $4 AND status = 'redeem_pending'`,
          [pnl, exitPrice, JSON.stringify({ redemption_confirmed_at: new Date().toISOString() }), r.id]
        );
        updated += res.rowCount ?? 0;
      }
    }
    if (apply) console.log(`\n  ✓ Marked ${updated} positions as closed (P/L computed).\n`);
    else console.log(`\n  (dry-run) Would mark ${redeemed.length} positions as closed.\n`);
  }

  // 5. List positions still requiring redemption
  if (stillHeld.length > 0) {
    console.log('--- Still held on-chain (manual redemption required) ---');
    console.log('  Visit https://polymarket.com/portfolio while logged in with your wallet.');
    console.log('  Polymarket auto-redeems winning positions when you load the portfolio page.');
    console.log('  Losing positions stay forever (worth $0) — fine to leave alone.\n');
    for (const r of stillHeld) {
      const closedAgo = r.closed_at
        ? `${Math.floor((Date.now() - new Date(r.closed_at).getTime()) / 60000)} min ago`
        : 'unknown';
      console.log(`  position ${r.id}: ${r.condition_id} ${r.side} shares=${r.shares.toFixed(2)} expected_payout=$${(r.exit_price ?? 0) * r.shares} (closed ${closedAgo})`);
    }
    console.log('');
  }

  console.log('=== Done ===');
  if (!apply && redeemed.length > 0) {
    console.log('Re-run with --apply to mark redeemed positions as closed in DB.');
  }

  log.info({
    proxyWallet,
    pending: pending.length,
    redeemed: redeemed.length,
    stillHeld: stillHeld.length,
    applied: apply,
  }, 'Reconciliation complete');

  await shutdown();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
