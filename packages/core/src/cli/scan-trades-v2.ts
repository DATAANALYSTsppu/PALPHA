/**
 * scan-trades-v2 — trade ingestion via Polymarket Data API.
 *
 * For each market in our DB (filtered by category + time window from scan-events-v2),
 * pulls every trade from the public Data API (/trades?market=conditionId).
 * Each trade becomes one row in the trades table.
 *
 * The Data API provides: wallet, side, price, size, timestamp, outcome,
 * pseudonym/name, transactionHash, and a `type` field (TRADE, CONVERT,
 * REDEEM, MERGE, SPLIT). All types are stored — no separate convert pass needed.
 *
 * Incremental by default: each market resumes from the max timestamp we
 * stored in its ingest_checkpoints row. Daily cron runs only pull new trades.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/scan-trades-v2.ts [--limit=N] [--full-rescan]
 *
 *   --full-rescan       ignore cursors and re-scan every market from offset 0
 */

import { loadAllCategories } from '../registry.js';
import { fetchAllTradePages } from '../api/data.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:scan-trades-v2');

interface MarketRow {
  id: number;
  event_id: number;
  condition_id: string;
  outcome_yes_token: string | null;
  outcome_no_token: string | null;
}

/**
 * In-memory cache for the duration of a scan. Keeps upsertTrader from doing
 * an INSERT roundtrip per participant on every fill — the dominant cost for
 * large backfills where a single whale shows up thousands of times.
 *
 * Cache is keyed on lowercase wallet and only stores rows where we've confirmed
 * the trader_id. Alias updates are not cached (we still fire them for freshness).
 */
const traderIdCache = new Map<string, number>();

async function upsertTrader(wallet: string, pseudonym: string | null, displayName: string | null, seenAt: Date): Promise<number | null> {
  if (!wallet) return null;
  const wl = wallet.toLowerCase();

  // Fast path — already seen this wallet this run (zero DB queries)
  const cached = traderIdCache.get(wl);
  if (cached !== undefined) return cached;

  const res = await query(
    `INSERT INTO traders (proxy_wallet, pseudonym, display_name, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (proxy_wallet) DO UPDATE SET
       pseudonym = COALESCE(EXCLUDED.pseudonym, traders.pseudonym),
       display_name = COALESCE(EXCLUDED.display_name, traders.display_name),
       last_seen_at = GREATEST(traders.last_seen_at, EXCLUDED.last_seen_at),
       updated_at = NOW()
     RETURNING id`,
    [wl, pseudonym, displayName, seenAt]
  );

  const id = res.rows[0]?.id ?? null;
  if (id !== null) traderIdCache.set(wl, id);
  return id;
}

function computeTradeKey(txHash: string | null, wallet: string, asset: string, ts: number, price: number): string {
  return `dataapi:${txHash || 'none'}:${wallet.toLowerCase()}:${asset}:${ts}:${price}`;
}

interface ParsedTrade {
  wallet: string;
  ts: number;
  price: number;
  size: number;
  asset: string;
  txHash: string | null;
  type: string;
  side: string;
  outcome: string;
  pseudonym: string | null;
  displayName: string | null;
  tradeDate: Date;
  traderId: number | null;
  tradeKey: string;
  raw: string;
}

function parseTrade(t: Record<string, unknown>): Omit<ParsedTrade, 'traderId'> | null {
  const wallet = String(t.proxyWallet || '').toLowerCase();
  if (!wallet) return null;
  const ts = parseInt(String(t.timestamp || 0));
  const price = parseFloat(String(t.price || 0));
  const size = parseFloat(String(t.size || 0));
  const asset = String(t.asset || '');
  const txHash = (t.transactionHash as string) || null;
  return {
    wallet, ts, price, size, asset, txHash,
    type: String(t.type || 'TRADE'),
    side: String(t.side || 'BUY'),
    outcome: String(t.outcome || 'Yes'),
    pseudonym: (t.pseudonym as string) || null,
    displayName: (t.name as string) || null,
    tradeDate: ts > 0 ? new Date(ts * 1000) : new Date(),
    tradeKey: computeTradeKey(txHash, wallet, asset, ts, price),
    raw: JSON.stringify(t),
  };
}

/**
 * Batch-insert parsed trades using multi-row VALUES.
 * Processes BATCH_SIZE rows at a time to stay within PG param limits.
 */
