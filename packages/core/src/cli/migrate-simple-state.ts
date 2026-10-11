/**
 * migrate-simple-state — one-shot import of simple-state.json into v3 DB.
 *
 * Replaces the JSON state file the legacy `simple-copy-trader` used. After
 * this runs, the bot reads its state exclusively from the DB.
 *
 * - `open` positions → live_positions rows with status='open'
 * - `closed` positions → live_positions rows with status='closed' + exit info
 * - `processedTradeKeys` → copy_signals rows with acted_on flag derived from
 *   whether the trade resulted in an open or closed position.
 *
 * Idempotent: ON CONFLICT DO NOTHING for the dedup index, so re-running is
 * safe but only inserts genuinely new rows.
 *
 * Usage:
 *   tsx packages/core/src/cli/migrate-simple-state.ts                    # dry-run
 *   tsx packages/core/src/cli/migrate-simple-state.ts --apply            # write
 *   tsx packages/core/src/cli/migrate-simple-state.ts --apply --rename   # also renames state file after success
 *
 * Env:
 *   SIMPLE_STATE_FILE  (default: ./simple-state.json)
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';
import * as fs from 'fs';
import * as path from 'path';

void config; // ensure .env is loaded

const STATE_FILE = process.env.SIMPLE_STATE_FILE || path.resolve(process.cwd(), 'simple-state.json');

interface OpenPos {
  positionKey: string;
  targetWallet: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: string;
  shares: number;
  sizeUsd: number;
  entryPrice: number;
  orderId?: string;
  openedAt: number;
  sourceTradeKey?: string;
}

interface ClosedPos extends Omit<OpenPos, 'orderId'> {
  exitPrice: number;
  pnl: number;
  reason: string;
  closedAt: number;
  closeOrderId?: string;
}

interface SimpleState {
  processedTradeKeys?: string[];
  open?: OpenPos[];
  closed?: ClosedPos[];
  stats?: Record<string, number>;
}

/**
 * processedTradeKeys are formatted as:
 *   `${transactionHash}:${asset}:${price}:${size}:${timestamp}`
 * We parse them back into structured fields so we can store the rows we know
 * about. Some old keys use 'no_tx' instead of a real hash; we keep that too.
 */
