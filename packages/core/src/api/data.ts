import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchJsonWithRetry } from './http.js';
import type { PolyTrade, PolyPosition } from '../types.js';

const log = createLogger('data-api');
const BASE = config.api.dataUrl;
const DELAY = config.api.requestDelayMs;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  log.debug({ url }, 'Fetching');
  return fetchJsonWithRetry<T>(url, 'Data API');
}

export async function fetchTradesForEvent(eventId: number | string): Promise<PolyTrade[]> {
  const allTrades: PolyTrade[] = [];
  let offset = 0;
  const limit = 10000;
  while (true) {
    const url = `${BASE}/trades?eventId=${eventId}&limit=${limit}&offset=${offset}`;
    const trades = await fetchJson<PolyTrade[]>(url);
    allTrades.push(...trades);
    if (trades.length < limit) break;
    offset += trades.length;
    await sleep(DELAY);
  }
  return allTrades;
}

/**
 * Fetch trades for a user. The Data API caps responses at 1000/request
 * regardless of `limit` and rejects offsets >3000 with HTTP 400.
 *
 * Previous bug: limit=10000 always returned a "full" 1000 (cap), so the
 * short-page loop break never triggered, and at offset 3000 the API 400'd
 * — the error propagated up and aborted the entire detectSignals cycle.
 *
 * For copy-trading we only need the last ~2 hours. Walk newest-first
 * (default ordering) and short-circuit when we cross the time window.
 */
export async function fetchTradesForUser(
  address: string,
  windowSec: number = 4 * 3600,
): Promise<PolyTrade[]> {
  const allTrades: PolyTrade[] = [];
  const cutoffTs = Math.floor(Date.now() / 1000) - windowSec;
  const pageSize = 1000;     // API hard cap
  const maxOffset = 3000;    // API hard cap
  let offset = 0;

  while (offset <= maxOffset) {
    const url = `${BASE}/trades?user=${address}&limit=${pageSize}&offset=${offset}`;
    let trades: PolyTrade[];
    try {
      trades = await fetchJson<PolyTrade[]>(url);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('400')) {
        log.debug({ address, offset, collected: allTrades.length },
          'Data API offset cap reached (treating as end-of-data)');
        break;
      }
      throw err;
    }
    if (trades.length === 0) break;
    allTrades.push(...trades);

    // Trades come back newest-first; if oldest in this batch is older than
    // our window, we have everything we need.
    const oldestTs = parseInt(String(trades[trades.length - 1]?.timestamp ?? 0));
    if (oldestTs > 0 && oldestTs < cutoffTs) break;

    if (trades.length < pageSize) break;
    offset += trades.length;
    await sleep(DELAY);
  }
  return allTrades;
}

export async function fetchTradesForMarket(conditionId: string): Promise<PolyTrade[]> {
  const allTrades: PolyTrade[] = [];
  let offset = 0;
  const limit = 10000;
  while (true) {
    const url = `${BASE}/trades?market=${conditionId}&limit=${limit}&offset=${offset}`;
    const trades = await fetchJson<PolyTrade[]>(url);
    allTrades.push(...trades);
    if (trades.length < limit) break;
    offset += trades.length;
    await sleep(DELAY);
  }
  return allTrades;
}

export async function fetchPositionsForUser(address: string): Promise<PolyPosition[]> {
  const url = `${BASE}/positions?user=${address}&limit=500`;
  return fetchJson<PolyPosition[]>(url);
}

// ──────────────────────────────────────────────────────────────
// V2: Raw payload fetches for clean ingestion
// ──────────────────────────────────────────────────────────────

/**
 * Fetch trades with full raw payload. Includes untyped fields like `type`,
 * `bio`, `profileImage` etc.
 */
export async function fetchTradesRaw(
  params: Record<string, string | number | boolean>
): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }
  return fetchJson<Record<string, unknown>[]>(`${BASE}/trades?${qs.toString()}`);
}

/**
 * Paginate trades with raw payloads. Any combination of filters supported:
 * user, market (conditionId), eventId, etc.
 *
 * The Data API caps responses at 1000 records per request regardless of
 * the `limit` param. Uses 1000 as page size so short-page detection works.
 * Handles 400 at high offsets gracefully (API internal offset cap).
 */
export interface PaginationResult {
  batches: Record<string, unknown>[][];
  complete: boolean;  // true if all data fetched, false if offset cap hit
}

/**
 * Fetch all available trades for a given filter set.
 *
 * The Data API enforces: max 1000 per request, max offset 3000.
 * This gives us at most 4 pages = 4000 trades per query.
 * `before`/`after` params are ignored by the API, so there's no way to
 * window past the cap. For most markets 4000 is the full history.
 *
 * Returns `complete: true` if we reached end-of-data naturally,
 * `complete: false` if we hit the offset cap (market has >4000 trades).
 */
export async function fetchAllTradePages(
  filters: Record<string, string | number | boolean>,
  pageSize = 1000
): Promise<PaginationResult> {
  const batches: Record<string, unknown>[][] = [];
  let offset = 0;

  while (true) {
    let trades: Record<string, unknown>[];
    try {
      trades = await fetchTradesRaw({ ...filters, limit: pageSize, offset });
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('400')) {
        log.debug({ offset, filters }, 'Offset cap reached (max 4000 trades per market)');
        return { batches, complete: false };
      }
      throw err;
    }
    if (trades.length === 0) break;
    batches.push(trades);
    if (trades.length < pageSize) break;
    offset += trades.length;
    await sleep(DELAY);
  }

  return { batches, complete: true };
}

/**
 * Fetch raw positions for a user (includes every field, untyped).
 *
 * Pages through results via offset until the API returns < pageSize (= done).
 * Whale traders routinely hold more than a single page; the previous hard
 * limit of 500 silently truncated their book.
 */
export async function fetchPositionsRaw(address: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const pageSize = 500;
  let offset = 0;
  // Hard cap to prevent runaway pagination on API misbehaviour.
  const MAX_PAGES = 20;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchJson<Record<string, unknown>[]>(
      `${BASE}/positions?user=${address}&limit=${pageSize}&offset=${offset}`
    );
    out.push(...batch);
    if (batch.length < pageSize) break;
    offset += batch.length;
    await sleep(DELAY);
    if (page === MAX_PAGES - 1) {
      log.warn({ address, pages: MAX_PAGES, totalSoFar: out.length }, 'fetchPositionsRaw hit page cap');
    }
  }
  return out;
}
