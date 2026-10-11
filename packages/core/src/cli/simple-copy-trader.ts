/**
 * simple-copy-trader — Minimal standalone copy trader. No database.
 *
 * Polls a single target wallet's trades from Polymarket Data API and:
 *   - On a new BUY by target → places a FAK market BUY for our position size
 *   - On a new SELL by target → closes our matching open position via FAK SELL
 *
 * State (open positions, processed trade keys, totals) is kept in a local
 * JSON file. No DB dependency, no markets lookup — uses asset/conditionId
 * directly from each trade.
 *
 * Required .env:
 *   POLY_PRIVATE_KEY        EOA private key (signs orders)
 *   POLY_FUNDER             Proxy wallet address (holds USDC)
 *   POLY_API_KEY/SECRET/PASSPHRASE   CLOB API credentials
 *
 * Configurable .env (with sensible defaults):
 *   SIMPLE_TARGET_WALLET    Target wallet address to copy (REQUIRED)
 *   SIMPLE_POSITION_SIZE    USD per position (default 2)
 *   SIMPLE_MAX_POSITIONS    Max concurrent open positions (default 3)
 *   SIMPLE_MAX_PRICE        Max entry price (default 0.85)
 *   SIMPLE_MAX_SLIPPAGE     Most we'll pay above the target's own fill on a
 *                           copy BUY, in dollars (default 0.05; 0 = off)
 *   SIMPLE_MAX_SLIPPAGE_SELL  Same guard on exits (default 0 = off, so an exit
 *                           always executes)
 *   SIMPLE_MAX_PER_EVENT_USD_SPORTS  Combined cap per EVENT on ordinary sports
 *                           — tennis, cricket, football … (default 3). Esports
 *                           is exempt and keeps the per-market cap.
 *   SIMPLE_POLL_INTERVAL    Poll interval in ms (default 15000)
 *   SIMPLE_TRADE_WINDOW     Trade window in seconds (default 600 = 10min)
 *   SIMPLE_RECONCILE_INTERVAL_MS  Resolved-position settle interval (default 1800000 = 30min)
 *   SIMPLE_STATE_FILE       Path to state file (default ./simple-state.json)
 *
 * Usage:
 *   npx tsx packages/core/src/cli/simple-copy-trader.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { query, shutdown as shutdownDb } from '../db/pool.js';
// `fs`/`path` retained for SIMPLE_STATE_FILE compatibility logging only;
// no state I/O goes through them any more.
void fs;
void path;
// V2 client: required after Polymarket's April 28 2026 CLOB v2 migration.
// The legacy @polymarket/clob-client (5.8.x) returns order_version_mismatch
// on negRisk markets because it signs orders with the V1 EIP-712 schema.
import { ClobClient } from '@polymarket/clob-client-v2';
import { fetchOnChainWinner, fetchPayoutFraction } from '../services/ctf-resolution.js';
import {
  PgWatchStore, enqueueWatch, cancelWatches, processWatchlist, recoverInterrupted,
  fetchBestAsk, isPriceUnavailableReason,
  RECHECK_SCHEDULE_SEC, RECHECK_TTL_SEC,
  type BuyOutcome, type WatchEntry, type RecheckDeps,
} from '../services/price-recheck.js';
import { TraderQualityCache, type QualityConfig } from '../services/trader-quality.js';
import { Wallet } from 'ethers';

// ─── Config ────────────────────────────────────────────────────────

interface SizingTier {
  /** Applies when the target's stake is >= this many USD. */
  minUsd: number;
  /** What we buy, in USD, when this tier applies. */
  buyUsd: number;
}

/** Parse "0:1,25:2,3000:10" into an ascending tier ladder. Throws on a spec
 *  that yields no usable tiers — a silent fallback would size real orders
 *  wrongly and be very hard to notice. */
function parseSizingTiers(spec: string): SizingTier[] {
  const tiers = spec
    .split(',')
    .map((part) => {
      const [lo, buy] = part.split(':').map((x) => parseFloat(x.trim()));
      return { minUsd: lo, buyUsd: buy };
    })
    .filter((t) => Number.isFinite(t.minUsd) && Number.isFinite(t.buyUsd) && t.buyUsd > 0)
    .sort((a, b) => a.minUsd - b.minUsd);
  if (tiers.length === 0) {
    throw new Error(`SIMPLE_SIZING_TIERS unparseable: "${spec}" (expected "0:1,25:2,…")`);
  }
  return tiers;
}


