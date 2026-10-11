/**
 * Price Re-Check Engine
 * ─────────────────────
 * When a target's BUY cannot be filled inside our price limit (the market has
 * moved since the target's fill), the signal is NOT dropped for good. It is
 * parked on a watchlist for a 10-minute TTL and the price is re-checked at
 * fixed intervals:
 *
 *      T+0      initial attempt (the failed order in the entry pass)
 *      T+30s    re-check #1
 *      T+2m     re-check #2
 *      T+5m     re-check #3
 *      T+8m     re-check #4
 *      T+10m    re-check #5 (final — abandon if not filled)
 *
 * Decision at every re-check (spec §6.3):
 *
 *      slippage = (current − target) / target
 *      IF slippage <= max_slippage_for(target)     → BUY
 *      ELIF current > first_seen_price × 1.05      → ABANDON (price_moved_against_us)
 *      ELSE                                        → WAIT
 *
 * Design rules (they exist to protect real money):
 *   • At-most-once buy. A row moves watching → buying with a guarded UPDATE
 *     before any order is sent; a row stuck in 'buying' after a crash is
 *     ABANDONED on restart, never retried (the order may have filled).
 *   • State lives in Postgres (table price_watchlist), like the rest of the bot,
 *     so a restart loses nothing. All timing uses the DB clock.
 *   • This module has NO imports: the DB, the order book and the order
 *     placement are injected. That keeps it testable (see
 *     cli/selftest-price-recheck.ts) and keeps trading code out of here.
 */

// ─── Constants ──────────────────────────────────────────────────────

/** Seconds after first sighting at which re-checks #1..#5 run. */
export const RECHECK_SCHEDULE_SEC: readonly number[] = [30, 120, 300, 480, 600];
/** A watch lives this long, then is ABANDONED (max_time_exceeded). */
export const RECHECK_TTL_SEC = 600;
/** A row processed later than TTL + grace (bot was down) is abandoned without a
 *  check — we do not buy into a 15-minute-old signal. Covers poll-cycle jitter. */
export const RECHECK_GRACE_SEC = 60;
/** ABANDON when the ask is more than 5% above the first-seen price. */
export const AGAINST_MOVE_RATIO = 1.05;
/** Max watch rows processed per cycle (each costs one order-book read). */
export const RECHECK_BATCH = 25;

const EPS = 1e-9;

// ─── Types ──────────────────────────────────────────────────────────

export type WatchStatus = 'watching' | 'buying' | 'bought' | 'abandoned';
export type DecisionAction = 'BUY' | 'ABANDON' | 'WAIT';

export interface Decision {
  action: DecisionAction;
  /** (current − target) / target, or null when there is no usable price. */
  slippage: number | null;
  reason?: string;
  note?: string;
}

export interface HistoryItem {
  n: number;                 // re-check number 1..5 (0 = the initial attempt)
  at: string;                // ISO timestamp (bot clock; informational only)
  elapsed_s: number;         // seconds since first sighting (DB clock)
  price: number | null;      // best ask seen
  slippage: number | null;
  max_slip: number | null;
  decision: DecisionAction;
  note?: string;
}

export interface WatchEntry {
  id: number;
  proxyWallet: string;
  sourceTradeKey: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  targetPrice: number;
  targetSize: number;        // shares
  targetTs: number;          // unix seconds
  firstSeenPrice: number | null;
  capUsd: number;
  capKind: 'market' | 'event';
  checkCount: number;        // schedule slots consumed so far
  elapsedSec: number;        // seconds since first_seen_at, DB clock
}

export interface NewWatch {
  proxyWallet: string;
  sourceTradeKey: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  targetPrice: number;
  targetSize: number;
  targetTs: number;
  firstSeenPrice: number | null;
  capUsd: number;
  capKind: 'market' | 'event';
  firstSlotSec: number;
  ttlSec: number;
  history: HistoryItem[];
}