const COLS_PER_ROW = 18;
const MAX_PG_PARAMS = 65535;
const BATCH_SIZE = Math.floor(MAX_PG_PARAMS / COLS_PER_ROW); // ~3640

async function insertTradeBatch(
  trades: (ParsedTrade & { traderId: number | null })[],
  market: MarketRow,
): Promise<number> {
  if (trades.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const off = i * COLS_PER_ROW;
    placeholders.push(
      `($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11},$${off+12},$${off+13},$${off+14},$${off+15},$${off+16},$${off+17},$${off+18})`
    );
    values.push(
      t.traderId, market.event_id, market.id, t.wallet,
      t.side, t.outcome, t.price, t.size, t.ts, t.tradeDate,
      t.tradeKey, t.txHash, t.asset,
      t.type, 'data-api', t.pseudonym, t.displayName, t.raw,
    );
  }

  const res = await query(
    `INSERT INTO trades (
       trader_id, event_id, market_id, proxy_wallet,
       side, outcome, price, size, timestamp, trade_date,
       trade_key, transaction_hash, asset_token_id,
       trade_type, source, pseudonym, display_name, raw_payload
     ) VALUES ${placeholders.join(',')}
     ON CONFLICT (trade_key) DO NOTHING`,
    values
  );
  return res.rowCount ?? trades.length;
}

/**
 * Scan all trades for a single market using the Data API.
 * If afterTs is provided, only trades newer than that timestamp are fetched.
 */
async function scanMarket(
  market: MarketRow,
  afterTs: number | null,
): Promise<{ fills: number; rows: number; maxTimestamp: number; complete: boolean }> {
  let fills = 0;
  let rows = 0;
  let maxTimestamp = 0;

  const filters: Record<string, string | number | boolean> = { market: market.condition_id };

  try {
    const { batches, complete } = await fetchAllTradePages(filters);

    for (let page = 0; page < batches.length; page++) {
      const batch = batches[page];
      let skipped = 0;

      // Phase 1: parse trades and resolve trader IDs (cache helps after first page)
      const parsed: (ParsedTrade & { traderId: number | null })[] = [];
      for (const trade of batch) {
        const p = parseTrade(trade);
        if (!p) continue;
        if (afterTs !== null && p.ts <= afterTs) { skipped++; continue; }

        const traderId = await upsertTrader(p.wallet, p.pseudonym, p.displayName, p.tradeDate);
        parsed.push({ ...p, traderId });
        fills++;
        if (p.ts > maxTimestamp) maxTimestamp = p.ts;
      }

      // Phase 2: batch-insert all trades for this page in one query
      rows += await insertTradeBatch(parsed, market);

      log.info({
        conditionId: market.condition_id.slice(0, 16),
        page: page + 1, batchSize: batch.length, fills, rows, skipped, newThisPage: parsed.length,
      }, 'Page processed');
    }

    return { fills, rows, maxTimestamp, complete };
  } catch (err) {
    log.error({ conditionId: market.condition_id, err: (err as Error).message }, 'Trade fetch failed');
    throw err;
  }
}

/**
 * Read the last successfully-processed timestamp for this market from the
 * ingest checkpoint. Returns null if no prior idle checkpoint exists.
 * We only advance from `idle` status — a stale `running`/`error` row should
 * cause us to re-scan from an earlier point to avoid missing trades.
 */
