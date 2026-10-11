/**
 * Shared signal detection for both paper and live trading.
 *
 * Handles: trade fetching, partial fill dedup, position validation,
 * filter chain, and open position management.
 */

import { query, getClient } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { fetchTradesForUser, fetchPositionsRaw } from '../api/data.js';
import { getMidpoint, getOrderBook } from '../api/clob.js';
import type { PolyTrade, TradingEngine, TradingMode, FilterConfig } from '../types.js';

const log = createLogger('signal-detector');

// ─── Types ─────────────────────────────────────────────────────────

interface CopyTarget {
  id: number;
  trader_id: number;
  proxy_wallet: string;
  display_name: string;
  category: string;
}

interface MarketInfo {
  market_id: number;
  event_id: number;
  condition_id: string;
  is_closed: boolean;
  end_date: string | null;
  outcome_yes_token: string | null;
  outcome_no_token: string | null;
  is_resolved: boolean;
  resolved_to: string | null;
  subcategory: string | null;
}

// ─── Config ────────────────────────────────────────────────────────

export function getFilterConfig(mode: TradingMode): FilterConfig {
  const prefix = mode === 'live' ? 'LIVE' : 'PAPER';
  return {
    maxPrice: parseFloat(process.env[`${prefix}_MAX_PRICE`] || '0.95'),
    maxHoursToResolution: parseFloat(process.env[`${prefix}_MAX_HOURS_TO_RESOLUTION`] || '24'),
    maxPositions: parseInt(process.env[`${prefix}_MAX_POSITIONS`] || '10'),
    dailyLossLimit: parseFloat(process.env[`${prefix}_DAILY_LOSS_LIMIT`] || '20'),
    positionSize: parseFloat(process.env[`${prefix}_POSITION_SIZE`] || '5'),
    excludeSubcategories: (process.env[`${prefix}_EXCLUDE_SUBCATEGORIES`] || 'Other').split(',').map(s => s.trim()).filter(Boolean),
    convertPriceThreshold: parseFloat(process.env[`${prefix}_CONVERT_THRESHOLD`] || '0.95'),
    pollIntervalMs: parseInt(process.env[`${prefix}_POLL_INTERVAL`] || '60000'),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

async function lookupMarket(conditionId: string): Promise<MarketInfo | null> {
  const res = await query(
    `SELECT m.id as market_id, m.event_id, m.condition_id, m.is_closed, m.end_date,
            m.outcome_yes_token, m.outcome_no_token, m.resolved_to,
            e.is_resolved, e.category, e.subcategory
     FROM markets m
     JOIN events e ON e.id = m.event_id
     WHERE m.condition_id = $1`,
    [conditionId]
  );
  return res.rows[0] || null;
}

/**
 * Check if a signal has been FULLY processed (acted on OR explicitly skipped
 * with a reason). Unfinished rows (crashed mid-filter, no skip_reason and
 * acted_on=false) should be retried, NOT treated as already-seen.
 *
 * Without this filter, a crash between recordSignal and markSignalActed
 * leaves an orphan row that permanently blocks future retries of the
 * same trade. Bug from prior review.
 */
async function hasSeenSignal(proxyWallet: string, conditionId: string, timestamp: number): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM copy_signals
     WHERE proxy_wallet = $1 AND condition_id = $2
       AND detected_at >= to_timestamp($3) - INTERVAL '1 second'
       AND detected_at <= to_timestamp($3) + INTERVAL '1 second'
       AND (acted_on = true OR skip_reason IS NOT NULL)
     LIMIT 1`,
    [proxyWallet, conditionId, timestamp]
  );
  return res.rows.length > 0;
}

async function recordSignal(
  target: CopyTarget, trade: PolyTrade, market: MarketInfo | null, signalType: string
): Promise<number | null> {
  // Wrapped in try/catch: a FK violation on market_id (if column is NOT NULL
  // and market is unknown) shouldn't crash the whole cycle. We log and
  // continue without a signal id — downstream code handles signalId=null.
  try {
    const res = await query(
      `INSERT INTO copy_signals (copy_target_id, trader_id, proxy_wallet, condition_id, market_id, event_id,
        side, outcome, price, size, signal_type, detected_at, acted_on, skip_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12), false, null)
       RETURNING id`,
      [target.id, target.trader_id, target.proxy_wallet, trade.conditionId,
       market?.market_id || null, market?.event_id || null,
       trade.side, trade.outcome, trade.price, trade.size,
       signalType, trade.timestamp]
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    log.warn({
      err: (err as Error).message,
      target: target.display_name,
      conditionId: trade.conditionId,
    }, 'recordSignal failed (continuing without signal_id)');
    return null;
  }
}

/**
 * Atomically CLAIM a target trade before we act on it.
 *
 * This replaces the old "check hasSeenSignal, then later recordSignal" pattern,
 * which was a check-then-act race: two overlapping cycles (e.g. a PM2 restart
 * that briefly runs the old + new process together, or a crash/retry) could
 * both pass the dedup check and both place an order → the SAME trade executed
 * multiple times.
 *
 * The claim runs inside a transaction under a per-trade advisory lock
 * (keyed on wallet+condition+timestamp), so concurrent cycles serialize on it.
 * Inside the lock we check whether ANY copy_signals row already exists for this
 * trade (finalized or not) — if so, someone already claimed it and we return
 * null (caller must skip without trading). Otherwise we insert the row and
 * return its id. The row is committed BEFORE the order is placed, so even a
 * crash mid-trade can never resurface the trade as "unseen".
 *
 * Note: unlike the old hasSeenSignal (which deliberately retried un-finalized
 * rows), a bare claim row now blocks re-execution. For a real-money path,
 * "miss one copy" is strictly safer than "double-execute".
 *
 * Returns the new signal id, or null if the trade was already claimed / the
 * claim failed (caller skips — never trade without a successful claim).
 */
async function claimTrade(
  target: CopyTarget, trade: PolyTrade, market: MarketInfo | null, signalType: string
): Promise<number | null> {
  const lockKey = `${target.proxy_wallet}:${trade.conditionId}:${trade.timestamp}`;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Serialize all cycles competing for this exact trade. Released on COMMIT.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

    const existing = await client.query(
      `SELECT 1 FROM copy_signals
        WHERE proxy_wallet = $1 AND condition_id = $2
          AND detected_at >= to_timestamp($3) - INTERVAL '1 second'
          AND detected_at <= to_timestamp($3) + INTERVAL '1 second'
        LIMIT 1`,
      [target.proxy_wallet, trade.conditionId, trade.timestamp]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return null; // already claimed by another cycle — skip
    }

    const inserted = await client.query(
      `INSERT INTO copy_signals (copy_target_id, trader_id, proxy_wallet, condition_id, market_id, event_id,
         side, outcome, price, size, signal_type, detected_at, acted_on, skip_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12), false, null)
       RETURNING id`,
      [target.id, target.trader_id, target.proxy_wallet, trade.conditionId,
       market?.market_id || null, market?.event_id || null,
       trade.side, trade.outcome, trade.price, trade.size,
       signalType, trade.timestamp]
    );
    await client.query('COMMIT');
    return inserted.rows[0]?.id ?? null;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    // Could not claim (e.g. transient DB error / NOT NULL violation). Do NOT
    // trade — better to skip this cycle and retry the claim next cycle than to
    // execute an order we couldn't record (which would re-fire every cycle).
    log.warn({
      err: (err as Error).message,
      target: target.display_name,
      conditionId: trade.conditionId,
    }, 'claimTrade failed (skipping trade this cycle)');
    return null;
  } finally {
    client.release();
  }
}

// ─── Orderbook snapshot + execution log ─────────────────────────────

interface SnapshotContext {
  marketId: number;
  conditionId: string;
  tokenId: string;
  outcome: string;
  signalId: number | null;
  copyTargetId: number;
  mode: TradingMode;
  traderPrice: number;
  traderTimestamp: number;
  side: 'YES' | 'NO';
}

/**
 * Captures orderbook state at signal time and writes an execution_log entry.
 * Silently logs and continues on failure — this is telemetry, not critical path.
 */
async function captureSnapshotAndExecLog(ctx: SnapshotContext, ourPrice: number): Promise<void> {
  try {
    const book = await getOrderBook(ctx.tokenId);
    const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : null;
    const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : null;
    const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
    const capturedAt = new Date();

    const bids = book.bids.slice(0, 20).map(e => [parseFloat(e.price), parseFloat(e.size)]);
    const asks = book.asks.slice(0, 20).map(e => [parseFloat(e.price), parseFloat(e.size)]);

    const snapRes = await query(
      `INSERT INTO orderbook_snapshots (
         market_id, condition_id, token_id, outcome, captured_at,
         best_bid, best_ask, midpoint, spread,
         bids, asks, source_hash, trigger, trigger_ref
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        ctx.marketId, ctx.conditionId, ctx.tokenId, ctx.outcome, capturedAt,
        bestBid, bestAsk, midpoint, spread,
        JSON.stringify(bids), JSON.stringify(asks), book.hash || null, 'signal',
        ctx.signalId ? String(ctx.signalId) : null,
      ]
    );

    // Execution log: captures the truth about slippage + latency
    const latencyMs = capturedAt.getTime() - ctx.traderTimestamp * 1000;
    const slippage = ourPrice - ctx.traderPrice;

    await query(
      `INSERT INTO execution_log (
         copy_signal_id, copy_target_id, mode, condition_id, side,
         trader_price, trader_timestamp, our_price, our_timestamp,
         latency_ms, slippage, midpoint_at_signal, best_bid_at_signal, best_ask_at_signal,
         metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        ctx.signalId, ctx.copyTargetId, ctx.mode, ctx.conditionId, ctx.side,
        ctx.traderPrice, ctx.traderTimestamp, ourPrice, capturedAt,
        latencyMs, slippage, midpoint, bestBid, bestAsk,
        JSON.stringify({ snapshot_id: snapRes.rows[0]?.id }),
      ]
    );
  } catch (err) {
    log.warn({ err: (err as Error).message, conditionId: ctx.conditionId }, 'Orderbook snapshot failed (non-fatal)');
  }
}

async function markSignalSkipped(proxyWallet: string, conditionId: string, timestamp: number, reason: string) {
  await query(
    `UPDATE copy_signals SET skip_reason = $1
     WHERE proxy_wallet = $2 AND condition_id = $3
     AND detected_at >= to_timestamp($4) - INTERVAL '1 second'
     AND detected_at <= to_timestamp($4) + INTERVAL '1 second'
     AND skip_reason IS NULL`,
    [reason, proxyWallet, conditionId, timestamp]
  );
}

async function markSignalActed(proxyWallet: string, conditionId: string, timestamp: number) {
  await query(
    `UPDATE copy_signals SET acted_on = true
     WHERE proxy_wallet = $1 AND condition_id = $2
     AND detected_at >= to_timestamp($3) - INTERVAL '1 second'
     AND detected_at <= to_timestamp($3) + INTERVAL '1 second'`,
    [proxyWallet, conditionId, timestamp]
  );
}

// ─── Partial Fill Deduplication ────────────────────────────────────

function deduplicatePartialFills(trades: PolyTrade[]): PolyTrade[] {
  // Group BUY trades by conditionId+outcome, keep only the first fill per group
  const firstBuyByMarket = new Map<string, PolyTrade>();

  for (const trade of trades) {
    if (trade.side !== 'BUY') continue;
    const key = `${trade.conditionId}:${trade.outcome}`;
    const existing = firstBuyByMarket.get(key);
    if (!existing || trade.timestamp < existing.timestamp) {
      firstBuyByMarket.set(key, trade);
    }
  }

  const deduped = Array.from(firstBuyByMarket.values());
  if (trades.length !== deduped.length) {
    log.debug({ raw: trades.length, deduped: deduped.length }, 'Deduped partial fills');
  }
  return deduped.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Exit Signal Processing ────────────────────────────────────────

/**
 * For every SELL trade by the target in the recent window, close any of
 * our open copies of the same market. We close FULLY on the first sell —
 * even a tiny partial sell signals "trader is taking off risk", which is
 * a strong exit cue for copy-trading.
 *
 * Uses copy_signals dedup so the same SELL doesn't trigger close twice
 * across cycles (e.g. if the close is in 'closing' state mid-cycle).
 */
async function processExitSignals(
  target: CopyTarget,
  engine: TradingEngine,
  recentTrades: PolyTrade[],
): Promise<void> {
  const sells = recentTrades.filter(t => t.side === 'SELL');
  if (sells.length === 0) return;

  // Get all our currently-open positions for this target. We'll match SELLs
  // by conditionId against this list. Note: a single SELL chunk by the
  // target should only close our position once — handled via hasSeenSignal.
  const openPositions = await engine.getOpenPositions();
  const ourOpenByCondition = new Map<string, typeof openPositions[number]>();
  for (const p of openPositions) {
    if (p.copyTargetId === target.id) {
      ourOpenByCondition.set(p.conditionId, p);
    }
  }
  if (ourOpenByCondition.size === 0) return;

  // Group SELLs by conditionId; we only need to act on the first SELL per
  // condition (subsequent SELLs are partial fills of the same exit).
  const firstSellByCondition = new Map<string, PolyTrade>();
  for (const sell of sells) {
    const existing = firstSellByCondition.get(sell.conditionId);
    if (!existing || sell.timestamp < existing.timestamp) {
      firstSellByCondition.set(sell.conditionId, sell);
    }
  }

  for (const [conditionId, sellTrade] of firstSellByCondition) {
    const ourPos = ourOpenByCondition.get(conditionId);
    if (!ourPos) continue;  // we don't have a copy of this market

    // Dedup across cycles: a SELL we already processed shouldn't trigger
    // another close attempt while the position is in 'closing' state.
    const seen = await hasSeenSignal(target.proxy_wallet, conditionId, sellTrade.timestamp);
    if (seen) continue;

    const market = await lookupMarket(conditionId);
    await recordSignal(target, sellTrade, market, 'exit_signal');

    log.info({
      target: target.display_name,
      conditionId: conditionId.substring(0, 16),
      positionId: ourPos.id,
      traderSellPrice: sellTrade.price,
      traderSellSize: sellTrade.size,
    }, 'Target exited — closing our copy');

    try {
      // Pass trader's sell price as fallback. live engine ignores it and
      // uses orderbook bestBid via FOK SELL.
      await engine.closePosition(ourPos.id, sellTrade.price, 'target_sold');
      await markSignalActed(target.proxy_wallet, conditionId, sellTrade.timestamp);
    } catch (err) {
      log.error({
        err: (err as Error).message,
        positionId: ourPos.id,
        conditionId,
      }, 'Failed to close on target exit');
      await markSignalSkipped(target.proxy_wallet, conditionId, sellTrade.timestamp, 'close_failed');
    }
  }
}

// ─── Signal Detection ──────────────────────────────────────────────

export async function detectSignals(
  target: CopyTarget,
  engine: TradingEngine,
  config: FilterConfig
): Promise<void> {
  // 1. Fetch recent trades (last 4h window via fetchTradesForUser)
  let allTrades: PolyTrade[];
  try {
    allTrades = await fetchTradesForUser(target.proxy_wallet);
  } catch (err) {
    log.error({ err: (err as Error).message, target: target.display_name }, 'Failed to fetch trades');
    return;
  }

  const windowAgo = Math.floor(Date.now() / 1000) - 7200; // 2 hours
  const recentTrades = allTrades.filter(t => t.timestamp >= windowAgo);

  // 2. EXIT SIGNALS — close our positions on any SELL by the target.
  // Per user spec: "we sell full as soon as their first partial sell happens"
  // i.e. any SELL by target on a market where we have an open copy = close.
  // Done before BUY processing so we free up capacity (max_positions, balance)
  // before evaluating entries.
  await processExitSignals(target, engine, recentTrades);

  // 3. Filter to recent BUY trades
  const recentBuys = recentTrades.filter(t => t.side === 'BUY');

  // 4. Deduplicate partial fills
  const dedupedTrades = deduplicatePartialFills(recentBuys);

  log.info({
    target: target.display_name,
    rawTrades: recentBuys.length,
    deduped: dedupedTrades.length,
  }, 'Processing signals');

  // 4. Pre-fetch trader positions ONCE for validation (paginated, gets all).
  // We do this BEFORE the per-trade loop so we either have the data, or we
  // hard-skip the entire target this cycle. Previous behavior was to fall
  // through on API failure ("allow if API fails"), which let us copy trades
  // the trader had already exited — caused major losses last time.
  let traderPositionIds: Set<string>;
  try {
    const positions = await fetchPositionsRaw(target.proxy_wallet);
    traderPositionIds = new Set(
      positions
        .filter(p => parseFloat(String(p.size ?? 0)) > 0)
        .map(p => String(p.conditionId ?? ''))
        .filter(Boolean)
    );
    log.debug({
      target: target.display_name,
      positionCount: traderPositionIds.size,
    }, 'Loaded trader positions for validation');
  } catch (err) {
    // Hard skip: if we can't validate the trader's current holdings, we don't
    // copy. Better to miss a signal than to copy an exited position.
    log.warn({
      err: (err as Error).message,
      target: target.display_name,
    }, 'Positions API failed — skipping all signals for this target this cycle');
    return;
  }

  for (const trade of dedupedTrades) {
    // Lookup market (needed both for the claim row and the filter chain).
    const market = await lookupMarket(trade.conditionId);

    // Atomically CLAIM this trade before doing anything else. The claim inserts
    // the copy_signals row under a per-trade advisory lock, so two overlapping
    // cycles (e.g. a PM2 restart briefly running two processes) can never both
    // pass dedup and double-execute. null ⇒ already claimed or claim failed —
    // skip without trading. Replaces the old check-then-act (hasSeenSignal +
    // recordSignal) race that let the same trade execute multiple times.
    const signalId = await claimTrade(target, trade, market, 'new_position');
    if (signalId === null) continue;

    // ─── Filter Chain ────────────────────────────────────────

    // (a) Market exists
    if (!market) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'not_tracked_market');
      continue;
    }

    // (b) Market not closed/resolved
    if (market.is_closed || market.is_resolved) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'market_closed');
      continue;
    }

    // (c) Convert detection — price too high = likely conversion
    if (trade.price >= config.convertPriceThreshold) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'convert_detected');
      continue;
    }

    // (d) Subcategory exclusion. NULL subcategory is treated as "Other" so
    // it gets caught by the default exclude list — otherwise NULL bypasses
    // the filter entirely (silent miss).
    const effectiveSubcategory = market.subcategory ?? 'Other';
    if (config.excludeSubcategories.includes(effectiveSubcategory)) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'excluded_subcategory');
      continue;
    }

    // (e) Max hours to resolution — only trade near-term events
    if (market.end_date) {
      const hoursLeft = (new Date(market.end_date).getTime() - Date.now()) / 3600000;
      if (hoursLeft > config.maxHoursToResolution) {
        await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'too_far_from_resolution');
        continue;
      }
      if (hoursLeft < 0) {
        await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'market_expired');
        continue;
      }
    }

    // (f) Max price
    if (trade.price > config.maxPrice) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'price_too_high');
      continue;
    }

    // (g) Max open positions
    const openCount = await engine.getOpenPositionCount();
    if (openCount >= config.maxPositions) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'max_positions');
      continue;
    }

    // (h) Daily loss limit
    const dailyLoss = await engine.getDailyRealizedLoss();
    if (dailyLoss >= config.dailyLossLimit) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'daily_loss_limit');
      continue;
    }

    // (i) Already open on this market
    const alreadyOpen = await engine.hasOpenPositionForMarket(target.id, trade.conditionId);
    if (alreadyOpen) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'already_open');
      continue;
    }

    // (j) Balance check
    const balance = await engine.getBalance();
    if (balance < config.positionSize) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'insufficient_balance');
      continue;
    }

    // (k) Position validation — confirm trader still holds this position.
    // Validation set was loaded at the top of this function; if loading
    // failed we already returned. So now we can trust the set absolutely.
    if (!traderPositionIds.has(trade.conditionId)) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'no_active_position');
      continue;
    }

    // ─── All filters passed — get entry price and open position ──

    const tokenId = trade.outcome === 'Yes' ? market.outcome_yes_token : market.outcome_no_token;
    if (!tokenId) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'no_token_id');
      continue;
    }

    // Get a guidance entry price. The live engine will derive the actual
    // execution price from the orderbook at order-submission time, but we
    // pass this through for the paper engine and as a sanity reference.
    let entryPrice = trade.price;
    try {
      const mid = await getMidpoint(tokenId);
      const parsedMid = parseFloat(mid.mid);
      // Sanity bounds: midpoint must be in (0.01, 0.99), finite, and not
      // wildly different from trader's fill price (>20% drift = stale or buggy).
      if (
        Number.isFinite(parsedMid) &&
        parsedMid > 0.01 && parsedMid < 0.99 &&
        Math.abs(parsedMid - trade.price) / Math.max(0.01, trade.price) < 0.20
      ) {
        entryPrice = parsedMid;
      } else {
        log.debug({
          tokenId, parsedMid, traderPrice: trade.price,
        }, 'Midpoint failed sanity check, falling back to trader price');
      }
    } catch { /* use trade price */ }

    // Final guard: extreme prices reject. Should never trigger given the
    // filter chain above (price_too_high catches >maxPrice), but defensive.
    if (!Number.isFinite(entryPrice) || entryPrice <= 0.01 || entryPrice >= 1.0) {
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'invalid_entry_price');
      continue;
    }

    const shares = config.positionSize / entryPrice;
    const side: 'YES' | 'NO' = trade.outcome === 'Yes' ? 'YES' : 'NO';

    try {
      await engine.openPosition({
        copyTargetId: target.id,
        marketId: market.market_id,
        eventId: market.event_id,
        conditionId: trade.conditionId,
        side,
        entryPrice,
        sizeUsd: config.positionSize,
        shares,
        metadata: {
          source_trade_price: trade.price,
          source_trade_size: trade.size,
          category: market.subcategory || target.category,
          target: target.display_name,
          token_id: tokenId,
          signal_id: signalId,
        },
      });

      await markSignalActed(target.proxy_wallet, trade.conditionId, trade.timestamp);

      // Capture orderbook + execution log — fire-and-forget telemetry.
      // Each call does ≥2 HTTP requests + 2 inserts; awaiting it would
      // throttle signal processing for no critical benefit. Errors are
      // logged inside captureSnapshotAndExecLog's catch block.
      void captureSnapshotAndExecLog(
        {
          marketId: market.market_id,
          conditionId: trade.conditionId,
          tokenId,
          outcome: trade.outcome,
          signalId,
          copyTargetId: target.id,
          mode: engine.mode,
          traderPrice: trade.price,
          traderTimestamp: trade.timestamp,
          side,
        },
        entryPrice
      ).catch(err => log.warn({ err: (err as Error).message }, 'Snapshot task rejected'));

      log.info({
        target: target.display_name,
        side: trade.outcome,
        price: entryPrice,
        size: config.positionSize,
        conditionId: trade.conditionId.substring(0, 10),
        mode: engine.mode,
      }, 'Position opened');
    } catch (err) {
      log.error({ err: (err as Error).message, target: target.display_name }, 'Failed to open position');
      await markSignalSkipped(target.proxy_wallet, trade.conditionId, trade.timestamp, 'order_failed');
    }
  }
}

// ─── Open Position Management ──────────────────────────────────────

/**
 * Check open positions for exit conditions, in priority order:
 *   1. Market resolved → close (redeem_pending for live, full close for paper)
 *   2. Market past end_date but unresolved → close as expired
 *   3. Target trader has exited (no longer holds the conditionId) → close
 *
 * Without #3, we'd hold our position until resolution even when the trader
 * has booked profits and walked away. Big alpha leak — copying entries
 * but not exits.
 */
export async function checkOpenPositions(engine: TradingEngine): Promise<void> {
  const positions = await engine.getOpenPositions();
  if (positions.length === 0) return;

  log.info({ count: positions.length, mode: engine.mode }, 'Checking open positions');

  // Group positions by copyTargetId so we fetch each target's positions once,
  // not once per position. A target may hold many of our copies.
  const byTarget = new Map<number, typeof positions>();
  for (const p of positions) {
    const arr = byTarget.get(p.copyTargetId) ?? [];
    arr.push(p);
    byTarget.set(p.copyTargetId, arr);
  }

  // Pre-fetch each target's current Polymarket positions in parallel.
  // Skip target-exit detection (but not market-resolution detection) for
  // any target whose API call fails — better to leave the position open
  // and re-check next cycle than to close based on incomplete data.
  const targetExitSets = new Map<number, Set<string> | null>();
  await Promise.all(Array.from(byTarget.keys()).map(async (targetId) => {
    const tgtRes = await query(
      `SELECT t.proxy_wallet FROM copy_targets ct
         JOIN traders t ON t.id = ct.trader_id
       WHERE ct.id = $1`,
      [targetId]
    );
    const proxyWallet = tgtRes.rows[0]?.proxy_wallet;
    if (!proxyWallet) {
      targetExitSets.set(targetId, null);
      return;
    }
    try {
      const traderPositions = await fetchPositionsRaw(proxyWallet);
      const heldConditionIds = new Set(
        traderPositions
          .filter(p => parseFloat(String(p.size ?? 0)) > 0)
          .map(p => String(p.conditionId ?? ''))
          .filter(Boolean)
      );
      targetExitSets.set(targetId, heldConditionIds);
    } catch (err) {
      log.warn({
        targetId, err: (err as Error).message,
      }, 'Failed to fetch target positions for exit check (will retry next cycle)');
      targetExitSets.set(targetId, null);
    }
  }));

  for (const pos of positions) {
    const market = await lookupMarket(pos.conditionId);
    if (!market) continue;

    // (1) Market resolved
    if (market.is_resolved || market.is_closed) {
      if (market.resolved_to) {
        const won = market.resolved_to.toUpperCase() === pos.side;
        await engine.closePosition(pos.id, won ? 1.0 : 0.0, 'resolved');
        log.info({
          positionId: pos.id, won, side: pos.side, resolved: market.resolved_to, mode: engine.mode,
        }, won ? 'Position won' : 'Position lost');
      } else {
        await engine.closePosition(pos.id, 0, 'expired');
        log.info({ positionId: pos.id, mode: engine.mode }, 'Position expired (no resolution)');
      }
      continue;
    }

    // (2) Past end_date but unresolved
    if (market.end_date && new Date(market.end_date) < new Date()) {
      await engine.closePosition(pos.id, pos.entryPrice, 'expired');
      log.info({ positionId: pos.id, mode: engine.mode }, 'Position expired (past end date)');
      continue;
    }

    // (3) Target has exited the position
    const heldByTarget = targetExitSets.get(pos.copyTargetId);
    if (heldByTarget !== null && heldByTarget !== undefined && !heldByTarget.has(pos.conditionId)) {
      // closePosition will fetch the current bestBid for the close price.
      // We pass entryPrice as fallback for paper engine; live ignores it.
      await engine.closePosition(pos.id, pos.entryPrice, 'target_exited');
      log.info({
        positionId: pos.id,
        conditionId: pos.conditionId.substring(0, 16),
        targetId: pos.copyTargetId,
        mode: engine.mode,
      }, 'Position closed: target has exited');
    }
  }
}
