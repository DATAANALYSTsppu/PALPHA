import { query } from '../db/pool.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('trader-scorer');

/**
 * Score all traders using bulk SQL — no per-trader loops.
 *
 * PnL methodology: net cash flow per market.
 *
 *   pnl = (cash in)  - (cash out)
 *
 *   cash in  = sells_usd + merges_usd + redeems_usd + resolution_payout
 *   cash out = buys_usd + splits_usd
 *
 * Where resolution_payout = remaining_winning_shares × $1.
 *
 * Remaining shares are computed as:
 *   yes_held = buys_yes − sells_yes + splits − merges − (redeems if yes won)
 *   no_held  = buys_no  − sells_no  + splits − merges − (redeems if no won)
 *
 * This correctly accounts for:
 *   • partial sells (exit before resolution)
 *   • SPLIT (USDC → 1 Yes + 1 No)
 *   • MERGE (1 Yes + 1 No → USDC)
 *   • REDEEM (winning shares → USDC at resolution)
 *
 * Assumption: all REDEEM rows represent redemption of the winning outcome.
 * Losing-side redemptions yield $0 and are never recorded in practice.
 */
export async function scoreAllTraders(): Promise<number> {
  const { minMarkets, minTrades } = config.scoring;
  const weights = config.scoring.weights;

  log.info('Starting bulk composite scoring...');
  const start = Date.now();

  // ───────────────────────────────────────────────────────────────
  // Step 1: Per-market cash flows (one row per trader×market)
  // ───────────────────────────────────────────────────────────────
  log.info('Step 1/5: Aggregating per-market cash flows...');
  await query(`
    CREATE TEMP TABLE IF NOT EXISTS _market_flows AS
    SELECT
      t.trader_id,
      t.market_id,
      e.category,
      e.subcategory,
      m.resolved_to,
      -- Yes-side
      SUM(CASE WHEN t.side='BUY'  AND t.outcome='Yes' THEN t.size ELSE 0 END)              AS yes_bought,
      SUM(CASE WHEN t.side='SELL' AND t.outcome='Yes' THEN t.size ELSE 0 END)              AS yes_sold,
      SUM(CASE WHEN t.side='BUY'  AND t.outcome='Yes' THEN t.price * t.size ELSE 0 END)    AS yes_cash_out,
      SUM(CASE WHEN t.side='SELL' AND t.outcome='Yes' THEN t.price * t.size ELSE 0 END)    AS yes_cash_in,
      -- No-side
      SUM(CASE WHEN t.side='BUY'  AND t.outcome='No'  THEN t.size ELSE 0 END)              AS no_bought,
      SUM(CASE WHEN t.side='SELL' AND t.outcome='No'  THEN t.size ELSE 0 END)              AS no_sold,
      SUM(CASE WHEN t.side='BUY'  AND t.outcome='No'  THEN t.price * t.size ELSE 0 END)    AS no_cash_out,
      SUM(CASE WHEN t.side='SELL' AND t.outcome='No'  THEN t.price * t.size ELSE 0 END)    AS no_cash_in,
      -- Market-level (SPLIT/MERGE/REDEEM are not per-outcome)
      SUM(CASE WHEN t.side='SPLIT'  THEN t.size ELSE 0 END) AS splits_usd,
      SUM(CASE WHEN t.side='MERGE'  THEN t.size ELSE 0 END) AS merges_usd,
      SUM(CASE WHEN t.side='REDEEM' THEN t.size ELSE 0 END) AS redeems_usd
    -- Source: trades_clean (view restricted to markets that were both
    -- created AND resolved inside our scan window — see scripts/v3-schema.sql).
    -- This is the only place we score on; it guarantees we see every event
    -- in the market's lifetime and there is no pre-window inventory bias.
    FROM trades_clean t
    JOIN markets m ON t.market_id = m.id
    JOIN events  e ON t.event_id  = e.id
    WHERE t.trader_id IS NOT NULL
    GROUP BY t.trader_id, t.market_id, e.category, e.subcategory, m.resolved_to
  `);

  // ───────────────────────────────────────────────────────────────
  // Step 2: Per-market PnL (cash-flow methodology)
  // ───────────────────────────────────────────────────────────────
  log.info('Step 2/5: Computing per-market PnL via cash flow...');
  await query(`
    CREATE TEMP TABLE IF NOT EXISTS _position_pnl AS
    WITH base AS (
      SELECT
        trader_id, market_id, category, subcategory, resolved_to,
        yes_bought, yes_sold, yes_cash_out, yes_cash_in,
        no_bought,  no_sold,  no_cash_out,  no_cash_in,
        splits_usd, merges_usd, redeems_usd,
        -- Pre-redemption holdings (after BUY/SELL/SPLIT/MERGE only)
        GREATEST(0, yes_bought - yes_sold + splits_usd - merges_usd) AS yes_pre_redeem,
        GREATEST(0, no_bought  - no_sold  + splits_usd - merges_usd) AS no_pre_redeem
      FROM _market_flows
    )
    SELECT
      trader_id, market_id, category, subcategory,
      -- Surviving shares after redemption (redeems reduce only the winning side)
      CASE WHEN resolved_to='Yes' THEN GREATEST(0, yes_pre_redeem - redeems_usd) ELSE yes_pre_redeem END AS yes_remaining,
      CASE WHEN resolved_to='No'  THEN GREATEST(0, no_pre_redeem  - redeems_usd) ELSE no_pre_redeem  END AS no_remaining,
      -- Cash flows
      yes_cash_out + no_cash_out + splits_usd                                AS cash_out,
      yes_cash_in  + no_cash_in  + merges_usd + redeems_usd                  AS cash_in_pre_resolution,
      -- Resolution payout for surviving WINNING shares
      CASE WHEN resolved_to='Yes' THEN GREATEST(0, yes_pre_redeem - redeems_usd)
           WHEN resolved_to='No'  THEN GREATEST(0, no_pre_redeem  - redeems_usd)
           ELSE 0
      END                                                                    AS resolution_payout,
      -- Net PnL
      (yes_cash_in + no_cash_in + merges_usd + redeems_usd +
        CASE WHEN resolved_to='Yes' THEN GREATEST(0, yes_pre_redeem - redeems_usd)
             WHEN resolved_to='No'  THEN GREATEST(0, no_pre_redeem  - redeems_usd)
             ELSE 0 END
      ) - (yes_cash_out + no_cash_out + splits_usd)                          AS pnl,
      -- Invested for ROI = cumulative USDC outflows
      yes_cash_out + no_cash_out + splits_usd                                AS invested
    FROM base
  `);

  // ───────────────────────────────────────────────────────────────
  // Step 3: Global per-trader rollup + scoring
  // ───────────────────────────────────────────────────────────────
  log.info('Step 3/5: Updating global trader scores...');
  // Filter on freshly-computed aggregates (ts.*), not on traders.total_markets /
  // traders.total_trades — those columns are persisted state that isn't
  // refreshed by this job, so filtering on them excludes everyone (= 0 rows).
  // Step 5 (per-category) takes the same approach.
  const globalResult = await query(`
    WITH trade_counts AS (
      -- Count only trades on fully-contained markets (same scope as scoring).
      SELECT trader_id, COUNT(*) AS total_trades
      FROM trades_clean
      WHERE trader_id IS NOT NULL
      GROUP BY trader_id
    ),
    trader_stats AS (
      SELECT
        pp.trader_id,
        COUNT(DISTINCT pp.market_id) AS total_markets,
        SUM(CASE WHEN pp.pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(pp.pnl) AS total_pnl,
        SUM(pp.invested) AS total_invested,
        AVG(CASE WHEN pp.invested > 0 THEN pp.pnl / pp.invested ELSE 0 END) AS avg_return,
        STDDEV_POP(CASE WHEN pp.invested > 0 THEN pp.pnl / pp.invested ELSE 0 END) AS return_stddev,
        COUNT(DISTINCT pp.category) AS category_count,
        COALESCE(tc.total_trades, 0) AS total_trades
      FROM _position_pnl pp
      LEFT JOIN trade_counts tc ON tc.trader_id = pp.trader_id
      WHERE pp.invested > 0   -- skip pure-MERGE-only positions with no real exposure
      GROUP BY pp.trader_id, tc.total_trades
    )
    UPDATE traders SET
      total_markets = ts.total_markets,
      total_trades = ts.total_trades,
      win_rate = ts.wins::real / NULLIF(ts.total_markets, 0),
      roi = ts.total_pnl / NULLIF(ts.total_invested, 0),
      total_pnl = ts.total_pnl,
      consistency_score = GREATEST(0, 1.0 - COALESCE(ts.return_stddev, 0)),
      composite_score =
        (ts.wins::real / NULLIF(ts.total_markets, 0)) * ${weights.winRate} +
        GREATEST(0, LEAST(1, (ts.total_pnl / NULLIF(ts.total_invested, 0) + 1) / 2.0)) * ${weights.roi} +
        GREATEST(0, 1.0 - COALESCE(ts.return_stddev, 0)) * ${weights.consistency} +
        LEAST(1, LOG(GREATEST(ts.total_markets, 1)) / 2.0) * ${weights.marketCount} +
        LEAST(1, LOG(ts.category_count + 1) / LOG(8)) * ${weights.diversity},
      score_updated_at = NOW(),
      updated_at = NOW()
    FROM trader_stats ts
    WHERE traders.id = ts.trader_id
      AND ts.total_markets >= ${minMarkets}
      AND ts.total_trades  >= ${minTrades}
    RETURNING traders.id
  `);

  log.info({ scored: globalResult.rowCount }, 'Global scores updated');

  // ───────────────────────────────────────────────────────────────
  // Step 4: Pre-compute trade counts per trader+category
  // ───────────────────────────────────────────────────────────────
  log.info('Step 4/5: Computing per-category trade counts...');
  await query(`
    -- Count only trades on fully-contained markets, matching the scoped
    -- scoring scope so the trade-count column on the leaderboard is honest.
    CREATE TEMP TABLE IF NOT EXISTS _cat_trade_counts AS
    SELECT t.trader_id, e.category, COUNT(*) AS total_trades
    FROM trades_clean t
    JOIN events e ON t.event_id = e.id
    WHERE t.trader_id IS NOT NULL
    GROUP BY t.trader_id, e.category
  `);

  // ───────────────────────────────────────────────────────────────
  // Step 5: Per-category scoring (same PnL methodology, scoped to category)
  // ───────────────────────────────────────────────────────────────
  log.info('Step 5/5: Updating per-category scores...');
  const catResult = await query(`
    WITH cat_stats AS (
      SELECT
        pp.trader_id,
        pp.category,
        COUNT(DISTINCT pp.market_id) AS total_markets,
        SUM(CASE WHEN pp.pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pp.pnl <= 0 THEN 1 ELSE 0 END) AS losses,
        SUM(pp.pnl) AS total_pnl,
        SUM(pp.invested) AS total_invested,
        STDDEV_POP(CASE WHEN pp.invested > 0 THEN pp.pnl / pp.invested ELSE 0 END) AS return_stddev
      FROM _position_pnl pp
      WHERE pp.invested > 0
      GROUP BY pp.trader_id, pp.category
    )
    INSERT INTO trader_category_stats
      (trader_id, category, total_trades, total_markets, wins, losses, win_rate, roi, total_pnl, total_invested, consistency_score, composite_score, updated_at)
    SELECT
      cs.trader_id,
      cs.category,
      COALESCE(tc.total_trades, 0),
      cs.total_markets,
      cs.wins,
      cs.losses,
      cs.wins::real / NULLIF(cs.total_markets, 0) AS win_rate,
      cs.total_pnl / NULLIF(cs.total_invested, 0) AS roi,
      cs.total_pnl,
      cs.total_invested,
      GREATEST(0, 1.0 - COALESCE(cs.return_stddev, 0)) AS consistency_score,
      (cs.wins::real / NULLIF(cs.total_markets, 0)) * 0.40 +
        GREATEST(0, LEAST(1, (cs.total_pnl / NULLIF(cs.total_invested, 0) + 1) / 2.0)) * 0.30 +
        GREATEST(0, 1.0 - COALESCE(cs.return_stddev, 0)) * 0.20 +
        LEAST(1, LOG(GREATEST(cs.total_markets, 1)) / 2.0) * 0.10 AS composite_score,
      NOW()
    FROM cat_stats cs
    LEFT JOIN _cat_trade_counts tc ON tc.trader_id = cs.trader_id AND tc.category = cs.category
    WHERE cs.total_markets >= 1
    ON CONFLICT (trader_id, category) DO UPDATE SET
      total_trades = EXCLUDED.total_trades,
      total_markets = EXCLUDED.total_markets,
      wins = EXCLUDED.wins,
      losses = EXCLUDED.losses,
      win_rate = EXCLUDED.win_rate,
      roi = EXCLUDED.roi,
      total_pnl = EXCLUDED.total_pnl,
      total_invested = EXCLUDED.total_invested,
      consistency_score = EXCLUDED.consistency_score,
      composite_score = EXCLUDED.composite_score,
      updated_at = NOW()
    RETURNING trader_id
  `);

  // Cleanup temp tables
  await query(`DROP TABLE IF EXISTS _cat_trade_counts`);
  await query(`DROP TABLE IF EXISTS _position_pnl`);
  await query(`DROP TABLE IF EXISTS _market_flows`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log.info(
    { globalScored: globalResult.rowCount, categoryRows: catResult.rowCount, elapsed: `${elapsed}s` },
    'Bulk scoring complete'
  );

  return globalResult.rowCount || 0;
}
