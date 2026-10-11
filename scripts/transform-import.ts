/**
 * Transform and import data from OpenClaw's weather + sports DBs
 * into the unified Polymarket-Bot schema using BULK multi-row inserts.
 *
 * Usage: npx tsx scripts/transform-import.ts [--weather-only] [--sports-only] [--skip-trades]
 */

import pg from 'pg';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnv({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

const weatherPool = new Pool({
  connectionString: 'postgresql://polyweather:polyweather_dev@localhost:15433/polyweather',
  max: 5,
});

const sportsPool = new Pool({
  connectionString: 'postgresql://polysports:polysports_dev@localhost:15434/polysports',
  max: 5,
});

const targetUrl = process.env.DATABASE_URL || 'postgresql://polymarket:polymarket_dev@localhost:5432/polymarket';
const ssl = targetUrl.includes('localhost') || targetUrl.includes('127.0.0.1')
  ? false
  : { rejectUnauthorized: false };

const targetPool = new Pool({
  connectionString: targetUrl,
  max: 10,
  ssl,
});

const args = process.argv.slice(2);
const weatherOnly = args.includes('--weather-only');
const sportsOnly = args.includes('--sports-only');
const skipTrades = args.includes('--skip-trades');

function log(msg: string) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
}

// ─── Bulk Insert Helper ─────────────────────────────────────────────
// Builds: INSERT INTO t (c1,c2) VALUES ($1,$2),($3,$4)... ON CONFLICT ...

function buildBulkSQL(
  table: string,
  columns: string[],
  rowCount: number,
  colCount: number,
  onConflict: string,
): string {
  const valueClauses: string[] = [];
  let idx = 1;
  for (let r = 0; r < rowCount; r++) {
    const placeholders = [];
    for (let c = 0; c < colCount; c++) {
      placeholders.push(`$${idx++}`);
    }
    valueClauses.push(`(${placeholders.join(',')})`);
  }
  return `INSERT INTO ${table} (${columns.join(',')}) VALUES ${valueClauses.join(',')} ${onConflict}`;
}

async function bulkInsertChunked(
  table: string,
  columns: string[],
  rows: unknown[][],
  onConflict: string,
  label: string,
  chunkSize = 500,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const sql = buildBulkSQL(table, columns, chunk.length, columns.length, onConflict);
    const params = chunk.flat();
    try {
      await targetPool.query(sql, params);
      total += chunk.length;
    } catch (err) {
      console.error(`  Error in ${label} at row ${i}:`, (err as Error).message);
      // Try one-by-one for this chunk to skip bad rows
      for (const row of chunk) {
        try {
          const singleSql = buildBulkSQL(table, columns, 1, columns.length, onConflict);
          await targetPool.query(singleSql, row);
          total++;
        } catch { /* skip */ }
      }
    }
    if ((i + chunkSize) % 10000 < chunkSize || i + chunkSize >= rows.length) {
      log(`  ${label}: ${total.toLocaleString()}/${rows.length.toLocaleString()}`);
    }
  }
  return total;
}

// ─── ID Map Builder ─────────────────────────────────────────────────
// After bulk insert, fetch id mapping via the unique key

async function fetchEventIdMap(): Promise<Map<number, number>> {
  const res = await targetPool.query(`SELECT id, poly_event_id FROM events`);
  const map = new Map<number, number>();
  for (const r of res.rows) {
    map.set(r.poly_event_id, r.id);
  }
  return map;
}

async function fetchMarketIdMap(): Promise<Map<string, number>> {
  const res = await targetPool.query(`SELECT id, condition_id FROM markets`);
  const map = new Map<string, number>();
  for (const r of res.rows) {
    map.set(r.condition_id, r.id);
  }
  return map;
}

async function fetchTraderIdMap(): Promise<Map<string, number>> {
  const res = await targetPool.query(`SELECT id, proxy_wallet FROM traders`);
  const map = new Map<string, number>();
  for (const r of res.rows) {
    map.set(r.proxy_wallet, r.id);
  }
  return map;
}

// ─── Trades Bulk Import (streaming from source) ─────────────────────