export interface FillInfo {
  price: number;
  shares: number;
  usd: number;
}

/** What the injected buy function reports back. */
export type BuyOutcome =
  | { kind: 'filled'; fillPrice: number; shares: number; usdSpent: number }
  | { kind: 'no_fill'; reason: string }   // price still unavailable — keep watching
  | { kind: 'blocked'; reason: string }   // a guard now forbids the buy — abandon
  | { kind: 'error'; reason: string };    // hard failure — abandon (never retry blindly)

/** Persistence port. PgWatchStore implements it on Postgres; tests use memory. */
export interface WatchStore {
  /** Insert a new watch. Returns false if one already exists (dup trade / dup market). */
  insert(w: NewWatch): Promise<boolean>;
  listDue(limit: number): Promise<WatchEntry[]>;
  /** watching → buying. True only for the single caller that wins. */
  claimBuy(id: number): Promise<boolean>;
  /** Record a check and schedule the next one. `from` is the status the row must be in. */
  reschedule(a: {
    id: number; from: 'watching' | 'buying'; checkCount: number;
    nextOffsetSec: number; firstSeenPrice: number | null; item: HistoryItem;
  }): Promise<boolean>;
  /** Terminal transition. Returns the full history, or null if the row was not in `from`. */
  finish(a: {
    id: number; from: 'watching' | 'buying'; status: 'bought' | 'abandoned';
    reason: string; checkCount: number; firstSeenPrice: number | null;
    fill: FillInfo | null; item: HistoryItem | null;
  }): Promise<HistoryItem[] | null>;
  /** Abandon every 'watching' row for {wallet, market, token} whose trade is not newer than sellTs. */
  cancelMatching(a: {
    proxyWallet: string; conditionId: string; tokenId: string; sellTs: number;
    reason: string; item: HistoryItem;
  }): Promise<Array<{ proxyWallet: string; sourceTradeKey: string }>>;
  /** Startup: rows left in 'buying' by a crash → abandoned (never retried). */
  failInterrupted(item: HistoryItem): Promise<Array<{ proxyWallet: string; sourceTradeKey: string }>>;
  /** Mirror the outcome onto the copy_signals row claimed for this trade. */
  finalizeSignal(proxyWallet: string, sourceTradeKey: string, actedOn: boolean, skipReason: string | null): Promise<void>;
}

export interface RecheckDeps {
  store: WatchStore;
  /** Best (lowest) ask for the outcome token, or null if unavailable. Must not throw for "no data". */
  getBestAsk: (tokenId: string) => Promise<number | null>;
  /** Re-run guards + sizing + order. Must never throw for ordinary failures. */
  executeBuy: (w: WatchEntry, currentPrice: number, limitPrice: number) => Promise<BuyOutcome>;
  /** Relative slippage allowed for a target price (0.10 = 10%). */
  maxSlippageFor: (targetPrice: number) => number;
  /** Our price band (a fill must land inside it). */
  minPrice: number;
  maxPrice: number;
  schedule?: readonly number[];
  ttlSec?: number;
  graceSec?: number;
  log?: (msg: string) => void;
}

// ─── Pure helpers ───────────────────────────────────────────────────

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * True when a failed BUY means "the price is not available inside our limit",
 * i.e. nothing was filled and a later price may still be acceptable.
 *
 * Deliberately NOT included: delayed_no_fill_* (the order may still match later —
 * re-buying could double up), balance/allowance/auth errors, zero_fill, 4xx.
 */
export function isPriceUnavailableReason(reason: string | undefined | null): boolean {
  if (!reason) return false;
  return (
    reason.startsWith('above_limit_') ||
    reason === 'no_liquidity_at_our_price' ||
    /no orders found to match/i.test(reason)
  );
}

