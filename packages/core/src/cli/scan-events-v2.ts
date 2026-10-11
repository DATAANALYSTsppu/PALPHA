/**
 * scan-events-v2 — clean ingestion for events + markets.
 *
 * Changes from v1:
 *  - Tag-filtered at API level (tag_slug=sports) — fast, skips ~80% of irrelevant events
 *  - Time-bounded to last N months via end_date_min (default 6)
 *  - Captures every field Polymarket returns, including raw_payload JSONB
 *  - Uses ingest_checkpoints for resume
 *  - Captures uma_resolution_status, competitive, volumes, rewards config, etc.
 *
 * Gap-filling on daily re-runs:
 *  - Upsert by poly_event_id / condition_id means re-fetched events refresh
 *    fields (is_resolved, volume, uma_resolution_status, etc.).
 *  - The closed pass uses a wider window (months + resolve-buffer) to catch
 *    events whose UMA resolution lands AFTER their scheduled end_date and
 *    which would otherwise have slid out of the active window.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/scan-events-v2.ts [--months=6] [--tag=sports] [--resolve-buffer=2]
 *
 * Env:
 *   SCAN_V2_MONTHS          number of months back (default 6)
 *   SCAN_V2_TAG             Polymarket tag slug (default 'sports')
 *   SCAN_V2_RESOLVE_BUFFER  extra months for closed pass (default 2)
 */

import { loadAllCategories, getCategory } from '../registry.js';
import { paginateEventsRaw } from '../api/gamma.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:scan-events-v2');

interface RawEvent {
  id?: string | number;
  title?: string;
  slug?: string;
  description?: string;
  ticker?: string;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  updatedAt?: string;
  closedTime?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  restricted?: boolean;
  featured?: boolean;
  new?: boolean;
  volume?: number | string;
  liquidity?: number | string;
  openInterest?: number | string;
  volume24hr?: number | string;
  volume1wk?: number | string;
  volume1mo?: number | string;
  competitive?: number | string;
  commentCount?: number;
  resolutionSource?: string;
  groupItemTitle?: string;
  tags?: Array<{ id: string; slug: string; label: string }>;
  markets?: RawMarket[];
  [k: string]: unknown;
}

interface RawMarket {
  id?: string | number;
  conditionId?: string;
  question?: string;
  slug?: string;
  description?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  closedTime?: string;
  clobTokenIds?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: number | string;
  liquidity?: number | string;
  volume24hr?: number | string;
  volume1wk?: number | string;
  volume1mo?: number | string;
  bestBid?: number | string;
  bestAsk?: number | string;
  spread?: number | string;
  lastTradePrice?: number | string;
  orderMinSize?: number | string;
  orderPriceMinTickSize?: number | string;
  minimum_tick_size?: number | string;
  rewardsMinSize?: number | string;
  rewardsMaxSpread?: number | string;
  negRisk?: boolean;
  negRiskMarketID?: string;
  negRiskRequestID?: string;
  acceptingOrders?: boolean;
  acceptingOrdersTimestamp?: string;
  enableOrderBook?: boolean;
  umaResolutionStatus?: string;
  umaResolutionStatuses?: unknown;
  resolvedBy?: string;
  resolutionSource?: string;
  [k: string]: unknown;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}

function ts(v: unknown): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : null;
}

function parseFinalPrices(outcomePrices: string | undefined): { yes: number | null; no: number | null } {
  if (!outcomePrices) return { yes: null, no: null };
  try {
    const prices = JSON.parse(outcomePrices);
    return { yes: num(prices[0]), no: num(prices[1]) };
  } catch { return { yes: null, no: null }; }
}

function parseTokens(clobTokenIds: string | undefined): { yes: string | null; no: string | null } {
  if (!clobTokenIds) return { yes: null, no: null };
  try {
    const t = JSON.parse(clobTokenIds);
    return { yes: t[0] || null, no: t[1] || null };
  } catch { return { yes: null, no: null }; }
}

async function upsertCheckpoint(source: string, offset: number, records: number, status: string, error?: string) {
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
    [source, String(offset), records, error || null, status]
  );
}