async function bulkInsertTrades(
  sourcePool: pg.Pool,
  traderWalletMap: Map<string, number>,  // wallet -> new trader id
  eventPolyIdMap: Map<number, number>,   // poly_event_id -> new event id
  marketCondMap: Map<string, number>,    // condition_id -> new market id
  sourceEventTable: string,              // 'weather_events' or 'sports_events'
  sourceMarketTable: string,             // 'weather_markets' or 'sports_markets'
  label: string,
): Promise<number> {
  // Build source-side lookup maps: old event_id -> poly_event_id, old market_id -> condition_id
  const srcEventsRes = await sourcePool.query(`SELECT id, poly_event_id FROM ${sourceEventTable}`);
  const srcEventPolyId = new Map<number, number>();
  for (const r of srcEventsRes.rows) srcEventPolyId.set(r.id, r.poly_event_id);

  const srcMarketsRes = await sourcePool.query(`SELECT id, condition_id FROM ${sourceMarketTable}`);
  const srcMarketCond = new Map<number, string>();
  for (const r of srcMarketsRes.rows) srcMarketCond.set(r.id, r.condition_id);

  const READ_BATCH = 50000;
  const WRITE_BATCH = 500;
  const columns = ['trader_id', 'event_id', 'market_id', 'proxy_wallet', 'side', 'outcome', 'price', 'size', 'timestamp', 'trade_date'];
  let offset = 0;
  let totalImported = 0;

  while (true) {
    const tradesRes = await sourcePool.query(
      `SELECT trader_id, event_id, market_id, proxy_wallet, side, outcome, price, size, timestamp, trade_date
       FROM trades ORDER BY id LIMIT $1 OFFSET $2`,
      [READ_BATCH, offset]
    );

    if (tradesRes.rows.length === 0) break;

    // Map rows
    const mapped: unknown[][] = [];
    for (const t of tradesRes.rows) {
      const newTraderId = traderWalletMap.get(t.proxy_wallet);
      if (!newTraderId) continue;

      const polyEventId = t.event_id ? srcEventPolyId.get(t.event_id) : null;
      const newEventId = polyEventId ? (eventPolyIdMap.get(polyEventId) || null) : null;

      const conditionId = t.market_id ? srcMarketCond.get(t.market_id) : null;
      const newMarketId = conditionId ? (marketCondMap.get(conditionId) || null) : null;

      mapped.push([
        newTraderId, newEventId, newMarketId,
        t.proxy_wallet, t.side, t.outcome, t.price, t.size, t.timestamp, t.trade_date,
      ]);
    }

    // Write in chunks
    for (let i = 0; i < mapped.length; i += WRITE_BATCH) {
      const chunk = mapped.slice(i, i + WRITE_BATCH);
      const sql = buildBulkSQL('trades', columns, chunk.length, columns.length, 'ON CONFLICT DO NOTHING');
      try {
        await targetPool.query(sql, chunk.flat());
      } catch (err) {
        console.error(`  Error in ${label} write:`, (err as Error).message);
      }
    }

    totalImported += mapped.length;
    offset += READ_BATCH;
    log(`  ${label}: ${totalImported.toLocaleString()} imported`);
  }

  return totalImported;
}

// ─── Weather Import ─────────────────────────────────────────────────

