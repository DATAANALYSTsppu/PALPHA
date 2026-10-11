/**
 * ingest-wallet-trades — wallet-first trade ingestion, for backtesting a
 * specific wallet's own history.
 *
 * Why this exists:
 *   scan-trades-v2 is MARKET-first — it only pulls trades for markets already
 *   in our DB (the scanned sports/weather set). A tracked wallet's trades in
 *   any other market therefore never land in `trades`. That's why a freshly
 *   added copy target shows only stale, partial history and can't be
 *   backtested properly.
 *
 *   This pulls a SPECIFIC wallet's own recent trades from the Data API
 *   (/trades?user=<wallet>) and ingests them, creating the event/market rows
 *   on-demand from CLOB (including resolution) for any market we don't already
 *   have. The trade row format / trade_key match scan-trades-v2 exactly, so
 *   re-runs dedup against existing rows via ON CONFLICT (trade_key) DO NOTHING.
 *
 * Data API limits (see api/data.ts): max 1000/request, offset capped at 3000,
 * and before/after params are ignored — so we get the ~4000 MOST RECENT fills
 * per wallet, not deep history. That's exactly the "latest data" we want.
 *
 * Dry run by default: reports what it would fetch/create. --apply to write.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/ingest-wallet-trades.ts 0xabc... 0xdef...
 *   npx tsx packages/core/src/cli/ingest-wallet-trades.ts --targets            # all active copy_targets
 *   npx tsx packages/core/src/cli/ingest-wallet-trades.ts 0xabc... --apply
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';
import { fetchAllTradePages } from '../api/data.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:ingest-wallet-trades');

const CLOB = config.api.clobUrl || 'https://clob.polymarket.com';

const COLS_PER_ROW = 18;
const MAX_PG_PARAMS = 60000;
const BATCH_SIZE = Math.floor(MAX_PG_PARAMS / COLS_PER_ROW); // ~3333

/** Same key format as scan-trades-v2 so ingests dedup against each other. */
function computeTradeKey(txHash: string | null, wallet: string, asset: string, ts: number, price: number): string {
  return `dataapi:${txHash || 'none'}:${wallet.toLowerCase()}:${asset}:${ts}:${price}`;
}

interface ParsedTrade {
  wallet: string;
  ts: number;
  price: number;
  size: number;
  asset: string;
  conditionId: string;
  txHash: string | null;
  type: string;
  side: string;
  outcome: string;
  pseudonym: string | null;
  displayName: string | null;
  tradeDate: Date;
  tradeKey: string;
  raw: string;
}