async function getTradeCursor(conditionId: string): Promise<number | null> {
  const source = `trades-v2:${conditionId}`;
  const res = await query(
    `SELECT cursor_value FROM ingest_checkpoints WHERE source = $1 AND status IN ('idle', 'capped')`,
    [source],
  );
  const raw = res.rows[0]?.cursor_value;
  if (!raw) return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function upsertCheckpoint(source: string, cursor: string, records: number, status: string, error?: string) {
  await query(
    `INSERT INTO ingest_checkpoints (source, cursor_value, records_ingested, last_run_at, last_error, status, updated_at)
     VALUES ($1, $2, $3, NOW(), $4, $5, NOW())
     ON CONFLICT (source) DO UPDATE SET
       cursor_value = EXCLUDED.cursor_value,
       records_ingested = EXCLUDED.records_ingested,
       last_run_at = NOW(),
       last_error = EXCLUDED.last_error,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [source, cursor, records, error || null, status]
  );
}

async function main() {
  await loadAllCategories();

  const limitArg = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');
  const fullRescan = process.argv.includes('--full-rescan');
  // Comma-separated list of event.category values to include. Defaults to the
  // categories we actively track. Override with --category=sports or similar.
  const categoriesArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1]
    || process.env.SCAN_V2_CATEGORIES
    || 'sports,weather';
  const categories = categoriesArg.split(',').map(s => s.trim()).filter(Boolean);

  // Incremental by default: each market resumes from its checkpoint's
  // last timestamp. --full-rescan ignores the cursor and re-scans everything.
  const catPlaceholders = categories.map((_, i) => `$${i + 1}`).join(',');
  const whereClause = `WHERE e.category IN (${catPlaceholders}) AND m.condition_id IS NOT NULL`;
  const limitClause = limitArg > 0 ? ` LIMIT ${limitArg}` : '';

  const marketsRes = await query(
    `SELECT m.id, m.event_id, m.condition_id, m.outcome_yes_token, m.outcome_no_token
     FROM markets m JOIN events e ON m.event_id = e.id
     ${whereClause}
     ORDER BY m.id${limitClause}`,
    categories
  );

  const markets: MarketRow[] = marketsRes.rows;
  console.log(`\n=== Polymarket Trade Scan (v2) ===`);
  console.log(`  Categories:       ${categories.join(', ')}`);
  console.log(`  Markets to scan:  ${markets.length}`);
  console.log(`  Mode:             ${fullRescan ? 'full rescan (ignoring cursors)' : 'incremental (resume from cursor)'}`);
  console.log(`  Source:           Data API (data-api.polymarket.com)`);
  console.log('');

  let totalFills = 0, totalRows = 0;
  const discoveredWallets = new Set<string>();

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const source = `trades-v2:${m.condition_id}`;
    console.log(`\n[${i + 1}/${markets.length}] Scanning market ${m.id} (${m.condition_id.slice(0, 20)}...)`);

    // Resume from prior cursor unless caller forced a full rescan.
    // We subtract a 60-second overlap to guard against the edge case
    // where a trade with timestamp == cursor was not yet committed
    // when we stored the cursor. trade_key dedup handles dupes.
    const priorCursor = fullRescan ? null : await getTradeCursor(m.condition_id);
    const afterTs = priorCursor !== null ? Math.max(0, priorCursor - 60) : null;

    await upsertCheckpoint(source, String(priorCursor ?? 0), 0, 'running');

    try {
      const { fills, rows, maxTimestamp, complete } = await scanMarket(m, afterTs);
      totalFills += fills;
      totalRows += rows;

      // Track unique wallets seen in this market
      const walletsRes = await query(
        `SELECT DISTINCT proxy_wallet FROM trades WHERE market_id = $1`,
        [m.id]
      );
      for (const r of walletsRes.rows) discoveredWallets.add(r.proxy_wallet);

      // Always advance cursor to newest timestamp seen. The API returns
      // newest-first, so incremental runs will pick up only new trades.
      // For capped markets (>4000 trades), we accept losing the oldest
      // history — the API hard-caps at offset 3000 with no workaround.
      const newCursor = Math.max(priorCursor ?? 0, maxTimestamp);
      await upsertCheckpoint(source, String(newCursor), rows, complete ? 'idle' : 'capped');

      if ((i + 1) % 10 === 0 || fills > 0 || !complete) {
        log.info({
          progress: `${i + 1}/${markets.length}`,
          conditionId: m.condition_id,
          fills, rows, totalFills, totalRows,
          cursor: newCursor,
          complete,
          incremental: afterTs !== null,
        }, complete ? 'Market scanned' : 'Market scanned (capped at 4000)');
      }
    } catch (err) {
      // On failure, leave prior cursor untouched so next run retries the
      // same window. Mark status = error for visibility.
      await upsertCheckpoint(source, String(priorCursor ?? 0), 0, 'error', (err as Error).message);
      log.error({ conditionId: m.condition_id, err: (err as Error).message }, 'Market scan failed');
    }
  }

  console.log(`\n=== Trade Scan Results ===`);
  console.log(`  Markets scanned:   ${markets.length}`);
  console.log(`  Trades found:      ${totalFills}`);
  console.log(`  Trade rows:        ${totalRows}`);
  console.log(`  Wallets found:     ${discoveredWallets.size}`);

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
