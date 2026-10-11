/**
 * reconcile-fills — import untracked on-chain positions into live_positions.
 *
 * Why this exists:
 *   While the delayed-order bug was live, the bot placed orders that ACTUALLY
 *   FILLED on-chain but were recorded as `buy_failed:..._delayed` — so no
 *   live_positions row was created. The funder wallet ends up holding positions
 *   the bot has no record of, which means:
 *     - the dashboard understates exposure / P&L, and
 *     - the bot will NOT sell them when the leader exits (they're not "armed").
 *
 *   This pulls the funder's CURRENT on-chain positions, attributes each to the
 *   copy target that triggered it (the most recent `buy_failed` copy_signals row
 *   on the same market), and inserts an `open` live_positions row wired exactly
 *   like a normal copy (metadata.target_wallet + metadata.token_id) so the
 *   runner's SELL matcher fires when that target sells. It also flips the
 *   attributing signal's acted_on=true so dedup-by-open-position holds afterward.
 *
 * Safe by default: DRY RUN prints what it would import. --apply writes.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/reconcile-fills.ts            # dry run
 *   npx tsx packages/core/src/cli/reconcile-fills.ts --apply    # write
 */

import { query, getClient, shutdown } from '../db/pool.js';
import { fetchPositionsRaw } from '../api/data.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:reconcile-fills');

interface OnChainPos {
  conditionId: string;
  asset: string;       // outcome token id
  size: number;        // shares held
  avgPrice: number;    // avg entry price per share
  outcome: string;
  title: string;
}

function parsePos(p: Record<string, unknown>): OnChainPos | null {
  const conditionId = String(p.conditionId ?? '');
  const asset = String(p.asset ?? '');
  const size = parseFloat(String(p.size ?? 0));
  if (!conditionId || !asset || size <= 0) return null;
  return {
    conditionId,
    asset,
    size,
    avgPrice: parseFloat(String(p.avgPrice ?? 0)),
    outcome: String(p.outcome ?? ''),
    title: String(p.title ?? ''),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const funder = process.env.POLY_FUNDER;
  if (!funder) {
    console.error('POLY_FUNDER not set — need the proxy/funder wallet to read on-chain positions.');
    process.exit(1);
  }

  console.log('=== Reconcile untracked fills → live_positions ===');
  console.log(`  Funder: ${funder}`);
  console.log(`  Mode:   ${apply ? 'APPLY (writes)' : 'DRY RUN (read-only)'}\n`);

  const rawPositions = await fetchPositionsRaw(funder);
  const positions = rawPositions.map(parsePos).filter((p): p is OnChainPos => p !== null);
  console.log(`On-chain positions held by funder: ${positions.length}\n`);

  let imported = 0;
  let alreadyTracked = 0;
  let unattributed = 0;

  for (const pos of positions) {
    // Already tracked as an open position? (match on token + market)
    const existing = await query(
      `SELECT id FROM live_positions
        WHERE condition_id = $1 AND status = 'open' AND metadata->>'token_id' = $2
        LIMIT 1`,
      [pos.conditionId, pos.asset],
    );
    if (existing.rows.length > 0) {
      alreadyTracked++;
      continue;
    }

    // Attribute to the target whose copy we tried (and "failed") on this market.
    const sig = await query(
      `SELECT id, lower(proxy_wallet) AS target_wallet, source_trade_key, outcome, detected_at
         FROM copy_signals
        WHERE condition_id = $1 AND skip_reason LIKE 'buy_failed%'
        ORDER BY detected_at DESC
        LIMIT 1`,
      [pos.conditionId],
    );
    if (sig.rows.length === 0) {
      console.log(`  ? ${pos.title.slice(0, 40)} — no buy_failed signal to attribute; SKIP (manual review)`);
      unattributed++;
      continue;
    }
    const s = sig.rows[0];
    const sizeUsd = pos.size * pos.avgPrice;
    const positionKey = `${pos.conditionId.slice(0, 8)}:reconciled:${pos.asset.slice(-6)}`;

    console.log(
      `  + ${pos.title.slice(0, 40)} | ${pos.outcome} | ${pos.size.toFixed(2)} sh @ $${pos.avgPrice.toFixed(3)} ` +
      `(~$${sizeUsd.toFixed(2)}) ← target ${s.target_wallet.slice(0, 10)}`,
    );

    if (apply) {
      // Insert an armed open position (mirrors insertOpenPosition) + flip the
      // attributing signal to acted_on, atomically on one connection.
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO live_positions
             (copy_target_id, market_id, event_id,
              condition_id, side, outcome, entry_price, size_usd, shares,
              status, opened_at, order_id, source_trade_key, metadata)
           VALUES (
             (SELECT id FROM copy_targets WHERE lower(proxy_wallet) = $1 LIMIT 1),
             (SELECT id FROM markets       WHERE condition_id = $2 LIMIT 1),
             (SELECT event_id FROM markets WHERE condition_id = $2 LIMIT 1),
             $2, 'BUY', $3, $4, $5, $6,
             'open', to_timestamp($7), $8, $9, $10::jsonb)`,
          [
            s.target_wallet,
            pos.conditionId,
            s.outcome || pos.outcome,
            pos.avgPrice,
            sizeUsd,
            pos.size,
            Math.floor(new Date(s.detected_at).getTime() / 1000),
            null,
            s.source_trade_key,
            JSON.stringify({
              position_key: positionKey,
              target_wallet: s.target_wallet,
              token_id: pos.asset,
              reconciled: true,
            }),
          ],
        );
        await client.query(
          `UPDATE copy_signals SET acted_on = true, skip_reason = NULL WHERE id = $1`,
          [s.id],
        );
        await client.query('COMMIT');
        imported++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    ! failed to import ${pos.conditionId.slice(0, 16)}: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    } else {
      imported++; // dry-run count of would-imports
    }
  }

  console.log('');
  console.log(`  ${apply ? 'Imported' : 'Would import'}: ${imported}`);
  console.log(`  Already tracked:    ${alreadyTracked}`);
  console.log(`  Unattributed (skip):${unattributed}`);
  if (!apply) console.log('\nDry run only — re-run with --apply to write, then restart simple-copy-trader.');
  else console.log('\nDone. Restart simple-copy-trader so it loads the imported positions into state.');

  log.info({ funder, onchain: positions.length, imported, alreadyTracked, unattributed, apply }, 'Reconcile complete');
  await shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