function parseTrade(t: Record<string, unknown>): ParsedTrade | null {
  const wallet = String(t.proxyWallet || '').toLowerCase();
  const conditionId = String(t.conditionId || '');
  if (!wallet || !conditionId) return null;
  const ts = parseInt(String(t.timestamp || 0));
  const price = parseFloat(String(t.price || 0));
  const size = parseFloat(String(t.size || 0));
  const asset = String(t.asset || '');
  const txHash = (t.transactionHash as string) || null;
  return {
    wallet, ts, price, size, asset, conditionId, txHash,
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

/** Upsert a trader and return its id. */
async function upsertTrader(wallet: string, pseudonym: string | null, displayName: string | null): Promise<number | null> {
  if (!wallet) return null;
  const now = new Date();
  const res = await query(
    `INSERT INTO traders (proxy_wallet, pseudonym, display_name, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (proxy_wallet) DO UPDATE SET
       pseudonym    = COALESCE(EXCLUDED.pseudonym, traders.pseudonym),
       display_name = COALESCE(EXCLUDED.display_name, traders.display_name),
       last_seen_at = GREATEST(traders.last_seen_at, EXCLUDED.last_seen_at)
     RETURNING id`,
    [wallet.toLowerCase(), pseudonym, displayName, now],
  );
  return res.rows[0]?.id ?? null;
}

interface MarketIds { marketId: number; eventId: number | null; resolved: boolean; created: boolean; }

const marketCache = new Map<string, MarketIds | null>();

/**
 * Ensure event+market rows exist for a conditionId. Returns their ids, or null
 * if the market is unknown to CLOB. Modeled on simple-copy-trader's on-demand
 * ingestion: a CLOB market lookup yields category (first tag) and resolution
 * (winning token outcome), and we synthesize a negative poly_event_id for the
 * event so it never collides with Gamma-scanned events.
 */
async function ensureMarket(conditionId: string, apply: boolean): Promise<MarketIds | null> {
  if (marketCache.has(conditionId)) return marketCache.get(conditionId)!;

  // 1. Already in our DB?
  const local = await query(
    `SELECT m.id, m.event_id, (m.resolved_to IS NOT NULL) AS resolved
       FROM markets m WHERE m.condition_id = $1 LIMIT 1`,
    [conditionId],
  );
  if (local.rows[0]) {
    const out: MarketIds = { marketId: local.rows[0].id, eventId: local.rows[0].event_id, resolved: local.rows[0].resolved, created: false };
    marketCache.set(conditionId, out);
    return out;
  }

  // 2. Fetch from CLOB.
  let m: {
    question?: string; market_slug?: string; tags?: string[]; closed?: boolean; neg_risk?: boolean;
    end_date_iso?: string; game_start_time?: string;
    tokens?: { token_id: string; outcome: string; winner: boolean }[];
  };
  try {
    const res = await fetch(`${CLOB}/markets/${conditionId}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { marketCache.set(conditionId, null); return null; }
    m = await res.json();
  } catch {
    marketCache.set(conditionId, null);
    return null;
  }

  const category = (m.tags?.[0] ?? '').toLowerCase() || 'uncategorized';
  if (!m.question) { marketCache.set(conditionId, null); return null; }
  const winnerOutcome = m.tokens?.find((t) => t.winner)?.outcome ?? null;

  if (!apply) {
    // Dry run — don't write; report as a would-create with id -1.
    const out: MarketIds = { marketId: -1, eventId: null, resolved: !!winnerOutcome, created: true };
    marketCache.set(conditionId, out);
    return out;
  }

  // Synthetic negative event id, decreasing, never collides with Gamma ids.
  const evIdRes = await query(
    `SELECT COALESCE(MIN(poly_event_id), 0) - 1 AS next_id FROM events WHERE poly_event_id < 0`,
  );
  const polyEventId = evIdRes.rows[0]?.next_id ?? -1;
  const evRes = await query(
    `INSERT INTO events (poly_event_id, title, slug, category, subcategory, end_date, tags, is_resolved)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
     RETURNING id`,
    [polyEventId, m.question.slice(0, 500), m.market_slug ?? null, category,
     m.tags?.[1]?.toLowerCase() ?? null, m.end_date_iso ?? null, m.tags ?? [], !!m.closed],
  );
  const eventId = evRes.rows[0]?.id ?? null;

  const mkRes = await query(
    `INSERT INTO markets
       (event_id, condition_id, question, slug, is_closed, resolved_to,
        outcome_yes_token, outcome_no_token, neg_risk, end_date, start_date, fetched_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, NOW(), NOW())
     ON CONFLICT (condition_id) DO UPDATE SET
       event_id   = COALESCE(markets.event_id, EXCLUDED.event_id),
       resolved_to= COALESCE(markets.resolved_to, EXCLUDED.resolved_to),
       question   = EXCLUDED.question,
       fetched_at = NOW()
     RETURNING id, event_id`,
    [eventId, conditionId, m.question, m.market_slug ?? null, !!m.closed, winnerOutcome,
     m.tokens?.[0]?.token_id ?? null, m.tokens?.[1]?.token_id ?? null, !!m.neg_risk,
     m.end_date_iso ?? null, m.game_start_time ?? null],
  );
  const out: MarketIds = { marketId: mkRes.rows[0].id, eventId: mkRes.rows[0].event_id, resolved: !!winnerOutcome, created: true };
  marketCache.set(conditionId, out);
  return out;
}

async function insertTradeBatch(rows: (ParsedTrade & { traderId: number | null; marketId: number; eventId: number | null })[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const off = i * COLS_PER_ROW;
    placeholders.push(
      `($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11},$${off+12},$${off+13},$${off+14},$${off+15},$${off+16},$${off+17},$${off+18})`,
    );
    values.push(
      t.traderId, t.eventId, t.marketId, t.wallet,
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
     ON CONFLICT (trade_key, trade_date) DO NOTHING`,
    values,
  );
  return res.rowCount ?? 0;
}

async function ingestWallet(wallet: string, apply: boolean): Promise<void> {
  const wl = wallet.toLowerCase();
  console.log(`\n=== ${wl} ===`);

  // Fetch all available pages (~4000 most recent fills).
  const { batches, complete } = await fetchAllTradePages({ user: wl });
  const raw = batches.flat();
  console.log(`  Fetched ${raw.length} fills from Data API${complete ? '' : ' (hit 4000-fill cap — older history truncated)'}`);
  if (raw.length === 0) return;

  const parsed = raw.map(parseTrade).filter((t): t is ParsedTrade => t !== null);

  // One trader row per wallet (use first fill's identity fields).
  const traderId = await upsertTrader(wl, parsed[0]?.pseudonym ?? null, parsed[0]?.displayName ?? null);
  if (traderId === null) { console.log('  Could not upsert trader — skipping'); return; }

  // Resolve each distinct market once.
  const byCondition = new Map<string, ParsedTrade[]>();
  for (const t of parsed) {
    if (!byCondition.has(t.conditionId)) byCondition.set(t.conditionId, []);
    byCondition.get(t.conditionId)!.push(t);
  }
  console.log(`  ${parsed.length} parsed fills across ${byCondition.size} markets`);

  let createdMarkets = 0, existingMarkets = 0, unknownMarkets = 0, resolvedMarkets = 0;
  let skippedFills = 0;
  const insertRows: (ParsedTrade & { traderId: number | null; marketId: number; eventId: number | null })[] = [];

  for (const [conditionId, trades] of byCondition) {
    const ids = await ensureMarket(conditionId, apply);
    if (!ids) { unknownMarkets++; skippedFills += trades.length; continue; }
    if (ids.created) createdMarkets++; else existingMarkets++;
    if (ids.resolved) resolvedMarkets++;
    if (apply) {
      for (const t of trades) insertRows.push({ ...t, traderId, marketId: ids.marketId, eventId: ids.eventId });
    }
  }

  let inserted = 0;
  if (apply) {
    for (let i = 0; i < insertRows.length; i += BATCH_SIZE) {
      inserted += await insertTradeBatch(insertRows.slice(i, i + BATCH_SIZE));
    }
  }

  console.log(`  Markets: ${existingMarkets} existing, ${createdMarkets} ${apply ? 'created' : 'to create'}, ${unknownMarkets} unknown-to-CLOB (skipped)`);
  console.log(`  Resolved markets (backtestable win/loss): ${resolvedMarkets}/${byCondition.size}`);
  if (apply) {
    console.log(`  Trades inserted (new): ${inserted}  |  already present: ${insertRows.length - inserted}  |  fills skipped (no market): ${skippedFills}`);
  } else {
    console.log(`  (dry run) Would ingest ${parsed.length - skippedFills} fills; ${skippedFills} skipped (no market). Re-run with --apply to write.`);
  }
  log.info({ wallet: wl, fills: parsed.length, markets: byCondition.size, createdMarkets, resolvedMarkets, inserted, apply }, 'Wallet ingest complete');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const useTargets = process.argv.includes('--targets');
  let wallets = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((w) => w.toLowerCase());

  if (useTargets) {
    const res = await query(`SELECT DISTINCT lower(proxy_wallet) AS w FROM copy_targets WHERE status = 'active'`);
    wallets = Array.from(new Set([...wallets, ...res.rows.map((r) => r.w)]));
  }

  if (wallets.length === 0) {
    console.error('No wallets given. Pass 0x… addresses and/or --targets.');
    await shutdown();
    process.exit(1);
  }

  console.log('=== Wallet-first trade ingestion ===');
  console.log(`  Mode:    ${apply ? 'APPLY (writes to DB)' : 'DRY RUN (read-only)'}`);
  console.log(`  Wallets: ${wallets.length}`);

  for (const w of wallets) {
    try {
      await ingestWallet(w, apply);
    } catch (err) {
      console.error(`  ERROR ingesting ${w}: ${(err as Error).message}`);
    }
  }

  console.log('\n=== Done ===');
  if (!apply) console.log('Dry run only — re-run with --apply to write, then run the backtest.');
  await shutdown();
}

main().catch((err) => { console.error(err); process.exit(1); });