/** Lowest ask with positive size from a CLOB /book payload. Does not assume sort order. */
export function parseBestAsk(book: unknown): number | null {
  const asks = (book as { asks?: unknown } | null)?.asks;
  if (!Array.isArray(asks)) return null;
  let best: number | null = null;
  for (const a of asks as Array<{ price?: unknown; size?: unknown }>) {
    const p = parseFloat(String(a?.price));
    const s = a?.size === undefined ? 1 : parseFloat(String(a.size));
    if (!(p > 0 && p <= 1) || !(s > 0)) continue;
    if (best === null || p < best) best = p;
  }
  return best;
}

/** GET {clobUrl}/book?token_id=… → best ask. Null on any failure (caller WAITs). */
export async function fetchBestAsk(clobUrl: string, tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return parseBestAsk(await res.json());
  } catch {
    return null;
  }
}

/** The §6.3 decision. Pure. */
export function decide(a: {
  currentPrice: number | null;
  targetPrice: number;
  firstSeenPrice: number | null;
  maxSlip: number;
  minPrice: number;
  maxPrice: number;
}): Decision {
  const { currentPrice, targetPrice, firstSeenPrice, maxSlip, minPrice, maxPrice } = a;
  if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0 || !(targetPrice > 0)) {
    return { action: 'WAIT', slippage: null, note: 'no_price' };
  }
  const slippage = (currentPrice - targetPrice) / targetPrice;
  const inBand = currentPrice >= minPrice - EPS && currentPrice <= maxPrice + EPS;

  if (slippage <= maxSlip + EPS && inBand) return { action: 'BUY', slippage };

  if (firstSeenPrice !== null && currentPrice > firstSeenPrice * AGAINST_MOVE_RATIO) {
    return { action: 'ABANDON', slippage, reason: 'price_moved_against_us' };
  }
  return {
    action: 'WAIT',
    slippage,
    note: !inBand ? 'outside_price_band' : 'slippage_above_max',
  };
}

// ─── Engine ─────────────────────────────────────────────────────────

export interface EnqueueInput {
  proxyWallet: string;
  sourceTradeKey: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  targetPrice: number;
  targetSize: number;
  targetTs: number;
  capUsd: number;
  capKind: 'market' | 'event';
  failReason: string;
}

/**
 * Park a signal whose price was unavailable. T+0 reference price = best ask now.
 * Returns true if the signal is now being watched; false if it was not queued
 * (duplicate) and the caller should record the plain buy_failed outcome.
 */
export async function enqueueWatch(deps: RecheckDeps, i: EnqueueInput): Promise<boolean> {
  const schedule = deps.schedule ?? RECHECK_SCHEDULE_SEC;
  const ttl = deps.ttlSec ?? RECHECK_TTL_SEC;
  const wallet = i.proxyWallet.toLowerCase();

  let firstSeen: number | null = null;
  try { firstSeen = await deps.getBestAsk(i.tokenId); } catch { firstSeen = null; }

  const inserted = await deps.store.insert({
    proxyWallet: wallet,
    sourceTradeKey: i.sourceTradeKey,
    conditionId: i.conditionId,
    tokenId: i.tokenId,
    outcome: i.outcome,
    targetPrice: i.targetPrice,
    targetSize: i.targetSize,
    targetTs: i.targetTs,
    firstSeenPrice: firstSeen,
    capUsd: i.capUsd,
    capKind: i.capKind,
    firstSlotSec: schedule[0],
    ttlSec: ttl,
    history: [{
      n: 0,
      at: new Date().toISOString(),
      elapsed_s: 0,
      price: firstSeen,
      slippage: firstSeen !== null && i.targetPrice > 0 ? (firstSeen - i.targetPrice) / i.targetPrice : null,
      max_slip: deps.maxSlippageFor(i.targetPrice),
      decision: 'WAIT',
      note: `initial_attempt_failed:${i.failReason}`.slice(0, 200),
    }],
  });
  if (!inserted) return false;

  await deps.store.finalizeSignal(wallet, i.sourceTradeKey, false, 'price_watch');
  (deps.log ?? console.log)(
    `[recheck] watching ${i.outcome} @ target ${i.targetPrice} (ask now ${firstSeen ?? 'n/a'}) ` +
    `— re-checks at ${schedule.map(s => `${s}s`).join(', ')}`,
  );
  return true;
}