async function importWeather() {
  log('=== Importing Weather Data ===');

  // 1. Events — bulk insert
  log('Importing weather events...');
  const eventsRes = await weatherPool.query(
    `SELECT poly_event_id, title, slug, description, category, city,
            end_date, tags, is_resolved, resolved_outcome, created_at, updated_at
     FROM weather_events ORDER BY id`
  );

  const eventRows = eventsRes.rows.map((e: any) => [
    e.poly_event_id, e.title, e.slug, e.description,
    'weather', e.category || 'other_weather', e.city,
    e.end_date, e.tags, e.is_resolved || false, e.resolved_outcome,
    e.created_at, e.updated_at,
  ]);

  await bulkInsertChunked(
    'events',
    ['poly_event_id', 'title', 'slug', 'description', 'category', 'subcategory', 'subcategory_detail', 'end_date', 'tags', 'is_resolved', 'resolved_outcome', 'created_at', 'updated_at'],
    eventRows,
    'ON CONFLICT (poly_event_id) DO UPDATE SET updated_at = NOW()',
    'Weather events',
  );

  // 2. Markets — bulk insert
  log('Importing weather markets...');
  // Fetch event id map from target
  const eventPolyIdMap = await fetchEventIdMap();

  const marketsRes = await weatherPool.query(
    `SELECT wm.event_id, we.poly_event_id, wm.condition_id, wm.question, wm.slug,
            wm.outcome_yes_token, wm.outcome_no_token, wm.is_closed, wm.resolved_to, wm.end_date, wm.created_at
     FROM weather_markets wm
     JOIN weather_events we ON we.id = wm.event_id
     ORDER BY wm.id`
  );

  const marketRows = marketsRes.rows
    .filter((m: any) => eventPolyIdMap.has(m.poly_event_id))
    .map((m: any) => [
      eventPolyIdMap.get(m.poly_event_id), m.condition_id, m.question, m.slug,
      m.outcome_yes_token, m.outcome_no_token,
      m.is_closed || false, m.resolved_to, m.end_date, m.created_at,
    ]);

  await bulkInsertChunked(
    'markets',
    ['event_id', 'condition_id', 'question', 'slug', 'outcome_yes_token', 'outcome_no_token', 'is_closed', 'resolved_to', 'end_date', 'created_at'],
    marketRows,
    'ON CONFLICT (condition_id) DO UPDATE SET resolved_to = COALESCE(EXCLUDED.resolved_to, markets.resolved_to), is_closed = EXCLUDED.is_closed',
    'Weather markets',
  );

  // 3. Traders — bulk insert
  log('Importing weather traders...');
  const tradersRes = await weatherPool.query(
    `SELECT proxy_wallet, display_name, pseudonym, first_seen_at, last_seen_at,
            total_weather_trades, total_weather_markets,
            win_rate, roi, total_pnl, consistency_score, composite_score,
            profit_score, efficiency_score, precision_score, conviction_score, asymmetry_score,
            alpha_score, alpha_tags, score_updated_at, status, created_at, updated_at
     FROM traders ORDER BY id`
  );

  const traderRows = tradersRes.rows.map((t: any) => [
    t.proxy_wallet, t.display_name, t.pseudonym, t.first_seen_at, t.last_seen_at,
    t.total_weather_trades || 0, t.total_weather_markets || 0,
    t.win_rate, t.roi, t.total_pnl, t.consistency_score, t.composite_score,
    t.profit_score, t.efficiency_score, t.precision_score, t.conviction_score, t.asymmetry_score,
    t.alpha_score, t.alpha_tags, t.score_updated_at, t.status || 'active',
    t.created_at, t.updated_at,
  ]);

  await bulkInsertChunked(
    'traders',
    ['proxy_wallet', 'display_name', 'pseudonym', 'first_seen_at', 'last_seen_at',
     'total_trades', 'total_markets', 'win_rate', 'roi', 'total_pnl', 'consistency_score', 'composite_score',
     'profit_score', 'efficiency_score', 'precision_score', 'conviction_score', 'asymmetry_score',
     'alpha_score', 'alpha_tags', 'score_updated_at', 'status', 'created_at', 'updated_at'],
    traderRows,
    `ON CONFLICT (proxy_wallet) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, traders.display_name),
       last_seen_at = GREATEST(traders.last_seen_at, EXCLUDED.last_seen_at),
       total_trades = traders.total_trades + COALESCE(EXCLUDED.total_trades, 0),
       total_markets = traders.total_markets + COALESCE(EXCLUDED.total_markets, 0),
       updated_at = NOW()`,
    'Weather traders',
  );

  // 4. Trades
  if (!skipTrades) {
    log('Importing weather trades (1.8M rows)...');
    const traderWalletMap = await fetchTraderIdMap();
    const marketCondMap = await fetchMarketIdMap();
    const count = await bulkInsertTrades(
      weatherPool, traderWalletMap, eventPolyIdMap, marketCondMap,
      'weather_events', 'weather_markets', 'Weather trades'
    );
    log(`  Weather trades complete: ${count.toLocaleString()}`);
  }

  // 5. Scan progress
  log('Importing weather scan progress...');
  const eventPolyIdMapFresh = await fetchEventIdMap();
  const scanRes = await weatherPool.query(
    `SELECT we.poly_event_id, sp.trades_fetched, sp.traders_found, sp.scanned_at
     FROM scan_progress sp JOIN weather_events we ON we.id = sp.event_id`
  );
  const scanRows = scanRes.rows
    .filter((s: any) => eventPolyIdMapFresh.has(s.poly_event_id))
    .map((s: any) => [eventPolyIdMapFresh.get(s.poly_event_id), s.trades_fetched, s.traders_found, s.scanned_at]);

  if (scanRows.length > 0) {
    await bulkInsertChunked(
      'scan_progress', ['event_id', 'trades_fetched', 'traders_found', 'scanned_at'],
      scanRows, 'ON CONFLICT (event_id) DO NOTHING', 'Weather scan_progress',
    );
  }

  log('=== Weather Import Complete ===\n');
}