const CONFIG = {
  // Comma-separated list of wallets to copy. Falls back to single SIMPLE_TARGET_WALLET
  // for backwards compatibility.
  targetWallets: (process.env.SIMPLE_TARGET_WALLETS || process.env.SIMPLE_TARGET_WALLET || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  positionSize: parseFloat(process.env.SIMPLE_POSITION_SIZE || '2'),
  maxPositions: parseInt(process.env.SIMPLE_MAX_POSITIONS || '3'),
  // Acceptable price band. Trades outside [minPrice, maxPrice] are skipped.
  // Default minPrice 0.10 filters out most longshot/conversion trades.
  minPrice: parseFloat(process.env.SIMPLE_MIN_PRICE || '0.10'),
  maxPrice: parseFloat(process.env.SIMPLE_MAX_PRICE || '0.85'),
  // The band above gates the TARGET's price; this gates OUR fill. Orders are
  // unpriced FAK market orders, so without a limit we take whatever the book
  // offers — on fast in-game markets that has been 13c worse than the target.
  // 0 (or >= 1) disables the guard and restores unpriced market orders.
  maxSlippage: parseFloat(process.env.SIMPLE_MAX_SLIPPAGE || '0.05'),
  // Exits are deliberately unguarded by default: a sell that doesn't fill is
  // never retried (the trade key is consumed), so a floor priced a few cents
  // too high would strand us in a position the target has already left.
  maxSlippageSell: parseFloat(process.env.SIMPLE_MAX_SLIPPAGE_SELL || '0'),

  // ── Price Re-Check Engine ────────────────────────────────────────
  // OFF by default: a restart must never silently change live trading
  // behaviour. Needs migration 007_price_watchlist.sql. When a copy BUY can't
  // be filled inside the price limit, the signal is parked for 10 minutes and
  // re-checked at T+30s / 2m / 5m / 8m / 10m instead of being dropped for good.
  // See services/price-recheck.ts.
  recheck: {
    enabled: process.env.SIMPLE_RECHECK_ENABLED === 'true',
    // Max slippage as a FRACTION of the target's price (0.12 = 12%). 0 = derive
    // it from SIMPLE_MAX_SLIPPAGE, so a re-check accepts exactly what the first
    // attempt would have.
    maxSlipRel: parseFloat(process.env.SIMPLE_RECHECK_MAX_SLIP_REL || '0'),
  },

  // ── Quality sizing (bigger bet for proven traders) ──────────────
  // OFF by default (a restart must not silently change bet sizes). When ON, a
  // target that is QUALIFIED gets `qualifiedBuyUsd` per trade instead of the
  // base size. Qualified = ROI >= minRoi (with >= minRoiPositions settled
  // positions) OR >= minWins winning positions with total $ won > total $ lost,
  // measured from the target's settled positions on Polymarket. See
  // services/trader-quality.ts. An unmeasurable trader stays at the base size.
  quality: {
    enabled: process.env.SIMPLE_QUALITY_SIZING === 'true',
    qualifiedBuyUsd: parseFloat(process.env.SIMPLE_QUALIFIED_BUY_USD || '10'),
    minRoi: parseFloat(process.env.SIMPLE_QUAL_MIN_ROI || '0.10'),
    minRoiPositions: parseInt(process.env.SIMPLE_QUAL_MIN_POSITIONS || '30', 10),
    minWins: parseInt(process.env.SIMPLE_QUAL_MIN_WINS || '50', 10),
    refreshMs: parseInt(process.env.SIMPLE_QUAL_REFRESH_MS || '21600000', 10),
  },

  // ── Shadow (paper) mode ─────────────────────────────────────────
  // SIMPLE_SHADOW_MODE=true: NO real orders are ever sent and no wallet keys are
  // needed. Every copy BUY/SELL is simulated against the live CLOB order book:
  // a buy walks the asks up to (target price + SIMPLE_MAX_SLIPPAGE) and "fills"
  // whatever liquidity sits inside that limit; a sell walks the bids. Positions
  // are written to live_positions (order_id 'shadow-…') so the dashboard works.
  // Use a SEPARATE database (DATABASE_URL) so shadow rows never mix with real ones.
  shadow: process.env.SIMPLE_SHADOW_MODE === 'true',

  // ── Mirror mode ──────────────────────────────────────────────────
  // OFF by default: a restart must never silently change live trading
  // behaviour. Set SIMPLE_MIRROR_MODE=true to enable.
  //
  //   off → first in-band BUY per market only; a target SELL closes the
  //         whole position (the original behaviour).
  //   on  → every BUY adds to a per-{target,market,outcome} position, sized
  //         in proportion to the target's own stake; every SELL closes the
  //         same FRACTION of our position that they sold of theirs.
  mirrorMode: process.env.SIMPLE_MIRROR_MODE === 'true',
  // Buy size comes from a TIER LADDER, not a multiplier. A flat ratio can't
  // express the intent: the bigger their stake, the smaller the fraction we
  // mirror ($10 → $1 is 10%, $40 → $2 is 5%, $3,500 → $10 is 0.3%).
  //
  // Format: "minStake:ourBuy,minStake:ourBuy,…" ascending by minStake. The
  // first entry is the floor (any stake below the second threshold), the last
  // is the ceiling. Edit SIMPLE_SIZING_TIERS to retune without touching code.
  //   <$300 $1 | 300 $2 | 500 $3 | 800 $4 | 1500 $5 | 3000 $6 | 5000 $7
  //   | 7000 $8 | 8000 $9 | 10000 $10
  // Thresholds are the trader's own STAKE in dollars (size x price), not the
  // share count, and each applies until the next one.
  sizingTiers: parseSizingTiers(
    process.env.SIMPLE_SIZING_TIERS
      || '0:1,300:2,500:3,800:4,1500:5,3000:6,5000:7,7000:8,8000:9,10000:10',
  ),
  // Hard ceiling, applied after the ladder. Belt and braces against a typo in
  // the tier string ever sizing us up beyond intent.
  maxBuyUsd: parseFloat(process.env.SIMPLE_MAX_BUY_USD || '10'),
  // Total cost basis allowed per {target, market}. Without this a target that
  // splits one order into five fills (quickql does exactly that) multiplies our
  // intended exposure. Set very high to disable.
  maxPerMarketUsd: parseFloat(process.env.SIMPLE_MAX_PER_MARKET_USD || '30'),
  // Ordinary sports (tennis, cricket, football …) get a tighter cap, applied
  // across the whole EVENT rather than each market: one fixture sells a
  // moneyline, an over/under and a handicap, and stacking every one of them is
  // three bets on the same result. Esports is deliberately exempt — Polymarket
  // files it under 'sports' too, so it is identified by its own tag and keeps
  // the per-market cap above.
  maxPerEventSportsUsd: parseFloat(process.env.SIMPLE_MAX_PER_EVENT_USD_SPORTS || '3'),

  pollIntervalMs: parseInt(process.env.SIMPLE_POLL_INTERVAL || '15000'),
  tradeWindowSec: parseInt(process.env.SIMPLE_TRADE_WINDOW || '600'),
  stateFile: process.env.SIMPLE_STATE_FILE || path.resolve(process.cwd(), 'simple-state.json'),
  privateKey: process.env.POLY_PRIVATE_KEY || '',
  funder: process.env.POLY_FUNDER || '',
  signatureType: parseInt(process.env.POLY_SIGNATURE_TYPE || '2'),
  apiKey: process.env.POLY_API_KEY || '',
  apiSecret: process.env.POLY_API_SECRET || '',
  apiPassphrase: process.env.POLY_PASSPHRASE || '',
  dataApiUrl: process.env.DATA_API_URL || 'https://data-api.polymarket.com',
  clobUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
};

// ─── State ─────────────────────────────────────────────────────────

interface OpenPos {
  dbId: number;               // live_positions.id — the row we add to / reduce
  positionKey: string;        // unique id for our records
  targetWallet: string;       // which target we copied to open this
  conditionId: string;
  tokenId: string;            // asset
  outcome: string;            // 'Yes' | 'No'
  side: 'BUY' | 'SELL';       // our side (always BUY for now since we mirror entries)
  shares: number;
  sizeUsd: number;
  entryPrice: number;
  orderId: string;
  openedAt: number;
  sourceTradeKey: string;     // the target's trade we copied
}

interface State {
  /** Trade keys we've already processed (won't act on again). */
  processedTradeKeys: string[];
  /** Currently-open positions (we're long these). */
  open: OpenPos[];
  /** Closed positions (history). */
  closed: Array<{
    positionKey: string;
    conditionId: string;
    tokenId: string;
    outcome: string;
    sizeUsd: number;
    shares: number;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    reason: 'target_sold' | 'manual';
    openedAt: number;
    closedAt: number;
    closeOrderId?: string;
  }>;
  /** Aggregated stats. */
  stats: {
    trades_processed: number;
    buys_attempted: number;
    buys_filled: number;
    sells_attempted: number;
    sells_filled: number;
    total_pnl: number;
  };
}

const initialState: State = {
  processedTradeKeys: [],
  open: [],
  closed: [],
  stats: {
    trades_processed: 0,
    buys_attempted: 0,
    buys_filled: 0,
    sells_attempted: 0,
    sells_filled: 0,
    total_pnl: 0,
  },
};

// ─── State persistence: PostgreSQL ───────────────────────────────────
//
// We used to live in a JSON file (simple-state.json) — atomic, easy to debug,
// and totally invisible to the dashboard. Now state lives in v3 tables:
//
//   open positions  ↔ live_positions (status='open')
//   closed positions↔ live_positions (status='closed')
//   processed keys  ↔ copy_signals   (acted_on tells us if we acted)
//   stats           ↔ computed via SELECT
//
// One-time migration: run scripts/v3-schema.sql + tsx migrate-simple-state.ts
// before running this bot for the first time on DB-backed state.
//
// The in-memory `State` is kept as a cache. We update memory AND the DB on
// every mutation, so a crash mid-cycle never leaves them out of sync — at
// worst the DB has a row the memory doesn't (the next loadState rebuild
// picks it up).

async function loadState(): Promise<State> {
  // Rebuild from DB. All three collections live in two tables.
  const [openRes, closedRes, statsRes, keysRes] = await Promise.all([
    query(
      `SELECT id, condition_id, side, outcome, entry_price, size_usd, shares,
              order_id, source_trade_key, opened_at, metadata
         FROM live_positions WHERE status='open' ORDER BY opened_at ASC`,
    ),
    query(
      `SELECT id, condition_id, side, outcome, entry_price, exit_price,
              size_usd, shares, pnl, opened_at, closed_at, metadata
         FROM live_positions WHERE status IN ('closed','redeem_pending') ORDER BY closed_at DESC`,
    ),
    query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='closed' THEN pnl ELSE 0 END), 0)::float AS total_pnl,
         COUNT(*) FILTER (WHERE status='closed')::int  AS sells_filled,
         COUNT(*) FILTER (WHERE status IN ('open','closed','redeem_pending'))::int AS buys_filled
       FROM live_positions`,
    ),
    // Last 5000 processed trade keys (rolling window). Loads the REAL
    // source_trade_key (same format as tradeKey()) so the in-memory pre-filter
    // actually matches — the atomic claimTrade() is the authoritative guard.
    query(
      `SELECT source_trade_key
         FROM copy_signals
        WHERE source_trade_key IS NOT NULL
        ORDER BY detected_at DESC LIMIT 5000`,
    ),
  ]);

  const open: OpenPos[] = openRes.rows.map(r => ({
    dbId: r.id,
    positionKey: r.metadata?.position_key || `${r.condition_id.slice(0, 8)}:db:${r.id}`,
    targetWallet: r.metadata?.target_wallet || 'unknown',
    conditionId: r.condition_id,
    tokenId: r.metadata?.token_id || '',
    outcome: r.outcome,
    side: r.side,
    shares: r.shares,
    sizeUsd: r.size_usd,
    entryPrice: r.entry_price,
    orderId: r.order_id || '',
    openedAt: Math.floor(new Date(r.opened_at).getTime() / 1000),
    sourceTradeKey: r.source_trade_key || '',
  }));

  const closed = closedRes.rows.map(r => ({
    positionKey: r.metadata?.position_key || `${r.condition_id.slice(0, 8)}:db:${r.id}`,
    conditionId: r.condition_id,
    tokenId: r.metadata?.token_id || '',
    outcome: r.outcome,
    sizeUsd: r.size_usd,
    shares: r.shares,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price ?? 0,
    pnl: r.pnl ?? 0,
    reason: (r.metadata?.close_reason ?? 'manual') as 'target_sold' | 'manual',
    openedAt: Math.floor(new Date(r.opened_at).getTime() / 1000),
    closedAt: r.closed_at ? Math.floor(new Date(r.closed_at).getTime() / 1000) : 0,
  }));

  // Use the stored source_trade_key directly — identical format to tradeKey(),
  // so the in-memory pre-filter membership check actually matches.
  const processedTradeKeys = keysRes.rows
    .map((r: { source_trade_key: string }) => r.source_trade_key)
    .filter(Boolean);

  const s = statsRes.rows[0] ?? {};
  return {
    processedTradeKeys,
    open,
    closed,
    stats: {
      trades_processed: processedTradeKeys.length,
      buys_attempted: s.buys_filled ?? 0,
      buys_filled: s.buys_filled ?? 0,
      sells_attempted: s.sells_filled ?? 0,
      sells_filled: s.sells_filled ?? 0,
      total_pnl: s.total_pnl ?? 0,
    },
  };
}

/** Kept as a stub for in-loop callers — DB writes happen inline now. */
function saveState(_state: State): void {
  // intentionally empty — all mutations persist to DB at the point of change
}

/** Record/finalize the outcome of a target's trade (audit log). Upserts on
 *  (proxy_wallet, source_trade_key) so the row claimed by claimTrade is updated
 *  in place rather than duplicated. */
/** True for a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}

async function recordSignal(args: {
  proxyWallet: string;
  conditionId: string;
  side: string;
  outcome: string;
  price: number;
  size: number;
  detectedAt: number;       // unix seconds
  actedOn: boolean;
  skipReason?: string;
  // Only the entry/BUY path sets this (after claimTrade). The exit/SELL path
  // leaves it null so a failed sell isn't filtered out and can retry next cycle.
  sourceTradeKey?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO copy_signals
         (proxy_wallet, condition_id, side, outcome, price, size,
          signal_type, detected_at, acted_on, skip_reason, source_trade_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'copy_target', to_timestamp($7), $8, $9, $10)
       -- Conflict on the index that actually collides. Keying on
       -- (proxy_wallet, source_trade_key) could never dedupe the exit path,
       -- which records sells with a NULL key: NULLs are distinct in a unique
       -- index, so the insert fell through and violated idx_copy_signals_dedup
       -- on every poll. The row claimTrade wrote carries the identical
       -- 7-tuple, so the entry path still updates the very same row.
       ON CONFLICT (proxy_wallet, condition_id, side, outcome, detected_at, price, size)
       DO UPDATE SET acted_on = EXCLUDED.acted_on, skip_reason = EXCLUDED.skip_reason`,
      [
        args.proxyWallet.toLowerCase(),
        args.conditionId,
        args.side,
        args.outcome,
        args.price,
        args.size,
        args.detectedAt,
        args.actedOn,
        args.skipReason ?? null,
        args.sourceTradeKey ?? null,
      ],
    );
  } catch (err) {
    // Net for the OTHER unique index: two fills sharing a trade key but
    // differing in size would collide on uq_copy_signals_wallet_trade_key,
    // which the clause above doesn't name. The signal is on record either way,
    // so swallow it rather than abort the cycle.
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

/**
 * Atomically CLAIM a target trade before acting on it. Inserts the copy_signals
 * row keyed on the real trade key under a unique constraint; ON CONFLICT DO
 * NOTHING means a second cycle / process / crash-retry that sees the same trade
 * loses the race and gets `false` — so a BUY is placed at most once, ever.
 *
 * Used only on the entry path: a failed/duplicate BUY must never repeat, whereas
 * the exit path intentionally retries failed SELLs (guarded by the open-position
 * check), so it is left unclaimed.
 *
 * Returns true if THIS call won the claim (caller may proceed to trade).
 */
async function claimTrade(t: PolyTrade, targetWallet: string): Promise<boolean> {
  try {
    const res = await query(
      `INSERT INTO copy_signals
         (proxy_wallet, condition_id, side, outcome, price, size,
          signal_type, detected_at, acted_on, source_trade_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'copy_target', to_timestamp($7), false, $8)
       ON CONFLICT (proxy_wallet, source_trade_key) DO NOTHING
       RETURNING id`,
      [
        targetWallet.toLowerCase(),
        t.conditionId, t.side, t.outcome, t.price, t.size, t.timestamp, tradeKey(t),
      ],
    );
    return res.rows.length > 0;
  } catch (err) {
    // A sibling fill identical on idx_copy_signals_dedup (wallet, condition,
    // side, outcome, second, price, size) but with a different tx — and thus a
    // different source_trade_key — slips past the ON CONFLICT above and violates
    // that other unique index. It's effectively the same signal (we cap one
    // position per market anyway), so treat it as "already claimed" — lose the
    // race and return false — instead of throwing and aborting the whole cycle.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Persist a freshly-opened position. Returns the inserted row id.
 *  Populates FKs (market_id, event_id, copy_target_id) opportunistically — if
 *  the corresponding rows exist they're linked; otherwise the FK stays NULL.
 *  The schema allows NULL there so the bot doesn't block on missing dimensions. */
async function insertOpenPosition(p: OpenPos): Promise<number> {
  const res = await query(
    `INSERT INTO live_positions
       (copy_target_id, market_id, event_id,
        condition_id, side, outcome, entry_price, size_usd, shares,
        status, opened_at, order_id, source_trade_key, metadata)
     VALUES (
       (SELECT id FROM copy_targets WHERE lower(proxy_wallet) = lower($1) LIMIT 1),
       (SELECT id FROM markets       WHERE condition_id = $2 LIMIT 1),
       (SELECT event_id FROM markets WHERE condition_id = $2 LIMIT 1),
       $2, $3, $4, $5, $6, $7,
       'open', to_timestamp($8), $9, $10, $11::jsonb)
     RETURNING id`,
    [
      p.targetWallet,
      p.conditionId,
      p.side,
      p.outcome,
      p.entryPrice,
      p.sizeUsd,
      p.shares,
      p.openedAt,
      p.orderId || null,
      p.sourceTradeKey,
      JSON.stringify({
        token_id: p.tokenId,
        target_wallet: p.targetWallet,
        position_key: p.positionKey,
      }),
    ],
  );
  return res.rows[0]?.id ?? 0;
}

/** Position sizing.
 *
 *  Mirror mode scales our stake with the target's own stake, clamped into
 *  [minBuyUsd, maxBuyUsd] and further limited by whatever room is left under
 *  the per-market cap. Returns 0 when the market is already full.
 *
 *  Off, it is the flat SIMPLE_POSITION_SIZE, exactly as before.
 */
function tierBuyUsd(targetUsd: number): number {
  // Highest tier whose threshold the stake clears; tiers are sorted ascending.
  let buy = CONFIG.sizingTiers[0].buyUsd;
  for (const tier of CONFIG.sizingTiers) {
    if (targetUsd >= tier.minUsd) buy = tier.buyUsd;
    else break;
  }
  return Math.min(buy, CONFIG.maxBuyUsd);
}

function buySizeUsd(
  targetUsd: number,
  alreadyCommitted: number,
  capUsd = CONFIG.maxPerMarketUsd,
  // Qualified-trader bet size (see CONFIG.quality). Replaces the flat size, or
  // the tier ladder in mirror mode (the per-market / per-event caps still apply).
  flatUsd?: number,
): number {
  if (!CONFIG.mirrorMode) return flatUsd ?? CONFIG.positionSize;
  const laddered = flatUsd ?? tierBuyUsd(targetUsd);
  const room = Math.max(0, capUsd - alreadyCommitted);
  // Never place an order below the floor tier — a $0.20 top-up is rejected by
  // the venue and just burns a cycle.
  const floor = CONFIG.sizingTiers[0].buyUsd;
  return room < floor ? 0 : Math.min(laddered, room);
}

/** Round a limit price to the venue's tick, always in the conservative
 *  direction (down for a buy ceiling, up for a sell floor). */
function toTick(price: number, tickSize: number | string, dir: 'down' | 'up'): number {
  const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
  if (!tick || !isFinite(tick) || tick <= 0) return price;
  // The 1e-9 absorbs binary-float dust: 0.29 / 0.01 is 28.999999999999996, which
  // a bare floor() turns into 28 ticks — a limit one tick LOWER than intended.
  const n = dir === 'down' ? Math.floor(price / tick + 1e-9) : Math.ceil(price / tick - 1e-9);
  const rounded = n * tick;
  // Clamp inside the tradeable range and undo binary-float dust.
  return Math.min(1 - tick, Math.max(tick, parseFloat(rounded.toFixed(6))));
}

/** Worst price we'll pay on a copy buy: the target's own fill plus the
 *  slippage allowance, never above the band ceiling. undefined = no limit. */
function buyLimitPrice(targetPrice: number): number | undefined {
  if (!(CONFIG.maxSlippage > 0) || CONFIG.maxSlippage >= 1) return undefined;
  return Math.min(CONFIG.maxPrice, targetPrice + CONFIG.maxSlippage);
}

/** Lowest price we'll accept on a copy sell. Off by default — see
 *  CONFIG.maxSlippageSell. The band ceiling is an entry rule, not applied here. */
function sellFloorPrice(targetPrice: number): number | undefined {
  if (!(CONFIG.maxSlippageSell > 0) || CONFIG.maxSlippageSell >= 1) return undefined;
  return Math.max(0, targetPrice - CONFIG.maxSlippageSell);
}

/** Is this an esports market? Polymarket files esports under category
 *  'sports', with the genre only in the subcategory and tags — so the broad
 *  category can never tell tennis from Counter-Strike. */
function isEsports(marketCats: Set<string>): boolean {
  return marketCats.has('esports');
}

/** Everything we have ever staked on this {target, EVENT} — every market on the
 *  fixture, and every position regardless of status. Cumulative on purpose: the
 *  cap is "no more than $N on this match", so money already spent and exited
 *  still counts against it. Falls back to the market when we have no event row.
 */
async function eventCostBasis(targetWallet: string, conditionId: string): Promise<number> {
  const r = await query(
    `SELECT COALESCE(SUM(lp.size_usd), 0)::real AS c
       FROM live_positions lp
       JOIN markets m ON m.condition_id = lp.condition_id
      WHERE lower(lp.metadata->>'target_wallet') = lower($1)
        AND (
          m.event_id = (SELECT event_id FROM markets WHERE condition_id = $2 AND event_id IS NOT NULL)
          OR lp.condition_id = $2
        )`,
    [targetWallet, conditionId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

/** Cost basis already committed to this {target, market}. */
async function marketCostBasis(targetWallet: string, conditionId: string): Promise<number> {
  const r = await query(
    `SELECT COALESCE(SUM(size_usd), 0)::real AS c
       FROM live_positions
      WHERE status = 'open'
        AND condition_id = $1
        AND (metadata->>'target_wallet') = $2`,
    [conditionId, targetWallet],
  );
  return Number(r.rows[0]?.c ?? 0);
}

/** The minimum tradeable size for a token, read from its live book. Falls back
 *  to 5 (the value Polymarket returns for active markets) if the book is
 *  unreachable. Used as the dust guard on partial exits. */
async function fetchMinOrderSize(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${CONFIG.clobUrl}/book?token_id=${tokenId}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return 5;
    const b = (await res.json()) as { min_order_size?: string };
    const v = parseFloat(String(b.min_order_size ?? ''));
    return Number.isFinite(v) && v > 0 ? v : 5;
  } catch {
    return 5;
  }
}

// ─── Target position model ─────────────────────────────────────────
//
// To sell the same FRACTION the target sold, we need their position size
// BEFORE that sell. Rather than maintain a running ledger (which needs
// exactly-once delta bookkeeping and drifts the moment one is missed), read
// their CURRENT position from the authoritative feed and add back what they
// just sold:
//
//     before = current_from_api + shares_they_just_sold
//
// If the indexer has already applied the sell — the normal case, since we read
// the trade from that same indexer — this is exact. If it hasn't, `current`
// still includes the sold shares, so we OVERSTATE `before` and sell a smaller
// fraction than we should. That errs toward holding, and the next sell
// corrects it. Stateless, and it cannot drift.

/** Target positions for the current cycle, keyed `conditionId:tokenId`. */
let targetPosCache = new Map<string, Map<string, number>>();

function resetTargetPosCache(): void {
  targetPosCache = new Map();
}

async function getTargetPositions(wallet: string): Promise<Map<string, number>> {
  const hit = targetPosCache.get(wallet);
  if (hit) return hit;

  const out = new Map<string, number>();
  try {
    const res = await fetch(
      `${CONFIG.dataApiUrl}/positions?user=${wallet}&limit=500&offset=0&sizeThreshold=0`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) {
      const poly = (await res.json()) as Array<Record<string, unknown>>;
      for (const p of poly ?? []) {
        const key = `${String(p.conditionId).toLowerCase()}:${String(p.asset)}`;
        out.set(key, parseFloat(String(p.size ?? 0)) || 0);
      }
    }
  } catch (err) {
    // An empty map means "unknown" — callers fall back to a full exit.
    console.warn(`[target-pos] fetch failed for ${wallet.slice(0, 10)}: ${(err as Error).message}`);
  }
  targetPosCache.set(wallet, out);
  return out;
}

/** The target's position size immediately BEFORE the given sell.
 *
 *  The /positions snapshot is taken once per cycle, so it already reflects
 *  EVERY sell in this window — not just the ones we have processed. Add back
 *  `pendingShares`: the sells on this token still ahead of us, inclusive of
 *  this one. Without that, the first of several sells understates `before` and
 *  oversells (100 held, sells of 30 then 20: naive gives 30/80 = 37% instead
 *  of the correct 30/100 = 30%).
 *
 *  Returns 0 when unknown, which callers treat as "sell everything". */
async function targetSharesBeforeSell(
  wallet: string, t: PolyTrade, pendingShares: number,
): Promise<number> {
  const positions = await getTargetPositions(wallet);
  if (positions.size === 0) return 0;
  const current = positions.get(`${t.conditionId.toLowerCase()}:${t.asset}`) ?? 0;
  return current + Math.max(pendingShares, t.size);
}

/** Add a subsequent fill to an existing open position (scale-in).
 *
 *  size_usd is CUMULATIVE capital deployed and never shrinks — the dashboard
 *  reads SUM(size_usd) as "invested" for its ROI denominator, so decrementing
 *  it on exit would report closed positions as costing nothing.
 *
 *  The cost basis of the shares still HELD is entry_price * shares, which is
 *  why entry_price is averaged over current holdings rather than derived from
 *  size_usd (the two diverge as soon as a partial exit happens). */
async function addToPosition(
  positionId: number, addShares: number, addUsd: number,
): Promise<void> {
  await query(
    `UPDATE live_positions
        SET shares      = shares + $2,
            size_usd    = size_usd + $3,
            entry_price = CASE WHEN (shares + $2) > 0
                               THEN ((entry_price * shares) + $3) / (shares + $2)
                               ELSE entry_price END
      WHERE id = $1 AND status = 'open'`,
    [positionId, addShares, addUsd],
  );
}

/** Reduce a position by a partial exit. Closes it when nothing is left.
 *  `pnl` accumulates realized P/L across every tranche. */
async function reducePosition(args: {
  positionId: number;
  soldShares: number;
  proceedsUsd: number;
  costOfSold: number;
  exitPrice: number;
  closing: boolean;
  reason: string;
  closeOrderId?: string;
}): Promise<void> {
  await query(
    `UPDATE live_positions
        SET shares       = GREATEST(shares - $2, 0),
            proceeds_usd = proceeds_usd + $4,
            pnl          = COALESCE(pnl, 0) + ($4 - $3),
            exit_price   = $5,
            exit_count   = exit_count + 1,
            status       = CASE WHEN $6 THEN 'closed' ELSE 'open' END,
            closed_at    = CASE WHEN $6 THEN NOW() ELSE closed_at END,
            metadata     = metadata || jsonb_build_object(
                             'close_reason', $7::text,
                             'close_order_id', $8::text)
      WHERE id = $1 AND status = 'open'`,
    [args.positionId, args.soldShares, args.costOfSold, args.proceedsUsd,
      args.exitPrice, args.closing, args.reason, args.closeOrderId ?? null],
  );
}

/** Every label a market can be matched on: category, subcategory and tags,
 *  lowercased. Polymarket files esports under category 'sports' (tag[0] is
 *  always "Sports") with the real genre in subcategory/tags — matching on
 *  category alone made an 'esports' scope unmatchable.
 *
 *  Falls back to CLOB if the market isn't in our DB yet, in which case it
 *  upserts a minimal markets + events row so subsequent lookups are local.
 *  Empty set = we genuinely couldn't determine it (rare).
 */
async function fetchMarketCategories(conditionId: string): Promise<Set<string>> {
  const labels = (...vals: (string | null | undefined)[]) =>
    new Set(vals.filter(Boolean).map(v => String(v).trim().toLowerCase()).filter(Boolean));

  // 1. Try local DB first — cheap.
  const local = await query(
    `SELECT e.category, e.subcategory, e.tags
       FROM markets m
       LEFT JOIN events e ON m.event_id = e.id
      WHERE m.condition_id = $1
      LIMIT 1`,
    [conditionId],
  );
  const row = local.rows[0];
  if (row?.category) {
    return labels(row.category, row.subcategory, ...((row.tags as string[]) ?? []));
  }

  // 2. Not in DB — fetch from CLOB. The first tag is the canonical category.
  try {
    const res = await fetch(`${CONFIG.clobUrl}/markets/${conditionId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return new Set();
    interface ClobMarket {
      question?: string;
      market_slug?: string;
      tags?: string[];
      closed?: boolean;
      neg_risk?: boolean;
      end_date_iso?: string;
      game_start_time?: string;
      tokens?: { token_id: string; outcome: string; winner: boolean }[];
    }
    const m = (await res.json()) as ClobMarket;
    const category = (m.tags?.[0] ?? '').toLowerCase() || null;
    const all = labels(category, m.tags?.[1], ...(m.tags ?? []));

    // Best-effort: upsert a minimal markets + events pair so future trades
    // on this market don't have to round-trip CLOB.
    if (m.question && category) {
      const syntheticEventIdRes = await query(
        `SELECT COALESCE(MIN(poly_event_id), 0) - 1 AS next_id FROM events WHERE poly_event_id < 0`,
      );
      const polyEventId = syntheticEventIdRes.rows[0]?.next_id ?? -1;
      const evRes = await query(
        `INSERT INTO events
           (poly_event_id, title, slug, category, subcategory, end_date, tags, is_resolved)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
         RETURNING id`,
        [
          polyEventId,
          m.question.slice(0, 500),
          m.market_slug ?? null,
          category,
          m.tags?.[1]?.toLowerCase() ?? null,
          m.end_date_iso ?? null,
          m.tags ?? [],
          !!m.closed,
        ],
      );
      const eventId = evRes.rows[0]?.id ?? null;
      const winnerOutcome = m.tokens?.find(t => t.winner)?.outcome ?? null;
      await query(
        `INSERT INTO markets
           (event_id, condition_id, question, slug, is_closed, resolved_to,
            outcome_yes_token, outcome_no_token, neg_risk, end_date, start_date,
            fetched_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, NOW(), NOW())
         ON CONFLICT (condition_id) DO UPDATE SET
           event_id  = COALESCE(markets.event_id, EXCLUDED.event_id),
           question  = EXCLUDED.question,
           fetched_at= NOW()`,
        [
          eventId,
          conditionId,
          m.question,
          m.market_slug ?? null,
          !!m.closed,
          winnerOutcome,
          m.tokens?.[0]?.token_id ?? null,
          m.tokens?.[1]?.token_id ?? null,
          !!m.neg_risk,
          m.end_date_iso ?? null,
          m.game_start_time ?? null,
        ],
      );
    }
    return all;
  } catch (err) {
    console.warn(`[category-lookup] CLOB fetch failed for ${conditionId.slice(0, 14)}..: ${(err as Error).message}`);
    return new Set();
  }
}

/** Resolve the allowed categories for a target wallet. Reads copy_targets
 *  rows where proxy_wallet matches AND status='active' and unions the
 *  category fields (comma-split). Multiple rows can exist if a wallet was
 *  added under different category tags. */
const targetCategoryCache = new Map<string, Set<string>>();
/** Cleared once per cycle so a category change made in the dashboard takes
 *  effect on the next poll instead of needing a restart. */
function resetTargetCategoryCache(): void {
  targetCategoryCache.clear();
}
async function getAllowedCategories(targetWallet: string): Promise<Set<string>> {
  const cached = targetCategoryCache.get(targetWallet);
  if (cached) return cached;
  const r = await query(
    `SELECT category FROM copy_targets
      WHERE lower(proxy_wallet) = lower($1) AND status = 'active'`,
    [targetWallet],
  );
  const set = new Set<string>();
  for (const row of r.rows) {
    for (const c of String(row.category ?? '').split(',')) {
      const v = c.trim().toLowerCase();
      if (v) set.add(v);
    }
  }
  targetCategoryCache.set(targetWallet, set);
  return set;
}

/** Close an open position. Looks up by condition_id + position_key. */
async function closeOpenPosition(args: {
  conditionId: string;
  positionKey: string;
  exitPrice: number;
  pnl: number;
  closeOrderId?: string;
  reason: string;
}): Promise<void> {
  await query(
    `UPDATE live_positions
        SET status='closed',
            closed_at = NOW(),
            exit_price = $1,
            pnl = $2,
            metadata = metadata || jsonb_build_object('close_reason', $3::text, 'close_order_id', $4::text)
      WHERE status='open'
        AND condition_id = $5
        AND (metadata->>'position_key') = $6`,
    [args.exitPrice, args.pnl, args.reason, args.closeOrderId ?? null, args.conditionId, args.positionKey],
  );
}

// ─── Polymarket Data API ───────────────────────────────────────────

interface PolyTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  outcome: string;
  transactionHash?: string;
}

async function fetchUserTrades(wallet: string, sinceTs: number): Promise<PolyTrade[]> {
  const url = `${CONFIG.dataApiUrl}/trades?user=${wallet}&limit=1000&offset=0`;
  // The Data API regularly returns 408 / times out / drops the connection
  // ('terminated'). A single attempt meant any hiccup dropped that whole poll,
  // and with the 600s window a run of hiccups silently misses trades. Retry
  // transient failures (408/429/5xx + network/timeout) with short backoff;
  // fail fast on real errors (4xx other than 408/429).
  const maxAttempts = 3;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    } catch (err) {
      // AbortSignal timeout or network failure ('terminated') — transient.
      lastErr = err as Error;
    }

    if (res) {
      if (res.ok) {
        const trades = (await res.json()) as PolyTrade[];
        // API returns newest-first; keep only trades inside the poll window.
        return trades.filter((t) => t.timestamp >= sinceTs);
      }
      // Only 408/429/5xx are worth retrying; anything else is a hard error.
      if (!(res.status === 408 || res.status === 429 || res.status >= 500)) {
        throw new Error(`Data API ${res.status}`);
      }
      lastErr = new Error(`Data API ${res.status}`);
    }

    if (attempt < maxAttempts) {
      const delay = Math.min(500 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error('Data API fetch failed');
}

function tradeKey(t: PolyTrade): string {
  // Stable ID for a single fill. transactionHash + asset + price discriminates
  // partial fills in same tx; timestamp is fallback when txHash is missing.
  return `${t.transactionHash || 'no_tx'}:${t.asset}:${t.price}:${t.size}:${t.timestamp}`;
}

// ─── CLOB Client ───────────────────────────────────────────────────

let _client: ClobClient | null = null;
function getClobClient(): ClobClient {
  // Hard guarantee: shadow mode can never construct a trading client.
  if (CONFIG.shadow) throw new Error('shadow mode: CLOB trading client is disabled');
  if (_client) return _client;
  if (!CONFIG.privateKey) throw new Error('POLY_PRIVATE_KEY not set');
  if (!CONFIG.funder) throw new Error('POLY_FUNDER not set');
  if (!CONFIG.apiKey) throw new Error('POLY_API_KEY not set (run test-clob.ts first to derive)');

  const wallet = new Wallet(CONFIG.privateKey);
  const creds = {
    key: CONFIG.apiKey,
    secret: CONFIG.apiSecret,
    passphrase: CONFIG.apiPassphrase,
  };
  // V2 constructor takes an options object (not positional args).
  _client = new ClobClient({
    host: CONFIG.clobUrl,
    chain: 137 as any,
    signer: wallet as any,
    creds,
    signatureType: CONFIG.signatureType as any, // 2 = POLY_GNOSIS_SAFE
    funderAddress: CONFIG.funder,
  });
  console.log(`[init] CLOB-V2 client ready  EOA=${wallet.address}  funder=${CONFIG.funder}`);
  return _client;
}

interface FillResult {
  orderId?: string;
  shares: number;
  usdSpent?: number;
  usdReceived?: number;
  fillPrice: number;
  failed: boolean;
  reason?: string;
}

/**
 * Resolve a marketable order that came back `delayed` (or `live`/`matching`).
 *
 * Polymarket holds marketable orders briefly before matching — ~1s by default,
 * ~3s on sports markets — and returns status `delayed` during that hold. The
 * order is ACCEPTED, not failed, and resolves to matched/unmatched after the
 * hold; it also can't be cancelled while delayed. A FOK never rests, so it
 * either fully fills or is killed. We poll the order record (size_matched) and,
 * once it leaves the book, confirm via the taker trade. Returns the matched
 * share count + avg fill price, or null if it genuinely didn't fill.
 *
 * This avoids the desync where the bot recorded `buy_failed:..._delayed` while
 * the order actually filled on-chain — leaving an untracked live position.
 */
/** Trim a reported fill to the order that produced it. Applied to whatever
 *  resolveDelayedFill returns, so no reporting path can exceed what we sent. */
function boundFill(
  fill: { shares: number; price: number },
  side: 'BUY' | 'SELL',
  ordered: number,
): { shares: number; price: number } {
  const cap = side === 'BUY' ? (fill.price > 0 ? ordered / fill.price : fill.shares) : ordered;
  if (!(cap > 0) || !(fill.shares > cap * 1.02)) return fill;
  console.warn(`  [delayed] reported ${fill.shares.toFixed(4)} sh — more than the order allows; using ${cap.toFixed(4)}`);
  return { shares: cap, price: fill.price };
}

async function resolveDelayedFill(
  orderID: string,
  tokenId: string,
  conditionId: string,
  side: 'BUY' | 'SELL',
  placedAtSec: number,
  // What we actually sent: USD for a buy, shares for a sell. A fill can never
  // exceed it, so it bounds anything the fill sources report.
  ordered: number,
): Promise<{ shares: number; price: number } | null> {
  const client = getClobClient();
  const DEAD = new Set(['UNMATCHED', 'CANCELED', 'CANCELLED', 'KILLED', 'EXPIRED', 'REJECTED']);
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    // PRIMARY: the Data API shows our funder's ACTUAL fill on this market — the
    // same source we read the leaders' trades from, so it's reliable (the CLOB
    // getOrder/getTrades calls were silently failing and missing real fills).
    // Match on token + side + a timestamp at/after when we placed the order, so
    // an earlier fill on the same market isn't mistaken for this one.
    try {
      // Use the plain /trades?user= call (the same one fetchUserTrades uses and
      // we know works) and filter client-side — avoids any ambiguity about the
      // &market= param. Our funder's fill on this token appears here within secs.
      const url = `${CONFIG.dataApiUrl}/trades?user=${CONFIG.funder}&limit=500&offset=0`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const trades = (await res.json()) as any[];
        const mine = (trades || []).filter(
          (t) =>
            String(t.conditionId) === conditionId &&
            String(t.asset) === tokenId &&
            String(t.side).toUpperCase() === side &&
            parseInt(String(t.timestamp ?? 0)) >= placedAtSec - 10,
        );
        if (mine.length > 0) {
          let shares = 0;
          let usd = 0;
          for (const t of mine) {
            const sz = parseFloat(t.size ?? '0');
            const px = parseFloat(t.price ?? '0');
            shares += sz;
            usd += sz * px;
          }
          if (shares > 0) {
            const price = usd / shares;
            // /trades reports the whole matched trade, not our slice of it, so a
            // small taker order that hits a large resting one comes back with the
            // counterparty's size. Believe the price, bound the size by the order.
            const cap = side === 'BUY' ? (price > 0 ? ordered / price : shares) : ordered;
            if (shares > cap * 1.02) {
              console.log(`  [delayed] Data API reported ${shares.toFixed(4)} sh — more than we ordered; using ${cap.toFixed(4)}`);
              shares = cap;
            }
            console.log(`  [delayed] fill confirmed via Data API: ${shares.toFixed(4)} sh @ $${price.toFixed(4)}`);
            return boundFill({ shares, price }, side, ordered);
          }
        }
      }
    } catch (e) {
      console.log(`  [delayed] dataapi poll err: ${(e as Error).message}`);
    }

    // PRIMARY: the CLOB order record reflects the match immediately (the Data
    // API indexer lags). getOrder is flaky — it returns null on some polls — but
    // when it returns the order it carries the authoritative fill: status
    // MATCHED with size_matched (shares) and price. Use that directly.
    try {
      const o: any = await (client as any).getOrder(orderID);
      if (o) {
        const matched = parseFloat(o.size_matched ?? '0');
        const price = parseFloat(o.price ?? '0');
        const st = String(o.status ?? '').toUpperCase();
        if (matched > 0 && price > 0) {
          console.log(`  [delayed] fill confirmed via getOrder: ${matched.toFixed(4)} sh @ $${price.toFixed(4)} (${st})`);
          return boundFill({ shares: matched, price }, side, ordered);
        }
        if (DEAD.has(st)) return null; // explicitly killed/expired with no fill
      }
    } catch (e) {
      console.log(`  [delayed] getOrder err: ${(e as Error).message}`);
    }
  }
  console.log(`  [delayed] NO fill confirmed within 20s for order ${orderID.slice(0, 14)}… (token ${tokenId.slice(0, 10)}…)`);
  return null; // timed out without a definitive fill
}

/** The venue's own words for why an order didn't go through.
 *
 *  clob-client-v2 hands API errors back as a plain `{status: 400, error: "…"}`
 *  object rather than throwing, and `error` is the only field carrying the
 *  reason — checking `errorMsg` alone reduced every rejection to an opaque
 *  "unexpected_status_400"/"delayed_no_fill_400". */
function orderErrorReason(resp: any): string | null {
  const msg = resp?.errorMsg ?? resp?.error ?? resp?.message;
  if (msg) {
    const text = String(typeof msg === 'string' ? msg : JSON.stringify(msg));
    // The venue's phrasing for "your limit was below the book" is a paragraph
    // about FAK semantics. Say the thing that is actually actionable.
    if (text.includes('no orders found to match')) return 'no_liquidity_at_our_price';
    return text.slice(0, 180);
  }
  // A numeric status is an HTTP code, not an order state ('matched'/'delayed').
  if (typeof resp?.status === 'number') return `http_${resp.status}`;
  return null;
}


// ─── Shadow (paper) execution ───────────────────────────────────────
//
// Simulates the FAK buy / FOK sell the live path would send, using the real
// order book. No signing, no network write — read-only GET /book.

interface BookLevel { price: number; size: number }

async function fetchBook(tokenId: string): Promise<{ asks: BookLevel[]; bids: BookLevel[]; tick: number } | null> {
  try {
    const res = await fetch(`${CONFIG.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as { asks?: any[]; bids?: any[]; tick_size?: string };
    const norm = (a: any[] | undefined): BookLevel[] =>
      (a ?? [])
        .map(x => ({ price: parseFloat(String(x?.price)), size: parseFloat(String(x?.size)) }))
        .filter(x => x.price > 0 && x.price <= 1 && x.size > 0);
    return {
      asks: norm(b.asks).sort((x, y) => x.price - y.price),   // cheapest first
      bids: norm(b.bids).sort((x, y) => y.price - x.price),   // best bid first
      tick: parseFloat(String(b.tick_size ?? '0.01')) || 0.01,
    };
  } catch {
    return null;
  }
}

async function shadowBuy(tokenId: string, sizeUsd: number, limitPrice?: number): Promise<FillResult> {
  if (!(sizeUsd > 0)) return { shares: 0, fillPrice: 0, failed: true, reason: 'zero_size' };
  const book = await fetchBook(tokenId);
  if (!book) return { shares: 0, fillPrice: 0, failed: true, reason: 'shadow_book_unavailable' };
  const limit = limitPrice !== undefined ? toTick(limitPrice, book.tick, 'down') : undefined;
  if (limit !== undefined) console.log(`  [shadow] BUY limit $${limit} (tick ${book.tick})`);

  // Same wording the live path produces, so the re-check engine treats it identically.
  if (book.asks.length === 0) return { shares: 0, fillPrice: 0, failed: true, reason: 'no_liquidity_at_our_price' };

  let remaining = sizeUsd;
  let shares = 0;
  let spent = 0;
  for (const lvl of book.asks) {
    if (limit !== undefined && lvl.price > limit + 1e-9) break;
    if (remaining <= 1e-9) break;
    const take = Math.min(lvl.size, remaining / lvl.price);
    shares += take;
    spent += take * lvl.price;
    remaining -= take * lvl.price;
  }
  if (shares <= 0 || spent <= 0) {
    console.log(`  [shadow] best ask ${book.asks[0].price} is above our limit ${limit ?? 'none'} → no fill`);
    return { shares: 0, fillPrice: 0, failed: true, reason: limit !== undefined ? `above_limit_${limit}` : 'unmatched' };
  }
  const fillPrice = spent / shares;
  console.log(`  [shadow] BUY filled ${shares.toFixed(4)} sh @ avg ${fillPrice.toFixed(4)} ($${spent.toFixed(4)} of $${sizeUsd}; best ask ${book.asks[0].price})`);
  return { orderId: `shadow-${Date.now()}`, shares, usdSpent: spent, fillPrice, failed: false };
}

async function shadowSell(tokenId: string, shares: number, floorPrice?: number): Promise<FillResult> {
  if (!(shares >= 0.01)) return { shares: 0, fillPrice: 0, failed: true, reason: 'nothing_left_to_sell' };
  const book = await fetchBook(tokenId);
  if (!book) return { shares: 0, fillPrice: 0, failed: true, reason: 'shadow_book_unavailable' };
  const floor = floorPrice !== undefined ? toTick(floorPrice, book.tick, 'up') : 0;

  // FOK semantics, like the live sell: all of it inside the floor, or nothing.
  let remaining = shares;
  let got = 0;
  for (const lvl of book.bids) {
    if (lvl.price < floor - 1e-9) break;
    if (remaining <= 1e-9) break;
    const take = Math.min(lvl.size, remaining);
    got += take * lvl.price;
    remaining -= take;
  }
  if (remaining > 1e-6) {
    return { shares: 0, fillPrice: 0, failed: true, reason: floorPrice !== undefined ? `below_floor_${floor}` : 'unmatched' };
  }
  const fillPrice = got / shares;
  console.log(`  [shadow] SELL filled ${shares.toFixed(4)} sh @ avg ${fillPrice.toFixed(4)} (best bid ${book.bids[0]?.price})`);
  return { orderId: `shadow-${Date.now()}`, shares, usdReceived: got, fillPrice, failed: false };
}

async function placeMarketBuy(
  tokenId: string,
  sizeUsd: number,
  conditionId: string,
  limitPrice?: number,
): Promise<FillResult> {
  if (!(sizeUsd > 0)) {
    return { shares: 0, fillPrice: 0, failed: true, reason: 'zero_size' };
  }
  if (CONFIG.shadow) return shadowBuy(tokenId, sizeUsd, limitPrice);
  const client = getClobClient();
  const placedAtSec = Math.floor(Date.now() / 1000);
  try {
    // Pre-fetch market metadata so the SDK uses the right order version.
    // Without these, we get HTTP 400 order_version_mismatch on certain markets
    // (esp. neg-risk and non-default-tick-size markets).
    const [tickSize, negRisk] = await Promise.all([
      (client as any).getTickSize(tokenId),
      (client as any).getNegRisk(tokenId),
    ]);
    const options = { tickSize, negRisk };
    // A market order with no `price` takes the book at any level. Passing the
    // limit turns it into "take everything up to this price, kill the rest" —
    // the FAK then simply doesn't fill instead of filling badly.
    const limit = limitPrice !== undefined ? toTick(limitPrice, tickSize, 'down') : undefined;
    if (limit !== undefined) console.log(`  BUY limit $${limit} (tick ${tickSize})`);

    // FAK = fill-and-kill (IOC): take whatever liquidity is available right now,
    // cancel the rest. FOK (fill-or-kill) was getting killed wholesale by the ~3s
    // sports matching hold — if the book moved during the hold, the all-or-
    // nothing FOK matched nothing. FAK takes the partial fill instead.
    let resp: any;
    try {
      resp = await client.createAndPostMarketOrder(
        { tokenID: tokenId, side: 'BUY' as any, amount: sizeUsd, ...(limit !== undefined && { price: limit }) },
        options,
        'FAK' as any,
      );
    } catch (innerErr: any) {
      // SDK may throw with raw axios error containing the full server reply.
      const data = innerErr?.response?.data;
      console.log('  CLOB BUY error:', JSON.stringify({
        message: innerErr?.message,
        status: innerErr?.response?.status,
        data: data,
        tickSize, negRisk, tokenId,
      }));
      return { shares: 0, fillPrice: 0, failed: true, reason: String(data?.error || innerErr?.message || 'unknown_error').slice(0, 180) };
    }
    console.log('  CLOB BUY response:', JSON.stringify({ resp, tickSize, negRisk }));

    const buyErr = orderErrorReason(resp);
    if (resp?.success === false || buyErr) {
      return { shares: 0, fillPrice: 0, failed: true, reason: buyErr ?? 'rejected' };
    }
    if (resp?.status === 'unmatched') {
      return { shares: 0, fillPrice: 0, failed: true, reason: limit !== undefined ? `above_limit_${limit}` : 'unmatched' };
    }
    if (resp?.status !== 'matched') {
      // `delayed`/`live` = Polymarket's pre-match hold (≈3s on sports), NOT a
      // failure. Poll for the real outcome instead of bailing. Do NOT cancel:
      // delayed orders can't be cancelled, and a FOK self-kills if it won't fill.
      if (resp?.orderID) {
        const raw = await resolveDelayedFill(resp.orderID, tokenId, conditionId, 'BUY', placedAtSec, sizeUsd);
        const fill = raw ? boundFill(raw, 'BUY', sizeUsd) : null;
        if (fill && fill.shares > 0) {
          return {
            orderId: resp.orderID,
            shares: fill.shares,
            usdSpent: fill.shares * fill.price,
            fillPrice: fill.price,
            failed: false,
          };
        }
        return { shares: 0, fillPrice: 0, failed: true, reason: `delayed_no_fill_${resp?.status}` };
      }
      return { shares: 0, fillPrice: 0, failed: true, reason: `unexpected_status_${resp?.status}` };
    }

    const taking = parseFloat(resp.takingAmount ?? '0'); // shares received
    const making = parseFloat(resp.makingAmount ?? '0'); // USDC spent
    if (taking <= 0 || making <= 0) {
      return { shares: 0, fillPrice: 0, failed: true, reason: 'zero_fill' };
    }
    if (making > sizeUsd * 1.02) {
      // We can't spend more than we sent; a larger number is the venue
      // describing the whole match, not our slice of it.
      console.warn(`  BUY reported $${making} spent on a $${sizeUsd} order — recording $${sizeUsd}`);
      const px = making / taking;
      return { orderId: resp.orderID, shares: px > 0 ? sizeUsd / px : taking, usdSpent: sizeUsd, fillPrice: px, failed: false };
    }
    return {
      orderId: resp.orderID,
      shares: taking,
      usdSpent: making,
      fillPrice: making / taking,
      failed: false,
    };
  } catch (err) {
    return { shares: 0, fillPrice: 0, failed: true, reason: (err as Error).message };
  }
}

async function placeMarketSell(
  tokenId: string,
  shares: number,
  conditionId: string,
  floorPrice?: number,
): Promise<FillResult> {
  // The SDK rounds size to 2 decimals, so dust left by a partial exit rounds to
  // a zero-share order and comes back "invalid maker amount". Hold it instead —
  // the reconciler settles it at resolution.
  if (!(shares >= 0.01)) {
    return { shares: 0, fillPrice: 0, failed: true, reason: 'nothing_left_to_sell' };
  }
  if (CONFIG.shadow) return shadowSell(tokenId, shares, floorPrice);
  const client = getClobClient();
  const placedAtSec = Math.floor(Date.now() / 1000);
  try {
    const [tickSize, negRisk] = await Promise.all([
      (client as any).getTickSize(tokenId),
      (client as any).getNegRisk(tokenId),
    ]);
    const options = { tickSize, negRisk };
    // ALWAYS send a price. Left to itself the SDK prices the order off the best
    // bid and then rejects its own number against the venue's [tick, 1-tick]
    // band — a token bid at 0.999 on a 0.01-tick market can never be sold, and
    // the exit fails without an order ever being placed. A limit still matches
    // at the maker's price, so a low one costs us nothing: it means "take
    // whatever the book pays", exactly what a market sell should do.
    const tick = parseFloat(String(tickSize)) || 0.01;
    const floor = toTick(floorPrice ?? tick, tickSize, 'up');
    console.log(`  SELL floor $${floor} (tick ${tickSize})`);

    const resp: any = await client.createAndPostMarketOrder(
      { tokenID: tokenId, side: 'SELL' as any, amount: shares, price: floor },
      options,
      'FOK' as any,
    );
    console.log('  CLOB SELL response:', JSON.stringify(resp));

    const sellErr = orderErrorReason(resp);
    if (resp?.success === false || sellErr) {
      return { shares: 0, fillPrice: 0, failed: true, reason: sellErr ?? 'rejected' };
    }
    if (resp?.status === 'unmatched') {
      return { shares: 0, fillPrice: 0, failed: true, reason: floorPrice !== undefined ? `below_floor_${floor}` : 'unmatched' };
    }
    if (resp?.status !== 'matched') {
      // Same pre-match hold as the buy path — poll for the real fill instead of
      // bailing (and don't cancel a delayed order).
      if (resp?.orderID) {
        const raw = await resolveDelayedFill(resp.orderID, tokenId, conditionId, 'SELL', placedAtSec, shares);
        const fill = raw ? boundFill(raw, 'SELL', shares) : null;
        if (fill && fill.shares > 0) {
          return {
            orderId: resp.orderID,
            shares: fill.shares,
            usdReceived: fill.shares * fill.price,
            fillPrice: fill.price,
            failed: false,
          };
        }
        return { shares: 0, fillPrice: 0, failed: true, reason: `delayed_no_fill_${resp?.status}` };
      }
      return { shares: 0, fillPrice: 0, failed: true, reason: `unexpected_status_${resp?.status}` };
    }

    const taking = parseFloat(resp.takingAmount ?? '0'); // USDC received
    const making = parseFloat(resp.makingAmount ?? '0'); // shares sold
    if (taking <= 0 || making <= 0) {
      return { shares: 0, fillPrice: 0, failed: true, reason: 'zero_fill' };
    }
    return {
      orderId: resp.orderID,
      shares: making,
      usdReceived: taking,
      fillPrice: taking / making,
      failed: false,
    };
  } catch (err) {
    return { shares: 0, fillPrice: 0, failed: true, reason: (err as Error).message };
  }
}

// ─── Buy-fill bookkeeping (shared by the entry pass and the re-check engine) ─

/**
 * Persist a filled BUY: fold it into the position we already hold (scale-in) or
 * open a new one, in memory AND in live_positions. This is the code that used to
 * sit inline in the entry pass, moved verbatim so the Price Re-Check Engine books
 * a late fill exactly the way a first-attempt fill is booked.
 */
async function applyBuyFill(state: State, a: {
  tag: string;
  targetWallet: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  sourceTradeKey: string;
  result: FillResult;
  sizeUsd: number;
  existingPos: OpenPos | undefined;
}): Promise<void> {
  const { tag, targetWallet, conditionId, tokenId, outcome, sourceTradeKey, result, sizeUsd, existingPos } = a;
  state.stats.buys_filled++;
  const spent = result.usdSpent ?? sizeUsd;

  if (existingPos) {
    // Scale-in: fold this fill into the position we already hold.
    await addToPosition(existingPos.dbId, result.shares, spent);
    const newShares = existingPos.shares + result.shares;
    const heldCost = existingPos.entryPrice * existingPos.shares + spent;
    existingPos.shares = newShares;
    existingPos.sizeUsd = existingPos.sizeUsd + spent;   // cumulative invested
    existingPos.entryPrice = newShares > 0 ? heldCost / newShares : existingPos.entryPrice;
    console.log(`[${tag}][entry] ✓ added ${result.shares.toFixed(4)} sh @ ${result.fillPrice.toFixed(4)} → ${newShares.toFixed(4)} sh, avg ${existingPos.entryPrice.toFixed(4)}, $${existingPos.sizeUsd.toFixed(2)} in market`);
  } else {
    const positionKey = `${conditionId.slice(0, 8)}:${tag}:${Date.now()}`;
    const newPos: OpenPos = {
      dbId: 0,
      positionKey,
      targetWallet,
      conditionId,
      tokenId,
      outcome,
      side: 'BUY',
      shares: result.shares,
      sizeUsd: spent,
      entryPrice: result.fillPrice,
      orderId: result.orderId ?? '',
      openedAt: Math.floor(Date.now() / 1000),
      sourceTradeKey,
    };
    newPos.dbId = await insertOpenPosition(newPos);
    state.open.push(newPos);
    console.log(`[${tag}][entry] ✓ filled ${result.shares.toFixed(4)} shares @ ${result.fillPrice.toFixed(4)} for $${spent.toFixed(4)}`);
  }
}

// ─── Quality sizing ────────────────────────────────────────────────

const qualityCache = new TraderQualityCache({
  dataUrl: CONFIG.dataApiUrl,
  cfg: {
    minRoi: CONFIG.quality.minRoi,
    minRoiPositions: CONFIG.quality.minRoiPositions,
    minWins: CONFIG.quality.minWins,
  } satisfies QualityConfig,
  ttlMs: CONFIG.quality.refreshMs,
});

/** Bet size for a target: `usd` is undefined (= base size) unless the target is
 *  qualified. `note` is a log suffix explaining the decision.
 *
 *  Never waits on the network: the first measurement downloads a trader's whole
 *  settled history (up to 100 pages), which must not delay a time-critical copy
 *  BUY. peek() returns what is cached and refreshes in the background; a trader
 *  not measured yet simply trades at the base size until the numbers arrive
 *  (warmQuality() starts that at launch and every cycle). */
async function qualitySizing(wallet: string): Promise<{ usd: number | undefined; note: string }> {
  if (!CONFIG.quality.enabled) return { usd: undefined, note: '' };
  try {
    const q = qualityCache.peek(wallet);
    if (!q) return { usd: undefined, note: ' [base size: trader quality still being measured]' };
    if (q.qualified) return { usd: CONFIG.quality.qualifiedBuyUsd, note: ` [QUALIFIED $${CONFIG.quality.qualifiedBuyUsd}: ${q.reasons.join('; ')}]` };
    return { usd: undefined, note: ` [base size: ${q.reasons[0] ?? 'not qualified'}]` };
  } catch {
    return { usd: undefined, note: ' [base size: quality check failed]' };
  }
}

/** Start (or refresh) quality measurement for every active target, in the background. */
function warmQuality(wallets: string[]): void {
  if (!CONFIG.quality.enabled) return;
  for (const w of wallets) qualityCache.peek(w);
}

// ─── Price Re-Check Engine wiring ──────────────────────────────────
//
// The engine itself lives in services/price-recheck.ts and knows nothing about
// orders or the wallet. Everything it needs from this file is passed in below.

/** Flipped off at startup if the price_watchlist table is missing. */
let recheckEnabled = CONFIG.recheck.enabled;
const watchStore = new PgWatchStore(query);

/** Relative slippage allowed for a target price (0.10 = 10%). Default is the
 *  absolute SIMPLE_MAX_SLIPPAGE expressed against this price, so a re-check
 *  accepts exactly what the first attempt's limit would have. */
function recheckMaxSlippage(targetPrice: number): number {
  if (CONFIG.recheck.maxSlipRel > 0) return CONFIG.recheck.maxSlipRel;
  const abs = CONFIG.maxSlippage > 0 && CONFIG.maxSlippage < 1 ? CONFIG.maxSlippage : 0.05;
  return targetPrice > 0 ? abs / targetPrice : abs;
}

/** Re-check buy: re-applies the guards the entry pass applied (state may have
 *  changed in the meantime), re-sizes, and places the order. */
async function executeWatchBuy(state: State, w: WatchEntry, limitPrice: number): Promise<BuyOutcome> {
  const tag = w.proxyWallet.slice(0, 10);

  const existingPos = state.open.find(p =>
    p.targetWallet === w.proxyWallet &&
    p.conditionId === w.conditionId &&
    p.tokenId === w.tokenId,
  );
  if (!CONFIG.mirrorMode && existingPos) {
    return { kind: 'blocked', reason: 'already_open_for_target' };
  }
  if (!existingPos) {
    const openMarkets = new Set(
      state.open.filter(p => p.targetWallet === w.proxyWallet).map(p => p.conditionId),
    );
    if (!openMarkets.has(w.conditionId) && state.open.length >= CONFIG.maxPositions) {
      return { kind: 'blocked', reason: 'at_max_positions' };
    }
  }

  const committed = !CONFIG.mirrorMode
    ? 0
    : w.capKind === 'event'
      ? await eventCostBasis(w.proxyWallet, w.conditionId)
      : await marketCostBasis(w.proxyWallet, w.conditionId);
  const qs = await qualitySizing(w.proxyWallet);
  const sizeUsd = buySizeUsd(w.targetSize * w.targetPrice, committed, w.capUsd, qs.usd);
  if (sizeUsd <= 0) {
    return { kind: 'blocked', reason: w.capKind === 'event' ? 'at_max_per_event' : 'at_max_per_market' };
  }

  console.log(`[${tag}][recheck] BUY ${w.outcome} (target @ ${w.targetPrice}) → $${sizeUsd.toFixed(2)}, limit ${limitPrice}`);
  state.stats.buys_attempted++;

  const result = await placeMarketBuy(w.tokenId, sizeUsd, w.conditionId, limitPrice);
  if (result.failed) {
    const reason = result.reason ?? 'unknown';
    return isPriceUnavailableReason(reason)
      ? { kind: 'no_fill', reason }
      : { kind: 'error', reason };
  }

  // The order has ALREADY filled. If saving it fails, still report 'filled': an
  // 'error' here would mark the watch abandoned and hide money that was spent.
  try {
    await applyBuyFill(state, {
      tag, targetWallet: w.proxyWallet, conditionId: w.conditionId, tokenId: w.tokenId,
      outcome: w.outcome, sourceTradeKey: w.sourceTradeKey, result, sizeUsd, existingPos,
    });
  } catch (err) {
    console.error(
      `[${tag}][recheck] !!! FILLED ${result.shares.toFixed(4)} sh @ ${result.fillPrice.toFixed(4)} ` +
      `but saving the position FAILED (${(err as Error).message}). Order ${result.orderId ?? '?'} — ` +
      `add it manually / run reconcile:positions.`,
    );
  }
  return {
    kind: 'filled',
    fillPrice: result.fillPrice,
    shares: result.shares,
    usdSpent: result.usdSpent ?? sizeUsd,
  };
}

function buildRecheckDeps(state: State): RecheckDeps {
  return {
    store: watchStore,
    getBestAsk: (tokenId) => fetchBestAsk(CONFIG.clobUrl, tokenId),
    executeBuy: (w, _currentPrice, limitPrice) => executeWatchBuy(state, w, limitPrice),
    maxSlippageFor: recheckMaxSlippage,
    minPrice: CONFIG.minPrice,
    maxPrice: CONFIG.maxPrice,
  };
}

/** Startup: verify the table exists and clean up anything a crash left mid-buy. */
async function initRecheck(): Promise<void> {
  if (!recheckEnabled) return;
  try {
    await query('SELECT 1 FROM price_watchlist LIMIT 1');
  } catch (err) {
    recheckEnabled = false;
    console.error(`[recheck] DISABLED — price_watchlist is not readable (${(err as Error).message}).`);
    console.error('[recheck] Apply packages/core/src/db/migrations/007_price_watchlist.sql, then restart.');
    return;
  }
  await recoverInterrupted({ store: watchStore });
}

// ─── Per-target processing ─────────────────────────────────────────

/**
 * Process trades for a SINGLE target wallet:
 *  - Close any of OUR positions opened from this target on a SELL
 *  - Open new positions on first BUY per market (subject to filters)
 *
 * SELL → CLOSE matches only against positions opened by THIS target.
 * If two different targets bought the same market, target A selling
 * doesn't close target B's copy. Each pair {target, conditionId} is
 * tracked independently.
 */
async function processTarget(state: State, targetWallet: string): Promise<void> {
  const tag = targetWallet.slice(0, 10);
  const sinceTs = Math.floor(Date.now() / 1000) - CONFIG.tradeWindowSec;
  let trades: PolyTrade[];
  try {
    trades = await fetchUserTrades(targetWallet, sinceTs);
  } catch (err) {
    console.error(`[${tag}] fetchUserTrades failed: ${(err as Error).message}`);
    return;
  }

  if (trades.length === 0) {
    console.log(`[${tag}] no trades in last ${CONFIG.tradeWindowSec}s`);
    return;
  }

  // Dedupe & sort oldest-first. Trade keys are global (txHash+asset+price+ts)
  // so processedTradeKeys is shared across all targets.
  const seenSet = new Set(state.processedTradeKeys);
  const newTrades = trades
    .filter(t => !seenSet.has(tradeKey(t)))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (newTrades.length === 0) {
    console.log(`[${tag}] all ${trades.length} trades already processed`);
    return;
  }

  console.log(`[${tag}] ${newTrades.length} new trades to process`);

  // ─── EXIT pass ───
  const sells = newTrades.filter(t => t.side === 'SELL');
  // Shares still to be sold per token in this window, consumed as we go, so
  // each sell can reconstruct the target's position as it stood at that moment.
  const pendingSells = new Map<string, number>();
  for (const t of sells) {
    const k = `${t.conditionId}:${t.asset}`;
    pendingSells.set(k, (pendingSells.get(k) ?? 0) + t.size);
  }

  for (const t of sells) {
    // Isolate each trade: one that keeps throwing must not block the
    // trades behind it on every cycle.
    try {
      const pendingKey = `${t.conditionId}:${t.asset}`;
      const pendingNow = pendingSells.get(pendingKey) ?? t.size;
      pendingSells.set(pendingKey, Math.max(0, pendingNow - t.size));

      // The target is leaving this market: drop any parked re-check for it, so we
      // never buy something they have already exited. Own try/catch — a watchlist
      // hiccup must not stop the SELL below from being copied.
      if (recheckEnabled) {
        try {
          const n = await cancelWatches(
            { store: watchStore },
            { proxyWallet: targetWallet, conditionId: t.conditionId, tokenId: t.asset, sellTs: t.timestamp, reason: 'target_sold' },
          );
          if (n > 0) console.log(`[${tag}][recheck] target SOLD → abandoned ${n} parked watch(es)`);
        } catch (err) {
          console.error(`[${tag}][recheck] cancel failed: ${(err as Error).message}`);
        }
      }

      // Match only positions WE opened from THIS target. Two targets in the
      // same market are independent positions even if they hold the same token.
      const matchingOpen = state.open.find(p =>
        p.targetWallet === targetWallet &&
        p.conditionId === t.conditionId &&
        p.tokenId === t.asset
      );
      if (!matchingOpen) {
        // Not ours — record the signal so we don't reconsider it next cycle.
        state.processedTradeKeys.push(tradeKey(t));
        await recordSignal({
          proxyWallet: targetWallet, conditionId: t.conditionId, side: t.side, outcome: t.outcome,
          price: t.price, size: t.size, detectedAt: t.timestamp,
          actedOn: false, skipReason: 'not_my_position',
        });
        continue;
      }

      // How much of OUR position to sell.
      //   mirror off → all of it (original behaviour)
      //   mirror on  → the same FRACTION they sold of their own position
      let sellShares = matchingOpen.shares;
      let fracLabel = '100%';
      if (CONFIG.mirrorMode) {
        const before = await targetSharesBeforeSell(targetWallet, t, pendingNow);
        const frac = before > 0 ? Math.min(1, t.size / before) : 1;
        sellShares = matchingOpen.shares * frac;
        fracLabel = `${(frac * 100).toFixed(0)}%`;

        // Dust guard. A slice too small for the venue to accept would fail every
        // cycle forever; a remainder too small to ever sell would strand the
        // position. In both cases take the whole thing instead.
        const minOrder = await fetchMinOrderSize(matchingOpen.tokenId);
        if (sellShares < minOrder) {
          if (matchingOpen.shares >= minOrder) {
            sellShares = matchingOpen.shares;
            fracLabel = `${(frac * 100).toFixed(0)}%→all(dust)`;
          }
        } else if (matchingOpen.shares - sellShares < minOrder) {
          sellShares = matchingOpen.shares;
          fracLabel = `${(frac * 100).toFixed(0)}%→all(remainder)`;
        }
        sellShares = Math.min(sellShares, matchingOpen.shares);
      }

      console.log(`[${tag}][exit] target SELL ${t.outcome} @ ${t.price} → selling ${fracLabel} of ${matchingOpen.positionKey} (${sellShares.toFixed(4)}/${matchingOpen.shares.toFixed(4)} sh)`);
      state.stats.sells_attempted++;

      const result = await placeMarketSell(matchingOpen.tokenId, sellShares, matchingOpen.conditionId, sellFloorPrice(t.price));
      state.processedTradeKeys.push(tradeKey(t));

      if (result.failed) {
        console.error(`[${tag}][exit] SELL failed: ${result.reason}. Position remains open.`);
        await recordSignal({
          proxyWallet: targetWallet, conditionId: t.conditionId, side: t.side, outcome: t.outcome,
          price: t.price, size: t.size, detectedAt: t.timestamp,
          actedOn: false, skipReason: `sell_failed:${result.reason ?? 'unknown'}`,
        });
        continue;
      }

      state.stats.sells_filled++;
      // Cost basis of the shares actually sold, so P/L is right on a partial exit.
      const soldShares = result.shares;
      // Average-cost basis of just the shares we sold.
      const costOfSold = matchingOpen.entryPrice * soldShares;
      const pnl = (result.usdReceived ?? 0) - costOfSold;
      state.stats.total_pnl += pnl;

      const remaining = matchingOpen.shares - soldShares;
      const closing = remaining < 1e-6;

      await reducePosition({
        positionId: matchingOpen.dbId,
        soldShares,
        proceedsUsd: result.usdReceived ?? 0,
        costOfSold,
        exitPrice: result.fillPrice,
        closing,
        reason: 'target_sold',
        closeOrderId: result.orderId,
      });

      if (closing) {
        state.closed.push({
          positionKey: matchingOpen.positionKey,
          conditionId: matchingOpen.conditionId,
          tokenId: matchingOpen.tokenId,
          outcome: matchingOpen.outcome,
          sizeUsd: matchingOpen.sizeUsd,
          shares: matchingOpen.shares,
          entryPrice: matchingOpen.entryPrice,
          exitPrice: result.fillPrice,
          pnl,
          reason: 'target_sold',
          openedAt: matchingOpen.openedAt,
          closedAt: Math.floor(Date.now() / 1000),
          closeOrderId: result.orderId,
        });
        state.open = state.open.filter(p => p.positionKey !== matchingOpen.positionKey);
      } else {
        // Keep the position open with what's left, so a later sell by the same
        // target still matches it instead of falling through as not_my_position.
        matchingOpen.shares = remaining;   // sizeUsd is cumulative — unchanged
      }

      await recordSignal({
        proxyWallet: targetWallet, conditionId: t.conditionId, side: t.side, outcome: t.outcome,
        price: t.price, size: t.size, detectedAt: t.timestamp,
        actedOn: true,
      });

      console.log(`[${tag}][exit] ✓ sold ${soldShares.toFixed(4)} sh @ ${result.fillPrice.toFixed(4)} pnl=$${pnl.toFixed(4)}${closing ? ' CLOSED' : ` (${remaining.toFixed(4)} sh left)`}`);
    } catch (err) {
      console.error(`[${tag}][exit] trade skipped after error: ${(err as Error).message}`);
    }
  }

  // ─── ENTRY pass ───
  //
  // mirror off → collapse to the FIRST buy per {market, outcome} (original).
  // mirror on  → every buy is a candidate; repeats add to the position.
  const buys = newTrades.filter(t => t.side === 'BUY');
  let entryCandidates: PolyTrade[];
  if (CONFIG.mirrorMode) {
    entryCandidates = buys;                        // already sorted oldest-first
  } else {
    const firstBuyByMarket = new Map<string, PolyTrade>();
    for (const t of buys) {
      const key = `${t.conditionId}:${t.outcome}`;
      const existing = firstBuyByMarket.get(key);
      if (!existing || t.timestamp < existing.timestamp) firstBuyByMarket.set(key, t);
    }
    entryCandidates = [...firstBuyByMarket.values()];
  }

  for (const t of entryCandidates) {
    // Isolate each trade: one that keeps throwing must not block the
    // trades behind it on every cycle.
    try {
      // Atomically CLAIM before any order. A lost claim (another cycle / process /
      // crash-retry already took this trade) → skip, so a BUY executes at most once.
      if (!(await claimTrade(t, targetWallet))) continue;

      const skip = async (reason: string, logMsg: string) => {
        console.log(`[${tag}][entry] skip: ${logMsg}`);
        state.processedTradeKeys.push(tradeKey(t));
        await recordSignal({
          proxyWallet: targetWallet, conditionId: t.conditionId, side: t.side, outcome: t.outcome,
          price: t.price, size: t.size, detectedAt: t.timestamp, sourceTradeKey: tradeKey(t),
          actedOn: false, skipReason: reason,
        });
      };

      // Category match — the target's copy_targets row defines allowed
      // categories. The same labels decide which stacking cap applies below, so
      // they are looked up once either way.
      const marketCats = await fetchMarketCategories(t.conditionId);
      const allowed = await getAllowedCategories(targetWallet);
      if (allowed.size > 0) {
        if (marketCats.size === 0) {
          await skip('category_unknown', `couldn't determine market category for ${t.conditionId.slice(0, 16)}`);
          continue;
        }
        if (![...allowed].some(c => marketCats.has(c))) {
          await skip('category_mismatch', `[${[...marketCats].join(',')}] not in allowed [${[...allowed].join(',')}]`);
          continue;
        }
      }

      // Do we already hold this exact {target, market, outcome}?
      const existingPos = state.open.find(p =>
        p.targetWallet === targetWallet &&
        p.conditionId === t.conditionId &&
        p.tokenId === t.asset
      );

      if (!CONFIG.mirrorMode && existingPos) {
        await skip('already_open_for_target', `already open from this target on ${t.conditionId.slice(0, 16)}`);
        continue;
      }

      // Capacity is counted in distinct MARKETS, not fills — a scale-in must not
      // consume a fresh slot, or one active target starves every other.
      if (!existingPos) {
        const openMarkets = new Set(
          state.open.filter(p => p.targetWallet === targetWallet).map(p => p.conditionId),
        );
        if (!openMarkets.has(t.conditionId) && state.open.length >= CONFIG.maxPositions) {
          await skip('at_max_positions', `at max_positions (${CONFIG.maxPositions})`);
          continue;
        }
      }

      // Price band, tested on the TARGET's price.
      if (t.price < CONFIG.minPrice) {
        await skip('below_min_price', `price ${t.price} < min ${CONFIG.minPrice}`);
        continue;
      }
      if (t.price > CONFIG.maxPrice) {
        await skip('above_max_price', `price ${t.price} > max ${CONFIG.maxPrice}`);
        continue;
      }

      // Size it. In mirror mode this scales with the target's own stake and is
      // bounded by the room left under whichever stacking cap applies:
      //   ordinary sport → $3 across the whole EVENT (every market on the match)
      //   esports / else → the per-market cap
      const sportsCapped = marketCats.has('sports') && !isEsports(marketCats);
      const capUsd = sportsCapped ? CONFIG.maxPerEventSportsUsd : CONFIG.maxPerMarketUsd;
      const committed = !CONFIG.mirrorMode
        ? 0
        : sportsCapped
          ? await eventCostBasis(targetWallet, t.conditionId)
          : await marketCostBasis(targetWallet, t.conditionId);
      const targetUsd = t.size * t.price;
      const qs = await qualitySizing(targetWallet);
      const sizeUsd = buySizeUsd(targetUsd, committed, capUsd, qs.usd);
      if (sizeUsd <= 0) {
        await skip(
          sportsCapped ? 'at_max_per_event' : 'at_max_per_market',
          `${sportsCapped ? 'event' : 'market'} cap $${capUsd} reached ($${committed.toFixed(2)} committed)`,
        );
        continue;
      }

      const sizeNote = CONFIG.mirrorMode
        ? ` (they staked $${targetUsd.toFixed(2)}${existingPos ? ', scale-in' : ''})`
        : '';
      console.log(`[${tag}][entry] target BUY ${t.outcome} @ ${t.price} → copying $${sizeUsd.toFixed(2)}${sizeNote}${qs.note}`);
      state.stats.buys_attempted++;

      const result = await placeMarketBuy(t.asset, sizeUsd, t.conditionId, buyLimitPrice(t.price));
      state.processedTradeKeys.push(tradeKey(t));

      if (result.failed) {
        console.error(`[${tag}][entry] BUY failed: ${result.reason}`);

        // Price ran away (nothing filled): park it for the Price Re-Check Engine
        // instead of dropping the signal. If anything goes wrong (or it is already
        // parked) fall through to the normal buy_failed record below.
        //
        // Not when the target has ALREADY sold this market in this same batch: the
        // exit pass ran first, so a later "target sold" cancel would never fire and
        // we would buy something they have already left.
        const targetAlreadyExited = sells.some(x =>
          x.conditionId === t.conditionId && x.asset === t.asset && x.timestamp >= t.timestamp);
        if (recheckEnabled && !targetAlreadyExited && isPriceUnavailableReason(result.reason)) {
          try {
            const queued = await enqueueWatch(buildRecheckDeps(state), {
              proxyWallet: targetWallet,
              sourceTradeKey: tradeKey(t),
              conditionId: t.conditionId,
              tokenId: t.asset,
              outcome: t.outcome,
              targetPrice: t.price,
              targetSize: t.size,
              targetTs: t.timestamp,
              capUsd,
              capKind: sportsCapped ? 'event' : 'market',
              failReason: result.reason ?? 'unknown',
            });
            if (queued) continue;
          } catch (err) {
            console.error(`[${tag}][recheck] could not park signal: ${(err as Error).message}`);
          }
        }

        await recordSignal({
          proxyWallet: targetWallet, conditionId: t.conditionId, side: t.side, outcome: t.outcome,
          price: t.price, size: t.size, detectedAt: t.timestamp, sourceTradeKey: tradeKey(t),
          actedOn: false, skipReason: `buy_failed:${result.reason ?? 'unknown'}`,
        });
        continue;
      }

      await applyBuyFill(state, {
        tag, targetWallet, conditionId: t.conditionId, tokenId: t.asset, outcome: t.outcome,
        sourceTradeKey: tradeKey(t), result, sizeUsd, existingPos,
      });

      await recordSignal({
        proxyWallet: targetWallet, conditionId: t.conditionId, side: t.side, outcome: t.outcome,
        price: t.price, size: t.size, detectedAt: t.timestamp, sourceTradeKey: tradeKey(t),
        actedOn: true,
      });
    } catch (err) {
      console.error(`[${tag}][entry] trade skipped after error: ${(err as Error).message}`);
    }
  }
}

// ─── Main cycle: loop over all targets ─────────────────────────────

// ─── Dashboard balance sync ────────────────────────────────────────
// simple-copy-trader is the sole runner that touches the wallet, and (unlike
// the live engine) it doesn't write the accounts row. Without this the
// dashboard /overview balance freezes at whatever the live-trader last synced.
// Mirror the proxy's real on-chain USDC into accounts, at most once a minute.
let lastBalanceSync = 0;
const BALANCE_SYNC_INTERVAL_MS = 60_000;

async function syncBalanceToDb(): Promise<void> {
  if (CONFIG.shadow) return;   // no wallet in shadow mode; don't touch accounts
  const now = Date.now();
  if (now - lastBalanceSync < BALANCE_SYNC_INTERVAL_MS) return;
  lastBalanceSync = now;
  try {
    const client = getClobClient();
    const info = await (client as any).getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const usdc = parseFloat(info.balance) / 1_000_000; // 6 decimals
    if (Number.isFinite(usdc)) {
      await query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE mode = 'live'`, [usdc]);
    }
  } catch (err) {
    console.warn(`[balance-sync] failed: ${(err as Error).message}`);
  }
}

// ─── Periodic position reconciliation ──────────────────────────────
// The runner only closes positions on a target_sold event. Markets a target
// HOLDS to resolution would otherwise stay status='open' forever (the bot has
// no "close on resolution" path). This settles resolved positions from
// Polymarket's authoritative /positions feed on a throttle, so the dashboard
// stays accurate without an external cron. Mirrors the reconcile-positions CLI.
let lastReconcile = 0;
const RECONCILE_INTERVAL_MS = parseInt(process.env.SIMPLE_RECONCILE_INTERVAL_MS || '1800000', 10); // 30 min

/** Settle a position straight from the CTF payout — no CLOB, no outcome names.
 *  The payout fraction IS the exit price (1 win, 0 loss, 0.5 voided market).
 *  Returns true if the position was closed. */
async function settleFromChain(r: {
  id: number; condition_id: string; token_id: string | null;
  clob_slot: number | null; shares: string | number; entry_price: string | number;
}): Promise<boolean> {
  if (!r.token_id) return false;
  try {
    const frac = await fetchPayoutFraction(r.condition_id, r.token_id, r.clob_slot);
    if (frac === null) return false;
    const shares = Number(r.shares);
    const heldCost = Number(r.entry_price) * shares;
    await settlePosition(r.id, frac, frac * shares - heldCost, shares,
      frac >= 1 ? 'onchain_win' : frac <= 0 ? 'onchain_loss' : 'onchain_split');
    console.log(`[reconcile] on-chain payout ${frac} for position ${r.id} (${r.condition_id.slice(0, 14)}..)`);
    return true;
  } catch (e) {
    console.warn(`[reconcile] chain payout failed for ${r.condition_id.slice(0, 14)}..: ${(e as Error).message}`);
    return false;
  }
}

/** Book a resolved position as closed at `exit` per share. */
async function settlePosition(
  id: number,
  exit: number,
  pnl: number,
  shares: number,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE live_positions
        SET status='closed', closed_at = NOW(), exit_price = $1::numeric,
            pnl = COALESCE(pnl, 0) + $2::numeric,
            -- GREATEST($5, 0) alone types $5 from the bare 0 literal, i.e.
            -- integer, and a fractional payout is then rejected outright.
            proceeds_usd = proceeds_usd + GREATEST($5::numeric, 0),
            shares = 0,
            metadata = metadata || jsonb_build_object('close_reason', $3::text)
      WHERE id = $4::int AND status='open'`,
    [exit, pnl, reason, id, exit * shares],
  );
}

async function reconcileResolvedPositions(): Promise<void> {
  const now = Date.now();
  if (now - lastReconcile < RECONCILE_INTERVAL_MS) return;
  lastReconcile = now;
  if (!CONFIG.funder && !CONFIG.shadow) return;

  try {
    const openRes = await query(
      `SELECT lp.id, lp.condition_id, lp.outcome, lp.size_usd, lp.shares, lp.entry_price, lp.pnl,
              lp.metadata->>'token_id' AS token_id,
              CASE WHEN lp.metadata->>'token_id' = m.outcome_yes_token THEN 0
                   WHEN lp.metadata->>'token_id' = m.outcome_no_token  THEN 1
              END AS clob_slot
         FROM live_positions lp
         LEFT JOIN markets m ON m.condition_id = lp.condition_id
        WHERE lp.status='open'`,
    );
    if (openRes.rows.length === 0) return;

    // Every position the proxy currently holds (resolved or not).
    // Shadow mode has no proxy wallet: skip /positions so every row takes the
    // "resolved market" path (markets.resolved_to → CLOB → on-chain payout).
    let poly: any[] = [];
    if (!CONFIG.shadow) {
      const url = `${CONFIG.dataApiUrl}/positions?user=${CONFIG.funder}&limit=500&offset=0&sizeThreshold=0`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      poly = (await res.json()) as any[];
    }
    const byKey = new Map<string, any>();
    for (const p of poly || []) byKey.set(`${String(p.conditionId).toLowerCase()}:${p.outcome}`, p);

    let settled = 0;
    for (const r of openRes.rows) {
      // One unsettleable row must not abort the pass: before this, a single
      // bad position blocked every other one behind it, on every pass.
      try {
        const p = byKey.get(`${String(r.condition_id).toLowerCase()}:${r.outcome}`);
        let exit: number;
        let pnl: number;
        let reason: string;

        if (p) {
          if (!p.redeemable) {
            // Polymarket only flips `redeemable` once IT sees the resolution; for
            // markets that settle on chain only it never does. Ask the contract
            // before writing the position off as still-running.
            if (r.token_id && (await settleFromChain(r))) settled++;
            continue;
          }
          const size = parseFloat(String(p.size ?? 0));
          const cv = parseFloat(String(p.currentValue ?? 0));
          exit = size > 0 ? cv / size : 0;
          // Score the shares WE still hold against our own average cost. Polymarket's
          // cashPnl is for the whole proxy position and is blind to our partial exits.
          pnl = exit * Number(r.shares) - Number(r.entry_price) * Number(r.shares);
          reason = cv > 0 ? 'redeemed_win' : 'redeemed_loss';
        } else {
          // Not held by the proxy → likely already auto-redeemed. Fall back to our
          // markets.resolved_to, then to CLOB directly; if still unknown, leave open.
          const mRes = await query(`SELECT resolved_to FROM markets WHERE condition_id = $1 LIMIT 1`, [r.condition_id]);
          let resolvedTo: string | null = mRes.rows[0]?.resolved_to ?? null;
          if (!resolvedTo) {
            let tokens: { token_id: string; outcome: string; winner: boolean }[] = [];
            try {
              const cr = await fetch(`${CONFIG.clobUrl}/markets/${r.condition_id}`, { signal: AbortSignal.timeout(8000) });
              if (cr.ok) {
                const cm = (await cr.json()) as { closed?: boolean; tokens?: typeof tokens };
                tokens = cm.tokens ?? [];
                if (cm.closed) resolvedTo = tokens.find((t) => t.winner)?.outcome ?? null;
              }
            } catch { /* leave unknown */ }

            // The CLOB never reports a winner for markets that settle on chain
            // only (most sports props) — read the CTF payout directly instead.
            if (!resolvedTo) {
              try {
                resolvedTo = await fetchOnChainWinner(
                  r.condition_id,
                  tokens.map(t => ({ tokenId: t.token_id, outcome: t.outcome })),
                );
                if (resolvedTo) console.log(`[reconcile] on-chain payout: ${r.condition_id.slice(0, 14)}.. → ${resolvedTo}`);
              } catch (e) {
                console.warn(`[reconcile] chain read failed for ${r.condition_id.slice(0, 14)}..: ${(e as Error).message}`);
              }
            }

            // Still nothing — the winning slot has no name we can read (the CLOB
            // is the only source of names and it's the thing that's failing). Our
            // own token id is enough to settle: the payout fraction IS the exit
            // price, including 0.5 for a voided market.
            if (!resolvedTo && (await settleFromChain(r))) {
              settled++;
              continue;
            }

            // Cache it so the dashboard and later cycles don't re-derive it.
            if (resolvedTo) {
              await query(
                `UPDATE markets SET resolved_to = $1, is_closed = true WHERE condition_id = $2 AND resolved_to IS NULL`,
                [resolvedTo, r.condition_id],
              );
            }
          }
          if (!resolvedTo) continue;
          const won = resolvedTo.trim().toLowerCase() === String(r.outcome).trim().toLowerCase();
          exit = won ? 1 : 0;
          const heldCost = Number(r.entry_price) * Number(r.shares);
          pnl = won ? Number(r.shares) - heldCost : -heldCost;
          reason = won ? 'redeemed_win_inferred' : 'redeemed_loss_inferred';
        }

        await settlePosition(r.id, exit, pnl, Number(r.shares), reason);
        settled++;
      } catch (err) {
        console.warn(`[reconcile] position ${r.id} (${String(r.condition_id).slice(0, 14)}..) failed: ${(err as Error).message}`);
      }
    }
    if (settled > 0) console.log(`[reconcile] settled ${settled} resolved position(s)`);
  } catch (err) {
    console.warn(`[reconcile] failed: ${(err as Error).message}`);
  }
}

/**
 * Active target wallets to copy — read from copy_targets (status='active') so
 * targets added/removed via the dashboard take effect on the NEXT cycle, with no
 * .env edit or restart.
 *
 * copy_targets is the source of truth: whatever the DB returns is authoritative,
 * INCLUDING an empty set. If every target is paused we copy NOTHING — we do NOT
 * fall back to .env, because that would silently re-introduce the
 * SIMPLE_TARGET_WALLETS wallets the moment the table goes empty (so pausing all
 * targets in the dashboard would quietly resurrect old ones). The .env list is
 * only used when the DB query itself FAILS, so a transient DB outage doesn't
 * blank out an otherwise-running copier.
 */
async function getActiveTargetWallets(): Promise<string[]> {
  try {
    const res = await query(
      `SELECT DISTINCT lower(proxy_wallet) AS w FROM copy_targets
        WHERE status = 'active' AND proxy_wallet IS NOT NULL`,
    );
    // Successful query → DB is authoritative, even when it returns zero rows.
    return res.rows.map((r: { w: string }) => r.w).filter(Boolean);
  } catch (err) {
    // Only a real DB failure falls back to the env list.
    console.warn(`[targets] copy_targets load failed, using .env fallback: ${(err as Error).message}`);
    return CONFIG.targetWallets;
  }
}

async function processCycle(state: State): Promise<void> {
  // Target positions are read at most once per target per cycle.
  resetTargetPosCache();
  resetTargetCategoryCache();
  // Refresh the target list each cycle so dashboard adds/removes apply live.
  const targetWallets = await getActiveTargetWallets();
  warmQuality(targetWallets);
  for (const targetWallet of targetWallets) {
    try {
      await processTarget(state, targetWallet);
    } catch (err) {
      console.error(`[${targetWallet.slice(0, 10)}] cycle error: ${(err as Error).message}`);
    }
  }

  // Price Re-Check Engine: run every parked signal whose re-check is due. After
  // the target loop so `state` already reflects this cycle's fills and exits.
  if (recheckEnabled) {
    try {
      await processWatchlist(buildRecheckDeps(state), new Set(targetWallets.map(w => w.toLowerCase())));
    } catch (err) {
      console.error(`[recheck] cycle error: ${(err as Error).message}`);
    }
  }

  // Keep the dashboard's live balance fresh (this is the only runner now).
  await syncBalanceToDb();

  // Settle positions whose markets have resolved (throttled, ~30 min) so the
  // dashboard doesn't show resolved markets as perpetually open.
  await reconcileResolvedPositions();

  state.stats.trades_processed = state.processedTradeKeys.length;
  if (state.processedTradeKeys.length > 5000) {
    state.processedTradeKeys = state.processedTradeKeys.slice(-5000);
  }
  saveState(state);
}

/**
 * --selftest-sizing — print the buy-sizing table for the CURRENT env config and
 * exit. Touches no database, places no orders. Use it to sanity-check
 * SIMPLE_SIZE_RATIO / MIN_BUY / MAX_BUY / MAX_PER_MARKET before a restart.
 */
function selfTestSizing(): void {
  if (!CONFIG.mirrorMode) {
    console.log('=== buy sizing ===');
    console.log(`  MIRROR MODE OFF — every buy is a flat $${CONFIG.positionSize} regardless of the`);
    console.log("  target's stake. Set SIMPLE_MIRROR_MODE=true to see the tier ladder.");
    return;
  }
  console.log('=== buy sizing: tier ladder ===');
  console.log('  ' + CONFIG.sizingTiers.map(t => `>=$${t.minUsd}:$${t.buyUsd}`).join('  '));
  console.log(`  hard ceiling $${CONFIG.maxBuyUsd}   per-market cap $${CONFIG.maxPerMarketUsd}`);
  console.log(`  ordinary sport: $${CONFIG.maxPerEventSportsUsd} per EVENT (all markets on the fixture); esports exempt\n`);
  console.log('  they stake    we buy   implied %');
  for (const usd of [1, 5, 10, 25, 40, 75, 100, 300, 1000, 3500, 20000]) {
    const got = buySizeUsd(usd, 0);
    console.log(`  $${String(usd).padStart(9)}  ${('$' + got.toFixed(2)).padStart(7)}   ${((100 * got) / usd).toFixed(2).padStart(6)}%`);
  }
  console.log('\n=== per-market cap — esports etc. (target keeps buying $500 in one market) ===');
  let committed = 0;
  for (let i = 1; i <= 6; i++) {
    const got = buySizeUsd(500, committed);
    if (got <= 0) {
      console.log(`  buy ${i}: SKIPPED (at_max_per_market, $${committed.toFixed(2)} committed)`);
    } else {
      committed += got;
      console.log(`  buy ${i}: $${got.toFixed(2)}  -> $${committed.toFixed(2)} in market`);
    }
  }

  console.log('\n=== per-EVENT cap — ordinary sport (one fixture, target keeps buying $500) ===');
  console.log('  (moneyline, over/under and handicap on the same match all draw on this)');
  let onEvent = 0;
  for (let i = 1; i <= 5; i++) {
    const got = buySizeUsd(500, onEvent, CONFIG.maxPerEventSportsUsd);
    if (got <= 0) {
      console.log(`  buy ${i}: SKIPPED (at_max_per_event, $${onEvent.toFixed(2)} on this match)`);
    } else {
      onEvent += got;
      console.log(`  buy ${i}: $${got.toFixed(2)}  -> $${onEvent.toFixed(2)} on this match`);
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest-sizing')) { selfTestSizing(); return; }

  if (CONFIG.quality.enabled && !(CONFIG.quality.qualifiedBuyUsd > 0)) {
    throw new Error(`SIMPLE_QUALIFIED_BUY_USD must be a positive number (got "${process.env.SIMPLE_QUALIFIED_BUY_USD}")`);
  }

  // Shadow mode must be judged against Polymarket's REAL order book — never a
  // mock, a proxy or a recording. Refuse any other CLOB host unless the operator
  // explicitly opts out (SIMPLE_ALLOW_CUSTOM_CLOB=true, for local testing only).
  if (CONFIG.shadow) {
    let host = '';
    try { host = new URL(CONFIG.clobUrl).hostname; } catch { /* invalid URL → refused below */ }
    if (host !== 'clob.polymarket.com') {
      if (process.env.SIMPLE_ALLOW_CUSTOM_CLOB === 'true') {
        console.warn(`[shadow] WARNING: CLOB_API_URL is ${CONFIG.clobUrl}, NOT Polymarket's real order book. Results are not meaningful.`);
      } else {
        throw new Error(
          `Shadow mode requires the real Polymarket order book (https://clob.polymarket.com), but CLOB_API_URL is "${CONFIG.clobUrl}". ` +
          `Remove CLOB_API_URL from .env, or set SIMPLE_ALLOW_CUSTOM_CLOB=true to override (testing only).`,
        );
      }
    }
  }

  const initialTargets = await getActiveTargetWallets();
  if (initialTargets.length === 0) {
    // Not fatal: targets are managed live via the dashboard, so we idle and
    // re-check each cycle rather than exit (which would PM2 crash-loop). The
    // moment a wallet is set active in copy_targets, the next cycle picks it up.
    console.warn('[targets] No active copy targets — copying NOTHING. Idling until a wallet is');
    console.warn('[targets] set active in the dashboard (copy_targets.status=active).');
  }

  console.log(CONFIG.shadow
    ? `=== Simple Copy Trader — SHADOW MODE (simulated fills against the REAL live order book at ${CONFIG.clobUrl}; NO real orders) ===`
    : '=== Simple Copy Trader ===');
  console.log(`  Targets (${initialTargets.length}, from copy_targets — refreshed each cycle):`);
  for (const w of initialTargets) console.log(`     - ${w}`);
  console.log(`  Position size:   $${CONFIG.positionSize}`);
  console.log(`  Max positions:   ${CONFIG.maxPositions} (across all targets)`);
  console.log(`  Price band:      $${CONFIG.minPrice} - $${CONFIG.maxPrice} (on the target's price)`);
  console.log(`  Max slippage:    buys ${CONFIG.maxSlippage > 0 && CONFIG.maxSlippage < 1
    ? `${(CONFIG.maxSlippage * 100).toFixed(0)}c over their fill`
    : 'OFF'} | sells ${CONFIG.maxSlippageSell > 0 && CONFIG.maxSlippageSell < 1
    ? `${(CONFIG.maxSlippageSell * 100).toFixed(0)}c under their fill`
    : 'OFF'}`);
  if (CONFIG.mirrorMode) {
    console.log(`  MIRROR MODE:     ON`);
    console.log(`    buy sizing:    tier ladder ${CONFIG.sizingTiers.map(t => `>=$${t.minUsd}:$${t.buyUsd}`).join(' ')} (ceiling $${CONFIG.maxBuyUsd})`);
    console.log(`    per-market cap: $${CONFIG.maxPerMarketUsd} (esports, weather, everything but ordinary sport)`);
    console.log(`    per-EVENT cap:  $${CONFIG.maxPerEventSportsUsd} on ordinary sport (tennis/cricket/football/…), all markets on the fixture combined`);
    console.log(`    exits:         proportional (partial sells mirrored)`);
  } else {
    console.log(`  MIRROR MODE:     off (first buy per market, full exit on sell)`);
  }
  console.log(`  Price re-check:  ${CONFIG.recheck.enabled
    ? `ON (re-checks at ${RECHECK_SCHEDULE_SEC.map(s => `${s}s`).join('/')}, TTL ${RECHECK_TTL_SEC}s, max slip ${CONFIG.recheck.maxSlipRel > 0
      ? `${(CONFIG.recheck.maxSlipRel * 100).toFixed(1)}% of target price`
      : `${((CONFIG.maxSlippage > 0 && CONFIG.maxSlippage < 1 ? CONFIG.maxSlippage : 0.05) * 100).toFixed(0)}c (SIMPLE_MAX_SLIPPAGE)`})`
    : 'off (SIMPLE_RECHECK_ENABLED=true to enable)'}`);
  console.log(`  Quality sizing:  ${CONFIG.quality.enabled
    ? `ON — qualified traders get $${CONFIG.quality.qualifiedBuyUsd}/trade (ROI >= ${(CONFIG.quality.minRoi * 100).toFixed(0)}% over >= ${CONFIG.quality.minRoiPositions} positions, OR >= ${CONFIG.quality.minWins} wins with $ won > $ lost); others $${CONFIG.positionSize}`
    : 'off (SIMPLE_QUALITY_SIZING=true to enable)'}`);
  console.log(`  Poll interval:   ${CONFIG.pollIntervalMs / 1000}s`);
  console.log(`  Trade window:    ${CONFIG.tradeWindowSec}s`);
  console.log(`  State file:      ${CONFIG.stateFile}`);
  console.log('');

  // Initialize CLOB client (validates env vars). Shadow mode needs no credentials.
  if (!CONFIG.shadow) getClobClient();

  await initRecheck();

  let state = await loadState();
  console.log(`[init] state loaded from DB: ${state.open.length} open positions, ${state.closed.length} closed, $${state.stats.total_pnl.toFixed(2)} total P/L`);

  let running = true;
  process.on('SIGINT',  () => { console.log('\nShutting down...'); running = false; });
  process.on('SIGTERM', () => { console.log('\nShutting down...'); running = false; });

  while (running) {
    const cycleStart = Date.now();
    try {
      await processCycle(state);
      // Refresh state from DB in case another process (or migration) wrote rows.
      state = await loadState();
    } catch (err) {
      console.error(`[cycle] error: ${(err as Error).message}`);
      console.error((err as Error).stack);
    }
    const elapsed = Date.now() - cycleStart;
    const sleep = Math.max(0, CONFIG.pollIntervalMs - elapsed);
    if (running && sleep > 0) await new Promise(r => setTimeout(r, sleep));
  }

  await shutdownDb();
  console.log('Stopped. DB connection closed.');
}

main().catch(err => { console.error(err); process.exit(1); });
