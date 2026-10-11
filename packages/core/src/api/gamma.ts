import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchJsonWithRetry } from './http.js';
import type { PolyEvent, CategoryPlugin } from '../types.js';

const log = createLogger('gamma-api');
const BASE = config.api.gammaUrl;
const DELAY = config.api.requestDelayMs;
const PAGE_SIZE = config.api.pageSize;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  return fetchJsonWithRetry<T>(url, 'Gamma API');
}

export async function fetchEvents(params: Record<string, string | number | boolean>): Promise<PolyEvent[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }
  const url = `${BASE}/events?${qs.toString()}`;
  return fetchJson<PolyEvent[]>(url);
}

export async function fetchEventBySlug(slug: string): Promise<PolyEvent | null> {
  const events = await fetchJson<PolyEvent[]>(`${BASE}/events?slug=${encodeURIComponent(slug)}`);
  return events[0] || null;
}

/**
 * Check if an event matches a category using the plugin's filter.
 */
export function isMatchingEvent(event: PolyEvent, plugin: CategoryPlugin): boolean {
  return plugin.isMatchingEvent(event);
}

/**
 * Paginate through events, yielding batches.
 */
export async function* paginateEvents(
  baseParams: Record<string, string | number | boolean>,
  maxPages = 500
): AsyncGenerator<PolyEvent[], void, unknown> {
  let offset = 0;
  let page = 0;
  while (page < maxPages) {
    const events = await fetchEvents({ ...baseParams, limit: PAGE_SIZE, offset });
    if (events.length === 0) break;
    yield events;
    offset += events.length;
    page++;
    await sleep(DELAY);
  }
}

// ──────────────────────────────────────────────────────────────
// V2: Raw payload fetch for clean ingestion
// ──────────────────────────────────────────────────────────────

/**
 * Fetch events with full raw payload (untyped). Use for v2 ingestion where
 * we need every field the API returns, not just the ones we've typed.
 */
export async function fetchEventsRaw(
  params: Record<string, string | number | boolean>
): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }
  return fetchJson<Record<string, unknown>[]>(`${BASE}/events?${qs.toString()}`);
}

/**
 * Paginate events with raw payloads. Defaults to sports tag.
 * @param tagSlug Polymarket tag slug (e.g. 'sports'). Pass empty string to skip.
 * @param extraParams additional query params (closed, active, end_date_min, etc.)
 */
export async function* paginateEventsRaw(
  tagSlug: string,
  extraParams: Record<string, string | number | boolean> = {},
  maxPages = 1000
): AsyncGenerator<Record<string, unknown>[], void, unknown> {
  const base: Record<string, string | number | boolean> = { ...extraParams };
  if (tagSlug) base.tag_slug = tagSlug;

  let offset = 0;
  let page = 0;
  while (page < maxPages) {
    const events = await fetchEventsRaw({ ...base, limit: PAGE_SIZE, offset });
    if (events.length === 0) break;
    yield events;
    if (events.length < PAGE_SIZE) break;
    offset += events.length;
    page++;
    await sleep(DELAY);
  }
  log.info({ tagSlug, pages: page, totalOffset: offset }, 'paginateEventsRaw complete');
}