// ─── Sports Import ──────────────────────────────────────────────────

async function importSports() {
  log('=== Importing Sports Data ===');

  // 1. Events
  log('Importing sports events...');
  const eventsRes = await sportsPool.query(
    `SELECT poly_event_id, title, slug, description, sport, league,
            end_date, tags, is_resolved, resolved_outcome, created_at, updated_at
     FROM sports_events ORDER BY id`
  );

  const eventRows = eventsRes.rows.map((e: any) => [
    e.poly_event_id, e.title, e.slug, e.description,
    'sports', e.sport, e.league,
    e.end_date, e.tags, e.is_resolved || false, e.resolved_outcome,
    e.created_at, e.updated_at,
  ]);

  await bulkInsertChunked(
    'events',
    ['poly_event_id', 'title', 'slug', 'description', 'category', 'subcategory', 'subcategory_detail', 'end_date', 'tags', 'is_resolved', 'resolved_outcome', 'created_at', 'updated_at'],
    eventRows,
    'ON CONFLICT (poly_event_id) DO UPDATE SET updated_at = NOW()',
    'Sports events',
  );

  // 2. Markets
  log('Importing sports markets...');
  const eventPolyIdMap = await fetchEventIdMap();

  const marketsRes = await sportsPool.query(
    `SELECT sm.event_id, se.poly_event_id, sm.condition_id, sm.question, sm.slug,
            sm.outcome_yes_token, sm.outcome_no_token, sm.is_closed, sm.resolved_to, sm.end_date, sm.created_at
     FROM sports_markets sm
     JOIN sports_events se ON se.id = sm.event_id
     ORDER BY sm.id`
  );

  const marketRows = marketsRes.rows
    .filter((m: any) => eventPolyIdMap.has(m.poly_event_id))
    .map((m: any) => [
      eventPolyIdMap.get(m.poly_event_id), m.condition_id, m.question, m.slug,
      m.outcome_yes_token, m.outcome_no_token,
      m.is_closed || false, m.resolved_to, m.end_date, m.created_at,
    ]);

  await bulkInsertChunked(
    'markets',
    ['event_id', 'condition_id', 'question', 'slug', 'outcome_yes_token', 'outcome_no_token', 'is_closed', 'resolved_to', 'end_date', 'created_at'],
    marketRows,
    'ON CONFLICT (condition_id) DO UPDATE SET resolved_to = COALESCE(EXCLUDED.resolved_to, markets.resolved_to), is_closed = EXCLUDED.is_closed',
    'Sports markets',
  );

  // 3. Traders
  log('Importing sports traders...');
  const tradersRes = await sportsPool.query(
    `SELECT proxy_wallet, display_name, pseudonym, first_seen_at, last_seen_at,
            total_sports_trades, total_sports_markets,
            win_rate, roi, total_pnl, consistency_score, composite_score,
            profit_score, efficiency_score, precision_score, conviction_score, asymmetry_score,
            alpha_score, alpha_tags, score_updated_at, status, created_at, updated_at
     FROM traders ORDER BY id`
  );

  const traderRows = tradersRes.rows.map((t: any) => [
    t.proxy_wallet, t.display_name, t.pseudonym, t.first_seen_at, t.last_seen_at,
    t.total_sports_trades || 0, t.total_sports_markets || 0,
    t.win_rate, t.roi, t.total_pnl, t.consistency_score, t.composite_score,
    t.profit_score, t.efficiency_score, t.precision_score, t.conviction_score, t.asymmetry_score,
    t.alpha_score, t.alpha_tags, t.score_updated_at, t.status || 'active',
    t.created_at, t.updated_at,
  ]);

  await bulkInsertChunked(
    'traders',
    ['proxy_wallet', 'display_name', 'pseudonym', 'first_seen_at', 'last_seen_at',
     'total_trades', 'total_markets', 'win_rate', 'roi', 'total_pnl', 'consistency_score', 'composite_score',
     'profit_score', 'efficiency_score', 'precision_score', 'conviction_score', 'asymmetry_score',
     'alpha_score', 'alpha_tags', 'score_updated_at', 'status', 'created_at', 'updated_at'],
    traderRows,
    `ON CONFLICT (proxy_wallet) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, traders.display_name),
       last_seen_at = GREATEST(traders.last_seen_at, EXCLUDED.last_seen_at),
       total_trades = traders.total_trades + COALESCE(EXCLUDED.total_trades, 0),
       total_markets = traders.total_markets + COALESCE(EXCLUDED.total_markets, 0),
       updated_at = NOW()`,
    'Sports traders',
  );

  // 4. Trades
  if (!skipTrades) {
    log('Importing sports trades (17.3M rows)...');
    const traderWalletMap = await fetchTraderIdMap();
    const marketCondMap = await fetchMarketIdMap();
    const count = await bulkInsertTrades(
      sportsPool, traderWalletMap, eventPolyIdMap, marketCondMap,
      'sports_events', 'sports_markets', 'Sports trades'
    );
    log(`  Sports trades complete: ${count.toLocaleString()}`);
  }

  // 5. Scan progress
  log('Importing sports scan progress...');
  const eventPolyIdMapFresh = await fetchEventIdMap();
  const scanRes = await sportsPool.query(
    `SELECT se.poly_event_id, sp.trades_fetched, sp.traders_found, sp.scanned_at
     FROM scan_progress sp JOIN sports_events se ON se.id = sp.event_id`
  );
  const scanRows = scanRes.rows
    .filter((s: any) => eventPolyIdMapFresh.has(s.poly_event_id))
    .map((s: any) => [eventPolyIdMapFresh.get(s.poly_event_id), s.trades_fetched, s.traders_found, s.scanned_at]);

  if (scanRows.length > 0) {
    await bulkInsertChunked(
      'scan_progress', ['event_id', 'trades_fetched', 'traders_found', 'scanned_at'],
      scanRows, 'ON CONFLICT (event_id) DO NOTHING', 'Sports scan_progress',
    );
  }

  log('=== Sports Import Complete ===\n');
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  log('Starting data import into unified database (BULK mode v2)');
  log(`Target: ${targetUrl.replace(/:[^:@]+@/, ':****@')}`);
  log(`Flags: ${skipTrades ? 'SKIP TRADES' : 'full import'}\n`);

  try {
    if (!sportsOnly) await importWeather();
    if (!weatherOnly) await importSports();

    const counts = await targetPool.query(`
      SELECT
        (SELECT COUNT(*) FROM events) as events,
        (SELECT COUNT(*) FROM markets) as markets,
        (SELECT COUNT(*) FROM traders) as traders,
        (SELECT COUNT(*) FROM trades) as trades
    `);
    const c = counts.rows[0];
    log('=== Final Counts ===');
    log(`  Events:  ${parseInt(c.events).toLocaleString()}`);
    log(`  Markets: ${parseInt(c.markets).toLocaleString()}`);
    log(`  Traders: ${parseInt(c.traders).toLocaleString()}`);
    log(`  Trades:  ${parseInt(c.trades).toLocaleString()}`);
  } catch (err) {
    console.error('Import failed:', err);
  } finally {
    await weatherPool.end();
    await sportsPool.end();
    await targetPool.end();
  }
}

main();