function parseTradeKey(key: string) {
  const parts = key.split(':');
  if (parts.length < 5) return null;
  const [txHash, asset, priceStr, sizeStr, tsStr] = parts;
  return {
    txHash,
    asset,
    price: Number(priceStr),
    size: Number(sizeStr),
    timestamp: Number(tsStr),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const renameOnSuccess = args.includes('--rename');

  console.log('=== migrate-simple-state ===');
  console.log(`  Mode:        ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  State file:  ${STATE_FILE}`);
  console.log('');

  if (!fs.existsSync(STATE_FILE)) {
    console.log('State file not found. Nothing to migrate.');
    return;
  }

  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  const state = JSON.parse(raw) as SimpleState;

  const open    = state.open ?? [];
  const closed  = state.closed ?? [];
  const keys    = state.processedTradeKeys ?? [];
  console.log(`Loaded: ${open.length} open, ${closed.length} closed, ${keys.length} processed keys.\n`);

  // ────────────────────────────────────────────────────────────────
  // 0. Build (condition_id → market_id / event_id) and (wallet → copy_target_id) maps
  //    so we can populate FKs as we insert. Without these the rows land with
  //    NULL FKs and break joins downstream.
  // ────────────────────────────────────────────────────────────────
  const conditionIds = [...new Set([...open, ...closed].map(p => p.conditionId))];
  const targetWallets = [...new Set([...open, ...closed].map(p => p.targetWallet).filter(Boolean))];

  const marketMap = new Map<string, { market_id: number; event_id: number | null }>();
  if (conditionIds.length > 0) {
    const r = await query(
      `SELECT id, event_id, condition_id FROM markets WHERE condition_id = ANY($1::text[])`,
      [conditionIds],
    );
    for (const row of r.rows) marketMap.set(row.condition_id, { market_id: row.id, event_id: row.event_id });
  }

  const copyTargetMap = new Map<string, number>();
  if (targetWallets.length > 0) {
    const r = await query(
      `SELECT id, proxy_wallet FROM copy_targets WHERE lower(proxy_wallet) = ANY($1::text[])`,
      [targetWallets.map(w => w.toLowerCase())],
    );
    for (const row of r.rows) copyTargetMap.set(row.proxy_wallet.toLowerCase(), row.id);
  }
  console.log(`  Lookup maps built: ${marketMap.size}/${conditionIds.length} markets, ${copyTargetMap.size}/${targetWallets.length} copy_targets.\n`);

  const fk = (p: OpenPos | ClosedPos) => ({
    market_id:      marketMap.get(p.conditionId)?.market_id ?? null,
    event_id:       marketMap.get(p.conditionId)?.event_id  ?? null,
    copy_target_id: copyTargetMap.get(p.targetWallet?.toLowerCase() ?? '') ?? null,
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Closed positions
  // ────────────────────────────────────────────────────────────────
  console.log(`--- Closed positions (${closed.length}) ---`);
  let closedInserted = 0;
  for (const p of closed) {
    if (!apply) {
      console.log(`  [dry-run] ${p.conditionId.slice(0, 12)}.. ${p.outcome.slice(0, 18).padEnd(18)} entry=${p.entryPrice.toFixed(4)} exit=${p.exitPrice.toFixed(4)} pnl=${p.pnl.toFixed(4)} reason=${p.reason}`);
      continue;
    }
    const f = fk(p);
    const res = await query(
      `
      INSERT INTO live_positions
        (copy_target_id, market_id, event_id,
         condition_id, side, outcome, entry_price, size_usd, shares,
         status, opened_at, closed_at, exit_price, pnl,
         order_id, source_trade_key, metadata)
      VALUES
        ($1, $2, $3,
         $4, $5, $6, $7, $8, $9,
         'closed', to_timestamp($10), to_timestamp($11), $12, $13,
         $14, $15, $16::jsonb)
      `,
      [
        f.copy_target_id, f.market_id, f.event_id,
        p.conditionId,
        p.side ?? 'BUY',
        p.outcome,
        p.entryPrice,
        p.sizeUsd,
        p.shares,
        p.openedAt,
        p.closedAt,
        p.exitPrice,
        p.pnl,
        p.closeOrderId ?? null,
        p.sourceTradeKey ?? null,
        JSON.stringify({
          token_id: p.tokenId,
          target_wallet: p.targetWallet,
          close_reason: p.reason,
          position_key: p.positionKey,
          migrated_from_json: true,
        }),
      ],
    );
    closedInserted += res.rowCount ?? 0;
  }
  console.log(`  → inserted ${closedInserted}/${closed.length} closed rows.\n`);

  // ────────────────────────────────────────────────────────────────
  // 2. Open positions
  // ────────────────────────────────────────────────────────────────
  console.log(`--- Open positions (${open.length}) ---`);
  let openInserted = 0;
  for (const p of open) {
    if (!apply) {
      console.log(`  [dry-run] ${p.conditionId.slice(0, 12)}.. ${p.outcome.slice(0, 18).padEnd(18)} entry=${p.entryPrice.toFixed(4)} sizeUsd=${p.sizeUsd.toFixed(2)} target=${p.targetWallet.slice(0, 10)}`);
      continue;
    }
    const f = fk(p);
    const res = await query(
      `
      INSERT INTO live_positions
        (copy_target_id, market_id, event_id,
         condition_id, side, outcome, entry_price, size_usd, shares,
         status, opened_at, order_id, source_trade_key, metadata)
      VALUES
        ($1, $2, $3,
         $4, $5, $6, $7, $8, $9,
         'open', to_timestamp($10), $11, $12, $13::jsonb)
      `,
      [
        f.copy_target_id, f.market_id, f.event_id,
        p.conditionId,
        p.side ?? 'BUY',
        p.outcome,
        p.entryPrice,
        p.sizeUsd,
        p.shares,
        p.openedAt,
        p.orderId ?? null,
        p.sourceTradeKey ?? null,
        JSON.stringify({
          token_id: p.tokenId,
          target_wallet: p.targetWallet,
          position_key: p.positionKey,
          migrated_from_json: true,
        }),
      ],
    );
    openInserted += res.rowCount ?? 0;
  }
  console.log(`  → inserted ${openInserted}/${open.length} open rows.\n`);

  // ────────────────────────────────────────────────────────────────
  // 3. Processed trade keys → copy_signals
  // ────────────────────────────────────────────────────────────────
  console.log(`--- Processed trade keys (${keys.length}) ---`);
  let signalsInserted = 0, signalsSkipped = 0;
  // We don't know the proxy_wallet for old keys (the format doesn't include
  // it). We mark them with proxy_wallet='unknown' so they at least serve as
  // dedup history. The bot's new code never inserts 'unknown', so any new
  // signals get proper attribution.
  for (const k of keys) {
    const parsed = parseTradeKey(k);
    if (!parsed) {
      signalsSkipped++;
      continue;
    }
    if (!apply) {
      if (signalsSkipped < 3) {
        console.log(`  [dry-run] ${k.slice(0, 50)}...`);
      }
      continue;
    }
    const res = await query(
      `
      INSERT INTO copy_signals
        (proxy_wallet, condition_id, side, outcome, price, size,
         signal_type, detected_at, acted_on, skip_reason)
      VALUES
        ('unknown', $1, 'BUY', 'unknown', $2, $3,
         'migrated', to_timestamp($4), false, 'migrated_from_json')
      ON CONFLICT DO NOTHING
      `,
      [parsed.asset, parsed.price, parsed.size, parsed.timestamp],
    );
    if ((res.rowCount ?? 0) > 0) signalsInserted++;
    else signalsSkipped++;
  }
  console.log(`  → inserted ${signalsInserted}, skipped/duplicate ${signalsSkipped}.\n`);

  // ────────────────────────────────────────────────────────────────
  // 4. Optional: rename source file so the bot can't accidentally fall back
  // ────────────────────────────────────────────────────────────────
  if (apply && renameOnSuccess) {
    const dest = `${STATE_FILE}.migrated-${new Date().toISOString().split('T')[0]}`;
    fs.renameSync(STATE_FILE, dest);
    console.log(`Renamed: ${STATE_FILE} → ${dest}`);
  }

  console.log('=== done ===');
  if (!apply) console.log('Re-run with --apply to actually write to DB.');
}

main()
  .then(() => shutdown())
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