/** Abandon watches for a market the target has just SOLD (we must not buy what they exited). */
export async function cancelWatches(
  deps: Pick<RecheckDeps, 'store' | 'log'>,
  a: { proxyWallet: string; conditionId: string; tokenId: string; sellTs: number; reason: string },
): Promise<number> {
  const item: HistoryItem = {
    n: -1, at: new Date().toISOString(), elapsed_s: 0, price: null, slippage: null, max_slip: null,
    decision: 'ABANDON', note: a.reason,
  };
  const wallet = a.proxyWallet.toLowerCase();
  const rows = await deps.store.cancelMatching({
    proxyWallet: wallet, conditionId: a.conditionId, tokenId: a.tokenId,
    sellTs: a.sellTs, reason: a.reason, item,
  });
  for (const r of rows) {
    await deps.store.finalizeSignal(r.proxyWallet, r.sourceTradeKey, false, `recheck_abandoned:${a.reason}`);
    (deps.log ?? console.log)(`[recheck] abandoned watch on ${a.conditionId.slice(0, 12)}… — ${a.reason}`);
  }
  return rows.length;
}

/** Startup: anything left in 'buying' may or may not have filled. Never retry; flag for reconcile. */
export async function recoverInterrupted(deps: Pick<RecheckDeps, 'store' | 'log'>): Promise<number> {
  const rows = await deps.store.failInterrupted({
    n: -1, at: new Date().toISOString(), elapsed_s: 0, price: null, slippage: null, max_slip: null,
    decision: 'ABANDON', note: 'interrupted_during_buy',
  });
  for (const r of rows) {
    await deps.store.finalizeSignal(r.proxyWallet, r.sourceTradeKey, false, 'recheck_abandoned:interrupted_during_buy');
  }
  if (rows.length > 0) {
    (deps.log ?? console.log)(
      `[recheck] ${rows.length} watch(es) were mid-buy at last shutdown and were ABANDONED, not retried. ` +
      `Check the wallet / live_positions for an untracked fill.`,
    );
  }
  return rows.length;
}

/** Run every due re-check. Call once per poll cycle. */
export async function processWatchlist(deps: RecheckDeps, activeWallets: ReadonlySet<string>): Promise<void> {
  const log = deps.log ?? console.log;
  const due = await deps.store.listDue(RECHECK_BATCH);
  for (const w of due) {
    try {
      await processEntry(deps, w, activeWallets);
    } catch (err) {
      // Row stays 'watching' and is retried next cycle (TTL + grace still bound it).
      log(`[recheck] #${w.id} error: ${(err as Error).message}`);
    }
  }
}