async function upsertEvent(ev: RawEvent, classification: { category: string; subcategory: string | null; subcategoryDetail: string | null }): Promise<number | null> {
  const polyId = ev.id ? parseInt(String(ev.id)) : null;
  if (!polyId) return null;

  const tagSlugs = (ev.tags || []).map(t => t.slug).filter(Boolean);

  const res = await query(
    `INSERT INTO events (
       poly_event_id, title, slug, description, category, subcategory, subcategory_detail,
       start_date, end_date, created_at_poly, closed_time,
       archived, restricted, featured,
       volume, liquidity, open_interest, volume_24hr, volume_1wk, volume_1mo,
       competitive, comment_count, resolution_source, group_item_title,
       tags, is_resolved, raw_payload, fetched_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,
       $8,$9,$10,$11,
       $12,$13,$14,
       $15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,
       $25,$26,$27,NOW()
     )
     ON CONFLICT (poly_event_id) DO UPDATE SET
       title = EXCLUDED.title,
       end_date = EXCLUDED.end_date,
       closed_time = EXCLUDED.closed_time,
       archived = EXCLUDED.archived,
       volume = EXCLUDED.volume,
       liquidity = EXCLUDED.liquidity,
       volume_24hr = EXCLUDED.volume_24hr,
       volume_1wk = EXCLUDED.volume_1wk,
       volume_1mo = EXCLUDED.volume_1mo,
       competitive = EXCLUDED.competitive,
       is_resolved = EXCLUDED.is_resolved,
       subcategory = EXCLUDED.subcategory,
       subcategory_detail = EXCLUDED.subcategory_detail,
       raw_payload = EXCLUDED.raw_payload,
       fetched_at = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [
      polyId, ev.title || '', ev.slug || null, ev.description || null,
      classification.category, classification.subcategory, classification.subcategoryDetail,
      ts(ev.startDate), ts(ev.endDate), ts(ev.createdAt), ts(ev.closedTime),
      bool(ev.archived), bool(ev.restricted), bool(ev.featured),
      num(ev.volume), num(ev.liquidity), num(ev.openInterest),
      num(ev.volume24hr), num(ev.volume1wk), num(ev.volume1mo),
      num(ev.competitive), ev.commentCount ?? null, ev.resolutionSource || null, ev.groupItemTitle || null,
      tagSlugs, Boolean(ev.closed), JSON.stringify(ev),
    ]
  );
  return res.rows[0]?.id ?? null;
}

async function upsertMarket(eventDbId: number, m: RawMarket): Promise<void> {
  if (!m.conditionId) return;

  const tokens = parseTokens(m.clobTokenIds);
  const finalPrices = m.closed ? parseFinalPrices(m.outcomePrices) : { yes: null, no: null };
  const resolvedTo = finalPrices.yes !== null && finalPrices.yes >= 0.99 ? 'Yes'
    : finalPrices.no !== null && finalPrices.no >= 0.99 ? 'No'
    : null;

  await query(
    `INSERT INTO markets (
       event_id, condition_id, question, slug,
       outcome_yes_token, outcome_no_token,
       start_date, end_date, created_at_poly, closed_time,
       is_closed, archived, resolved_to,
       uma_resolution_status, uma_resolution_statuses, resolved_by, resolution_source,
       best_bid, best_ask, spread, last_trade_price, final_yes_price, final_no_price,
       volume, liquidity, volume_24hr, volume_1wk, volume_1mo,
       order_min_size, tick_size, rewards_min_size, rewards_max_spread,
       neg_risk, neg_risk_market_id, neg_risk_request_id,
       accepting_orders, accepting_orders_ts, enable_order_book,
       raw_payload, fetched_at
     ) VALUES (
       $1,$2,$3,$4,
       $5,$6,
       $7,$8,$9,$10,
       $11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,$20,$21,$22,$23,
       $24,$25,$26,$27,$28,
       $29,$30,$31,$32,
       $33,$34,$35,
       $36,$37,$38,
       $39,NOW()
     )
     ON CONFLICT (condition_id) DO UPDATE SET
       is_closed = EXCLUDED.is_closed,
       archived = EXCLUDED.archived,
       resolved_to = COALESCE(EXCLUDED.resolved_to, markets.resolved_to),
       outcome_yes_token = COALESCE(EXCLUDED.outcome_yes_token, markets.outcome_yes_token),
       outcome_no_token = COALESCE(EXCLUDED.outcome_no_token, markets.outcome_no_token),
       uma_resolution_status = EXCLUDED.uma_resolution_status,
       uma_resolution_statuses = EXCLUDED.uma_resolution_statuses,
       resolved_by = EXCLUDED.resolved_by,
       best_bid = EXCLUDED.best_bid,
       best_ask = EXCLUDED.best_ask,
       spread = EXCLUDED.spread,
       last_trade_price = EXCLUDED.last_trade_price,
       final_yes_price = EXCLUDED.final_yes_price,
       final_no_price = EXCLUDED.final_no_price,
       volume = EXCLUDED.volume,
       liquidity = EXCLUDED.liquidity,
       volume_24hr = EXCLUDED.volume_24hr,
       volume_1wk = EXCLUDED.volume_1wk,
       volume_1mo = EXCLUDED.volume_1mo,
       accepting_orders = EXCLUDED.accepting_orders,
       closed_time = EXCLUDED.closed_time,
       raw_payload = EXCLUDED.raw_payload,
       fetched_at = NOW()`,
    [
      eventDbId, m.conditionId, m.question || '', m.slug || null,
      tokens.yes, tokens.no,
      ts(m.startDate), ts(m.endDate), ts(m.createdAt), ts(m.closedTime),
      Boolean(m.closed), bool(m.archived), resolvedTo,
      m.umaResolutionStatus || null, m.umaResolutionStatuses ? JSON.stringify(m.umaResolutionStatuses) : null,
      m.resolvedBy || null, m.resolutionSource || null,
      num(m.bestBid), num(m.bestAsk), num(m.spread), num(m.lastTradePrice), finalPrices.yes, finalPrices.no,
      num(m.volume), num(m.liquidity), num(m.volume24hr), num(m.volume1wk), num(m.volume1mo),
      num(m.orderMinSize), num(m.orderPriceMinTickSize ?? m.minimum_tick_size),
      num(m.rewardsMinSize), num(m.rewardsMaxSpread),
      bool(m.negRisk), m.negRiskMarketID || null, m.negRiskRequestID || null,
      bool(m.acceptingOrders), ts(m.acceptingOrdersTimestamp), bool(m.enableOrderBook),
      JSON.stringify(m),
    ]
  );
}

async function scanPass(
  passName: string,
  tagSlug: string,
  baseParams: Record<string, string | number | boolean>,
  plugin: { classifyEvent: (e: RawEvent) => { category: string; subcategory: string | null; subcategoryDetail: string | null; polyEventId: number } | null; isMatchingEvent: (e: RawEvent) => boolean }
): Promise<{ events: number; markets: number; skipped: number }> {
  let events = 0, markets = 0, skipped = 0;
  const source = `events-v2:${passName}`;

  await upsertCheckpoint(source, 0, 0, 'running');

  try {
    for await (const batch of paginateEventsRaw(tagSlug, baseParams)) {
      for (const raw of batch) {
        const ev = raw as RawEvent;

        // Plugin still applies for subcategory classification — tag filter is broad
        if (!plugin.isMatchingEvent(ev)) { skipped++; continue; }
        const classified = plugin.classifyEvent(ev);
        if (!classified) { skipped++; continue; }

        const eventDbId = await upsertEvent(ev, classified);
        if (!eventDbId) continue;
        events++;

        for (const m of ev.markets || []) {
          await upsertMarket(eventDbId, m);
          markets++;
        }
      }
      log.info({ pass: passName, events, markets, skipped }, 'Progress');
    }
    await upsertCheckpoint(source, 0, events, 'idle');
  } catch (err) {
    await upsertCheckpoint(source, 0, events, 'error', (err as Error).message);
    throw err;
  }

  return { events, markets, skipped };
}

async function main() {
  await loadAllCategories();

  const months = parseInt(process.argv.find(a => a.startsWith('--months='))?.split('=')[1] || process.env.SCAN_V2_MONTHS || '6');
  const tagSlug = process.argv.find(a => a.startsWith('--tag='))?.split('=')[1] || process.env.SCAN_V2_TAG || 'sports';
  const resolveBufferMonths = parseInt(
    process.argv.find(a => a.startsWith('--resolve-buffer='))?.split('=')[1]
      || process.env.SCAN_V2_RESOLVE_BUFFER
      || '2'
  );
  const pluginName = tagSlug; // matches sports plugin name convention

  const plugin = getCategory(pluginName);
  if (!plugin) {
    log.error({ pluginName, available: Array.from(await import('../registry.js').then(m => m.getCategoryNames())) }, 'Category plugin not registered');
    process.exit(1);
  }

  // Accurate "N months ago" — uses calendar-month arithmetic, not 30-day approximation.
  const now = new Date();
  const monthsBack = (nMonths: number) => new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - nMonths,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
  )).toISOString();

  const minEndDateActive = monthsBack(months);
  // Wider cutoff for closed pass: catches events whose UMA resolution landed
  // days or weeks after the event's scheduled end_date. Without this buffer,
  // an event that ended 5 months and 28 days ago but just resolved today
  // would slip past the closed pass on subsequent daily runs.
  const minEndDateClosed = monthsBack(months + resolveBufferMonths);

  console.log('\n=== Polymarket Event Scan (v2) ===');
  console.log(`  Tag:               ${tagSlug}`);
  console.log(`  Active window:     end_date >= ${minEndDateActive} (${months} months)`);
  console.log(`  Closed window:     end_date >= ${minEndDateClosed} (${months}+${resolveBufferMonths} months, for late UMA resolutions)`);
  console.log(`  Plugin:            ${plugin.name}`);
  console.log('');

  // Pass 1: active events in the primary window
  log.info('Pass 1: active events');
  const active = await scanPass(
    'active',
    tagSlug,
    { closed: false, end_date_min: minEndDateActive },
    plugin as never
  );
  log.info(active, 'Pass 1 complete');

  // Pass 2: resolved events — wider window to catch late UMA resolutions
  log.info('Pass 2: closed events (with resolve-buffer)');
  const closed = await scanPass(
    'closed',
    tagSlug,
    { closed: true, end_date_min: minEndDateClosed },
    plugin as never
  );
  log.info(closed, 'Pass 2 complete');

  console.log('\n=== Scan Results ===');
  console.log(`  Active:  ${active.events} events, ${active.markets} markets (${active.skipped} skipped)`);
  console.log(`  Closed:  ${closed.events} events, ${closed.markets} markets (${closed.skipped} skipped)`);
  console.log(`  Total:   ${active.events + closed.events} events, ${active.markets + closed.markets} markets`);

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