async function processEntry(deps: RecheckDeps, w: WatchEntry, activeWallets: ReadonlySet<string>): Promise<void> {
  const schedule = deps.schedule ?? RECHECK_SCHEDULE_SEC;
  const ttl = deps.ttlSec ?? RECHECK_TTL_SEC;
  const grace = deps.graceSec ?? RECHECK_GRACE_SEC;
  const elapsed = w.elapsedSec;
  const idx = w.checkCount;

  const baseItem = (over: Partial<HistoryItem>): HistoryItem => ({
    n: idx + 1, at: new Date().toISOString(), elapsed_s: round1(elapsed),
    price: null, slippage: null, max_slip: null, decision: 'WAIT', ...over,
  });

  // Overdue (bot was down / stalled): do not buy into a stale signal.
  if (elapsed > ttl + grace) {
    await finishAbandoned(deps, w, 'watching', 'max_time_exceeded', idx, w.firstSeenPrice,
      baseItem({ decision: 'ABANDON', note: 'overdue_no_check' }));
    return;
  }
  // Target paused / removed since we parked this.
  if (!activeWallets.has(w.proxyWallet)) {
    await finishAbandoned(deps, w, 'watching', 'target_inactive', idx, w.firstSeenPrice,
      baseItem({ decision: 'ABANDON', note: 'target_inactive' }));
    return;
  }

  let price: number | null = null;
  try { price = await deps.getBestAsk(w.tokenId); } catch { price = null; }

  // Next schedule slot strictly in the future (slots we slept through are skipped).
  let next = idx + 1;
  while (next < schedule.length && schedule[next] <= elapsed) next++;
  const isFinal = next >= schedule.length;

  const maxSlip = deps.maxSlippageFor(w.targetPrice);
  // The reference price is fixed once known. If the T+0 read failed, THIS check
  // sets it — and cannot itself trigger "moved against us".
  const referencePrice = w.firstSeenPrice ?? price;
  const d = decide({
    currentPrice: price, targetPrice: w.targetPrice, firstSeenPrice: w.firstSeenPrice,
    maxSlip, minPrice: deps.minPrice, maxPrice: deps.maxPrice,
  });
  const item = baseItem({ price, slippage: d.slippage, max_slip: maxSlip, decision: d.action, note: d.reason ?? d.note });

  if (d.action === 'ABANDON') {
    await finishAbandoned(deps, w, 'watching', d.reason ?? 'price_moved_against_us', next, referencePrice, item);
    return;
  }

  if (d.action === 'WAIT') {
    if (isFinal) {
      await finishAbandoned(deps, w, 'watching', 'max_time_exceeded', next, referencePrice, item);
    } else {
      await deps.store.reschedule({
        id: w.id, from: 'watching', checkCount: next, nextOffsetSec: schedule[next],
        firstSeenPrice: referencePrice, item,
      });
    }
    return;
  }

  // BUY — price is acceptable. Win the watching → buying transition first.
  if (price === null) return;                       // unreachable (decide() BUYs only with a price); guard for TS
  if (!(await deps.store.claimBuy(w.id))) return;   // someone else has it

  const limit = round6(Math.min(deps.maxPrice, w.targetPrice * (1 + maxSlip)));
  let out: BuyOutcome;
  try {
    out = await deps.executeBuy(w, price, limit);
  } catch (err) {
    out = { kind: 'error', reason: (err as Error).message };
  }

  switch (out.kind) {
    case 'filled': {
      item.note = `filled@${out.fillPrice}`;
      const hist = await deps.store.finish({
        id: w.id, from: 'buying', status: 'bought', reason: 'filled', checkCount: next,
        firstSeenPrice: referencePrice,
        fill: { price: out.fillPrice, shares: out.shares, usd: out.usdSpent }, item,
      });
      try { await deps.store.finalizeSignal(w.proxyWallet, w.sourceTradeKey, true, null); } catch (e) {
        (deps.log ?? console.log)(`[recheck] #${w.id} bought but signal update failed: ${(e as Error).message}`);
      }
      (deps.log ?? console.log)(
        `[recheck] #${w.id} ✓ BOUGHT on re-check ${idx + 1} @ ${out.fillPrice} (target ${w.targetPrice}) ` +
        `history=${JSON.stringify(hist ?? [])}`,
      );
      return;
    }
    case 'no_fill': {
      item.note = `buy_no_fill:${out.reason}`.slice(0, 200);
      if (isFinal) {
        await finishAbandoned(deps, w, 'buying', 'max_time_exceeded', next, referencePrice, item);
      } else {
        await deps.store.reschedule({
          id: w.id, from: 'buying', checkCount: next, nextOffsetSec: schedule[next],
          firstSeenPrice: referencePrice, item,
        });
      }
      return;
    }
    case 'blocked': {
      item.decision = 'ABANDON';
      item.note = out.reason;
      await finishAbandoned(deps, w, 'buying', out.reason, next, referencePrice, item);
      return;
    }
    case 'error': {
      item.decision = 'ABANDON';
      item.note = `buy_failed:${out.reason}`.slice(0, 200);
      await finishAbandoned(deps, w, 'buying', `buy_failed:${out.reason}`.slice(0, 120), next, referencePrice, item);
      return;
    }
  }
}

async function finishAbandoned(
  deps: RecheckDeps, w: WatchEntry, from: 'watching' | 'buying', reason: string,
  checkCount: number, firstSeenPrice: number | null, item: HistoryItem,
): Promise<void> {
  const log = deps.log ?? console.log;
  const hist = await deps.store.finish({
    id: w.id, from, status: 'abandoned', reason, checkCount, firstSeenPrice, fill: null, item,
  });
  if (hist === null) return;     // lost the race / already closed
  try {
    await deps.store.finalizeSignal(w.proxyWallet, w.sourceTradeKey, false, `recheck_abandoned:${reason}`.slice(0, 160));
  } catch (e) {
    log(`[recheck] #${w.id} abandoned but signal update failed: ${(e as Error).message}`);
  }
  log(`[recheck] #${w.id} ✗ ABANDONED (${reason}) target=${w.targetPrice} history=${JSON.stringify(hist)}`);
}

// ─── Postgres store ─────────────────────────────────────────────────

export type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export class PgWatchStore implements WatchStore {
  constructor(private readonly q: QueryFn) {}

  async insert(w: NewWatch): Promise<boolean> {
    const r = await this.q(
      `INSERT INTO price_watchlist
         (proxy_wallet, source_trade_key, condition_id, token_id, outcome,
          target_price, target_size, target_ts, first_seen_price,
          cap_usd, cap_kind, next_check_at, expires_at, history)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               NOW() + make_interval(secs => $12::double precision),
               NOW() + make_interval(secs => $13::double precision),
               $14::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        w.proxyWallet, w.sourceTradeKey, w.conditionId, w.tokenId, w.outcome,
        w.targetPrice, w.targetSize, w.targetTs, w.firstSeenPrice,
        w.capUsd, w.capKind, w.firstSlotSec, w.ttlSec, JSON.stringify(w.history),
      ],
    );
    return r.rows.length > 0;
  }

  async listDue(limit: number): Promise<WatchEntry[]> {
    const r = await this.q(
      `SELECT id, proxy_wallet, source_trade_key, condition_id, token_id, outcome,
              target_price, target_size, target_ts::float8 AS target_ts,
              first_seen_price, cap_usd, cap_kind, check_count,
              EXTRACT(EPOCH FROM (NOW() - first_seen_at))::float8 AS elapsed_s
         FROM price_watchlist
        WHERE status = 'watching' AND next_check_at <= NOW()
        ORDER BY next_check_at ASC
        LIMIT $1`,
      [limit],
    );
    return r.rows.map((x: any) => ({
      id: Number(x.id),
      proxyWallet: String(x.proxy_wallet),
      sourceTradeKey: String(x.source_trade_key),
      conditionId: String(x.condition_id),
      tokenId: String(x.token_id),
      outcome: String(x.outcome),
      targetPrice: Number(x.target_price),
      targetSize: Number(x.target_size),
      targetTs: Number(x.target_ts),
      firstSeenPrice: x.first_seen_price === null ? null : Number(x.first_seen_price),
      capUsd: Number(x.cap_usd),
      capKind: x.cap_kind === 'event' ? 'event' : 'market',
      checkCount: Number(x.check_count),
      elapsedSec: Number(x.elapsed_s),
    }));
  }

  async claimBuy(id: number): Promise<boolean> {
    const r = await this.q(
      `UPDATE price_watchlist SET status = 'buying', updated_at = NOW()
        WHERE id = $1 AND status = 'watching'
        RETURNING id`,
      [id],
    );
    return r.rows.length > 0;
  }

  async reschedule(a: {
    id: number; from: 'watching' | 'buying'; checkCount: number;
    nextOffsetSec: number; firstSeenPrice: number | null; item: HistoryItem;
  }): Promise<boolean> {
    const r = await this.q(
      `UPDATE price_watchlist
          SET status = 'watching',
              check_count = $3,
              next_check_at = first_seen_at + make_interval(secs => $4::double precision),
              first_seen_price = COALESCE(first_seen_price, $5::double precision),
              history = history || $6::jsonb,
              updated_at = NOW()
        WHERE id = $1 AND status = $2
        RETURNING id`,
      [a.id, a.from, a.checkCount, a.nextOffsetSec, a.firstSeenPrice, JSON.stringify([a.item])],
    );
    return r.rows.length > 0;
  }

  async finish(a: {
    id: number; from: 'watching' | 'buying'; status: 'bought' | 'abandoned';
    reason: string; checkCount: number; firstSeenPrice: number | null;
    fill: FillInfo | null; item: HistoryItem | null;
  }): Promise<HistoryItem[] | null> {
    const r = await this.q(
      `UPDATE price_watchlist
          SET status = $3,
              reason = $4::text,
              check_count = $5,
              first_seen_price = COALESCE(first_seen_price, $6::double precision),
              fill_price = $7::double precision,
              fill_shares = $8::double precision,
              fill_usd = $9::double precision,
              history = history || $10::jsonb,
              closed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND status = $2
        RETURNING history`,
      [
        a.id, a.from, a.status, a.reason, a.checkCount, a.firstSeenPrice,
        a.fill?.price ?? null, a.fill?.shares ?? null, a.fill?.usd ?? null,
        JSON.stringify(a.item ? [a.item] : []),
      ],
    );
    return r.rows.length > 0 ? (r.rows[0].history as HistoryItem[]) : null;
  }

  async cancelMatching(a: {
    proxyWallet: string; conditionId: string; tokenId: string; sellTs: number;
    reason: string; item: HistoryItem;
  }): Promise<Array<{ proxyWallet: string; sourceTradeKey: string }>> {
    const r = await this.q(
      `UPDATE price_watchlist
          SET status = 'abandoned', reason = $5::text,
              history = history || $6::jsonb,
              closed_at = NOW(), updated_at = NOW()
        WHERE proxy_wallet = $1 AND condition_id = $2 AND token_id = $3
          AND status = 'watching' AND target_ts <= $4
        RETURNING proxy_wallet, source_trade_key`,
      [a.proxyWallet, a.conditionId, a.tokenId, a.sellTs, a.reason, JSON.stringify([a.item])],
    );
    return r.rows.map((x: any) => ({ proxyWallet: String(x.proxy_wallet), sourceTradeKey: String(x.source_trade_key) }));
  }

  async failInterrupted(item: HistoryItem): Promise<Array<{ proxyWallet: string; sourceTradeKey: string }>> {
    const r = await this.q(
      `UPDATE price_watchlist
          SET status = 'abandoned', reason = 'interrupted_during_buy',
              history = history || $1::jsonb,
              closed_at = NOW(), updated_at = NOW()
        WHERE status = 'buying'
        RETURNING proxy_wallet, source_trade_key`,
      [JSON.stringify([item])],
    );
    return r.rows.map((x: any) => ({ proxyWallet: String(x.proxy_wallet), sourceTradeKey: String(x.source_trade_key) }));
  }

  async finalizeSignal(proxyWallet: string, sourceTradeKey: string, actedOn: boolean, skipReason: string | null): Promise<void> {
    await this.q(
      `UPDATE copy_signals SET acted_on = $3, skip_reason = $4::text
        WHERE proxy_wallet = $1 AND source_trade_key = $2`,
      [proxyWallet.toLowerCase(), sourceTradeKey, actedOn, skipReason],
    );
  }
}
