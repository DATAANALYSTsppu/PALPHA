import { query } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { config } from '../config.js';

const log = createLogger('backtest');

export interface BacktestConfig {
  category?: string;
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  positionSize: number;
  maxPricePerShare: number;
  minPricePerShare?: number;
  maxOpenPositions: number;
  dailyLossLimit: number;
  minAlphaScore?: number;
  traderIds?: number[];
}

export interface BacktestResult {
  config: BacktestConfig;
  totalReturn: number;
  totalReturnPct: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  winRate: number;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  equityCurve: { date: string; equity: number }[];
  perTrader: { traderId: number; wallet: string; name: string; trades: number; pnl: number }[];
}

interface SimPosition {
  conditionId: string;
  traderId: number;
  side: string;
  outcome: string;  // the actual outcome bought (e.g. 'Yes', 'No', or a team name)
  entryPrice: number;
  sizeUsd: number;
  shares: number;
  openedAt: number; // unix timestamp
  resolvedTo?: string;
}

/**
 * A position wins iff the OUTCOME it bought is the market's resolved outcome.
 * markets.resolved_to and trades.outcome are both outcome strings — 'Yes'/'No'
 * for binary markets, a team/competitor name for multi-outcome ones. The old
 * code compared resolved_to against a YES/NO-coerced side, which silently
 * scored EVERY multi-outcome (esports / over-under / named) market as a loss.
 */
function isWin(resolvedTo: string | null | undefined, outcome: string): boolean {
  if (!resolvedTo) return false;
  return resolvedTo.trim().toLowerCase() === outcome.trim().toLowerCase();
}

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const startTs = Math.floor(cfg.startDate.getTime() / 1000);
  const endTs = Math.floor(cfg.endDate.getTime() / 1000);

  log.info({ category: cfg.category, startDate: cfg.startDate.toISOString(), endDate: cfg.endDate.toISOString() }, 'Starting backtest');

  // Get target traders (either specified or top alpha)
  let traderIds: number[];
  if (cfg.traderIds && cfg.traderIds.length > 0) {
    traderIds = cfg.traderIds;
  } else {
    const minAlpha = cfg.minAlphaScore || 60;
    const categoryFilter = cfg.category
      ? `JOIN trader_category_stats tcs ON tcs.trader_id = t.id WHERE tcs.category = '${cfg.category}' AND tcs.alpha_score >= ${minAlpha}`
      : `WHERE t.alpha_score >= ${minAlpha}`;
    const topTraders = await query(
      `SELECT t.id FROM traders t ${categoryFilter} ORDER BY t.alpha_score DESC LIMIT 50`
    );
    traderIds = topTraders.rows.map((r: any) => r.id);
  }

  if (traderIds.length === 0) {
    log.warn('No traders found for backtest');
    return emptyResult(cfg);
  }

  log.info({ traderCount: traderIds.length }, 'Target traders selected');

  // Get all BUY trades by these traders in the date range, joined with market resolution
  const placeholders = traderIds.map((_, i) => `$${i + 3}`).join(',');
  const tradesResult = await query(
    `SELECT t.trader_id, m.condition_id, t.side, t.outcome, t.price, t.size, t.timestamp,
            m.resolved_to,
            e.category
     FROM trades t
     JOIN markets m ON t.market_id = m.id
     JOIN events e ON t.event_id = e.id
     WHERE t.trader_id IN (${placeholders})
       AND t.timestamp >= $1 AND t.timestamp <= $2
       AND t.side = 'BUY'
       ${cfg.category ? `AND e.category = '${cfg.category}'` : ''}
     ORDER BY t.timestamp ASC`,
    [startTs, endTs, ...traderIds]
  );

  const allTrades = tradesResult.rows;
  log.info({ trades: allTrades.length }, 'Historical trades loaded');

  // Bulk-load resolutions for every market these trades touch, ONCE. The old
  // code ran `SELECT resolved_to FROM markets WHERE condition_id=$1` per open
  // position per trade — an N+1 that never finished against the partitioned
  // 477M-row prod DB. A single Map lookup replaces it.
  const conditionIds = Array.from(new Set(allTrades.map((t: any) => t.condition_id).filter(Boolean)));
  const resolutions = new Map<string, string>();
  if (conditionIds.length > 0) {
    const resRows = await query(
      `SELECT condition_id, resolved_to FROM markets WHERE condition_id = ANY($1) AND resolved_to IS NOT NULL`,
      [conditionIds]
    );
    for (const r of resRows.rows) resolutions.set(r.condition_id, r.resolved_to);
  }
  log.info({ markets: conditionIds.length, resolved: resolutions.size }, 'Market resolutions bulk-loaded');

  // Simulation state
  let balance = cfg.initialBalance;
  const openPositions: SimPosition[] = [];
  const closedPositions: (SimPosition & { exitPrice: number; pnl: number; closedAt: number })[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const dailyLosses = new Map<string, number>(); // date string -> loss
  const seenConditions = new Set<string>(); // per-trader dedup

  // Process trades chronologically
  for (const trade of allTrades) {
    const tradeDate = new Date(trade.timestamp * 1000).toISOString().split('T')[0];

    // Check and close resolved positions first
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      // Check if this position's market has resolved (Map lookup, no DB round-trip)
      const resolvedTo = resolutions.get(pos.conditionId);
      if (resolvedTo) {
        const won = isWin(resolvedTo, pos.outcome);
        const exitPrice = won ? 1.0 : 0.0;
        const pnl = (exitPrice - pos.entryPrice) * pos.shares;

        closedPositions.push({ ...pos, exitPrice, pnl, closedAt: trade.timestamp });
        balance += pos.sizeUsd + pnl;

        if (pnl < 0) {
          dailyLosses.set(tradeDate, (dailyLosses.get(tradeDate) || 0) + Math.abs(pnl));
        }

        openPositions.splice(i, 1);
      }
    }

    // Apply entry filters
    const dedupKey = `${trade.trader_id}-${trade.condition_id}`;
    if (seenConditions.has(dedupKey)) continue;

    if (trade.price > cfg.maxPricePerShare) continue;
    if (cfg.minPricePerShare != null && trade.price < cfg.minPricePerShare) continue;
    if (openPositions.length >= cfg.maxOpenPositions) continue;
    if ((dailyLosses.get(tradeDate) || 0) >= cfg.dailyLossLimit) continue;
    if (balance < cfg.positionSize) continue;

    // Check if already have position for this market
    if (openPositions.some(p => p.conditionId === trade.condition_id)) continue;

    // Open position
    const shares = cfg.positionSize / trade.price;
    const side = trade.outcome === 'Yes' ? 'YES' : 'NO';

    openPositions.push({
      conditionId: trade.condition_id,
      traderId: trade.trader_id,
      side,
      outcome: trade.outcome,
      entryPrice: trade.price,
      sizeUsd: cfg.positionSize,
      shares,
      openedAt: trade.timestamp,
    });

    balance -= cfg.positionSize;
    seenConditions.add(dedupKey);

    // Record equity point
    const openValue = openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
    equityCurve.push({ date: tradeDate, equity: balance + openValue });
  }

  // Close remaining open positions at last known price (conservative: entry price)
  for (const pos of openPositions) {
    const resolvedTo = resolutions.get(pos.conditionId);
    let exitPrice = pos.entryPrice; // default: break even
    let pnl = 0;

    if (resolvedTo) {
      const won = isWin(resolvedTo, pos.outcome);
      exitPrice = won ? 1.0 : 0.0;
      pnl = (exitPrice - pos.entryPrice) * pos.shares;
    }

    closedPositions.push({ ...pos, exitPrice, pnl, closedAt: endTs });
    balance += pos.sizeUsd + pnl;
  }

  // Calculate metrics
  const totalPnl = closedPositions.reduce((sum, p) => sum + p.pnl, 0);
  const wins = closedPositions.filter(p => p.pnl > 0).length;
  const losses = closedPositions.filter(p => p.pnl <= 0).length;
  const winRate = closedPositions.length > 0 ? wins / closedPositions.length : 0;

  // Max drawdown from equity curve
  let peak = cfg.initialBalance;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe ratio (simplified: daily returns)
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const ret = (equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity;
    dailyReturns.push(ret);
  }
  const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 1;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  // Per-trader breakdown
  const traderMap = new Map<number, { trades: number; pnl: number }>();
  for (const pos of closedPositions) {
    const existing = traderMap.get(pos.traderId) || { trades: 0, pnl: 0 };
    existing.trades++;
    existing.pnl += pos.pnl;
    traderMap.set(pos.traderId, existing);
  }

  const traderBreakdown = traderMap.size > 0
    ? await Promise.all(Array.from(traderMap.entries()).map(async ([id, stats]) => {
        const res = await query(`SELECT proxy_wallet, display_name FROM traders WHERE id = $1`, [id]);
        const row = res.rows[0];
        return { traderId: id, wallet: row?.proxy_wallet || '', name: row?.display_name || '', ...stats };
      }))
    : [];

  const result: BacktestResult = {
    config: cfg,
    totalReturn: totalPnl,
    totalReturnPct: (totalPnl / cfg.initialBalance) * 100,
    sharpeRatio,
    maxDrawdown,
    maxDrawdownPct: peak > 0 ? (maxDrawdown / peak) * 100 : 0,
    winRate,
    totalTrades: closedPositions.length,
    wins,
    losses,
    totalPnl,
    equityCurve,
    perTrader: traderBreakdown.sort((a, b) => b.pnl - a.pnl),
  };

  // Save to DB
  await query(
    `INSERT INTO backtest_runs (category, strategy, start_date, end_date, config, total_return, sharpe_ratio, max_drawdown, win_rate, total_trades, total_pnl, equity_curve, per_trader)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      cfg.category || null, 'copy_trade',
      cfg.startDate, cfg.endDate, JSON.stringify(cfg),
      result.totalReturn, result.sharpeRatio, result.maxDrawdown,
      result.winRate, result.totalTrades, result.totalPnl,
      JSON.stringify(result.equityCurve), JSON.stringify(result.perTrader),
    ]
  );

  log.info({
    totalReturn: `$${totalPnl.toFixed(2)}`,
    returnPct: `${result.totalReturnPct.toFixed(2)}%`,
    sharpe: sharpeRatio.toFixed(2),
    maxDD: `${result.maxDrawdownPct.toFixed(2)}%`,
    trades: closedPositions.length,
    winRate: `${(winRate * 100).toFixed(1)}%`,
  }, 'Backtest complete');

  return result;
}

function emptyResult(cfg: BacktestConfig): BacktestResult {
  return {
    config: cfg, totalReturn: 0, totalReturnPct: 0, sharpeRatio: 0,
    maxDrawdown: 0, maxDrawdownPct: 0, winRate: 0, totalTrades: 0,
    wins: 0, losses: 0, totalPnl: 0, equityCurve: [], perTrader: [],
  };
}

// ─── Per-Trader Individual Backtest ─────────────────────────────────

export interface PerTraderBacktestResult {
  traderId: number;
  wallet: string;
  name: string;
  totalReturn: number;
  totalReturnPct: number;
  winRate: number;
  trades: number;
  wins: number;
  losses: number;
  sharpe: number;
}

/**
 * Run independent backtests for each trader individually.
 * Each trader gets their own simulated balance and position limits.
 * Pre-loads all data in bulk to avoid N+1 queries.
 */
export async function runPerTraderBacktest(
  traderIds: number[],
  cfg: Omit<BacktestConfig, 'traderIds' | 'minAlphaScore'>
): Promise<PerTraderBacktestResult[]> {
  if (traderIds.length === 0) return [];

  const startTs = Math.floor(cfg.startDate.getTime() / 1000);
  const endTs = Math.floor(cfg.endDate.getTime() / 1000);

  log.info({ traderCount: traderIds.length }, 'Starting per-trader backtests');

  // Bulk load: all market resolutions
  log.info('Loading market resolutions...');
  const resolutionResult = await query(
    `SELECT condition_id, resolved_to FROM markets WHERE resolved_to IS NOT NULL`
  );
  const resolutions = new Map<string, string>();
  for (const r of resolutionResult.rows) {
    resolutions.set(r.condition_id, r.resolved_to);
  }
  log.info({ resolved: resolutions.size }, 'Market resolutions loaded');

  // Bulk load: all BUY trades for all traders in range
  log.info({ traders: traderIds.length, from: cfg.startDate.toISOString().split('T')[0], to: cfg.endDate.toISOString().split('T')[0] }, 'Loading trades...');
  const placeholders = traderIds.map((_, i) => `$${i + 3}`).join(',');
  const tradesResult = await query(
    `SELECT t.trader_id, m.condition_id, t.outcome, t.price, t.size, t.timestamp
     FROM trades t
     JOIN markets m ON t.market_id = m.id
     JOIN events e ON t.event_id = e.id
     WHERE t.trader_id IN (${placeholders})
       AND t.timestamp >= $1 AND t.timestamp <= $2
       AND t.side = 'BUY'
       ${cfg.category ? `AND e.category = '${cfg.category}'` : ''}
     ORDER BY t.timestamp ASC`,
    [startTs, endTs, ...traderIds]
  );
  log.info({ totalTrades: tradesResult.rows.length }, 'Trades loaded');

  // Partition trades by trader
  const tradesByTrader = new Map<number, typeof tradesResult.rows>();
  for (const trade of tradesResult.rows) {
    const tid = trade.trader_id;
    if (!tradesByTrader.has(tid)) tradesByTrader.set(tid, []);
    tradesByTrader.get(tid)!.push(trade);
  }
  const withTrades = tradesByTrader.size;
  const withoutTrades = traderIds.length - withTrades;
  log.info({ tradersWithTrades: withTrades, tradersWithoutTrades: withoutTrades }, 'Trades partitioned by trader');

  // Bulk load: trader info
  const traderInfoResult = await query(
    `SELECT id, proxy_wallet, display_name FROM traders WHERE id IN (${placeholders.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) - 2}`)})`,
    traderIds
  );
  const traderInfo = new Map<number, { wallet: string; name: string }>();
  for (const r of traderInfoResult.rows) {
    traderInfo.set(r.id, { wallet: r.proxy_wallet, name: r.display_name || '' });
  }

  // Run simulation per trader (all in-memory, no DB queries)
  log.info('Running simulations...');
  const results: PerTraderBacktestResult[] = [];
  let simCount = 0;

  for (const traderId of traderIds) {
    const trades = tradesByTrader.get(traderId) || [];
    if (trades.length === 0) {
      const info = traderInfo.get(traderId);
      results.push({
        traderId, wallet: info?.wallet || '', name: info?.name || '',
        totalReturn: 0, totalReturnPct: 0, winRate: 0, trades: 0, wins: 0, losses: 0, sharpe: 0,
      });
      continue;
    }

    let balance = cfg.initialBalance;
    const openPositions: SimPosition[] = [];
    const closedPositions: (SimPosition & { exitPrice: number; pnl: number })[] = [];
    const equityPoints: number[] = [cfg.initialBalance];
    const dailyLosses = new Map<string, number>();
    const seenConditions = new Set<string>();

    for (const trade of trades) {
      const tradeDate = new Date(trade.timestamp * 1000).toISOString().split('T')[0];

      // Close resolved positions
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i];
        const resolvedTo = resolutions.get(pos.conditionId);
        if (resolvedTo) {
          const won = isWin(resolvedTo, pos.outcome);
          const exitPrice = won ? 1.0 : 0.0;
          const pnl = (exitPrice - pos.entryPrice) * pos.shares;

          closedPositions.push({ ...pos, exitPrice, pnl });
          balance += pos.sizeUsd + pnl;
          if (pnl < 0) {
            dailyLosses.set(tradeDate, (dailyLosses.get(tradeDate) || 0) + Math.abs(pnl));
          }
          openPositions.splice(i, 1);
        }
      }

      // Entry filters
      const dedupKey = `${trade.condition_id}`;
      if (seenConditions.has(dedupKey)) continue;
      if (trade.price > cfg.maxPricePerShare) continue;
      if (cfg.minPricePerShare != null && trade.price < cfg.minPricePerShare) continue;
      if (openPositions.length >= cfg.maxOpenPositions) continue;
      if ((dailyLosses.get(tradeDate) || 0) >= cfg.dailyLossLimit) continue;
      if (balance < cfg.positionSize) continue;
      if (openPositions.some(p => p.conditionId === trade.condition_id)) continue;

      // Open position
      const shares = cfg.positionSize / trade.price;
      const side = trade.outcome === 'Yes' ? 'YES' : 'NO';

      openPositions.push({
        conditionId: trade.condition_id, traderId, side,
        outcome: trade.outcome,
        entryPrice: trade.price, sizeUsd: cfg.positionSize, shares, openedAt: trade.timestamp,
      });
      balance -= cfg.positionSize;
      seenConditions.add(dedupKey);

      const openValue = openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
      equityPoints.push(balance + openValue);
    }

    // Close remaining at resolution or entry price
    for (const pos of openPositions) {
      const resolvedTo = resolutions.get(pos.conditionId);
      let pnl = 0;
      let exitPrice = pos.entryPrice;
      if (resolvedTo) {
        const won = isWin(resolvedTo, pos.outcome);
        exitPrice = won ? 1.0 : 0.0;
        pnl = (exitPrice - pos.entryPrice) * pos.shares;
      }
      closedPositions.push({ ...pos, exitPrice, pnl });
      balance += pos.sizeUsd + pnl;
    }

    const totalPnl = closedPositions.reduce((sum, p) => sum + p.pnl, 0);
    const wins = closedPositions.filter(p => p.pnl > 0).length;
    const losses = closedPositions.filter(p => p.pnl <= 0).length;

    // Sharpe from equity points
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityPoints.length; i++) {
      dailyReturns.push((equityPoints[i] - equityPoints[i - 1]) / equityPoints[i - 1]);
    }
    const mean = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
    const std = dailyReturns.length > 1
      ? Math.sqrt(dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1))
      : 1;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    const info = traderInfo.get(traderId);
    results.push({
      traderId, wallet: info?.wallet || '', name: info?.name || '',
      totalReturn: totalPnl, totalReturnPct: (totalPnl / cfg.initialBalance) * 100,
      winRate: closedPositions.length > 0 ? wins / closedPositions.length : 0,
      trades: closedPositions.length, wins, losses, sharpe,
    });

    simCount++;
    if (simCount % 10 === 0 || simCount === traderIds.length) {
      log.info({ progress: `${simCount}/${traderIds.length}`, lastPnl: `$${totalPnl.toFixed(2)}`, lastTrades: closedPositions.length }, 'Simulation progress');
    }
  }

  results.sort((a, b) => b.totalReturn - a.totalReturn);

  // Save to backtest_runs table for dashboard visibility
  log.info('Saving per-trader backtest results to DB...');
  await query(
    `INSERT INTO backtest_runs (category, strategy, start_date, end_date, config, total_return, sharpe_ratio, max_drawdown, win_rate, total_trades, total_pnl, equity_curve, per_trader)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      cfg.category || null,
      'per_trader_screen',
      cfg.startDate,
      cfg.endDate,
      JSON.stringify({ ...cfg, traderCount: traderIds.length }),
      results.reduce((s, r) => s + r.totalReturn, 0),
      results.length > 0 ? results.reduce((s, r) => s + r.sharpe, 0) / results.length : 0,
      0, // no aggregate drawdown for per-trader screen
      results.length > 0 ? results.reduce((s, r) => s + r.winRate, 0) / results.length : 0,
      results.reduce((s, r) => s + r.trades, 0),
      results.reduce((s, r) => s + r.totalReturn, 0),
      JSON.stringify([]), // no aggregate equity curve
      JSON.stringify(results.map(r => ({
        traderId: r.traderId, wallet: r.wallet, name: r.name,
        trades: r.trades, pnl: r.totalReturn, winRate: r.winRate, sharpe: r.sharpe,
      }))),
    ]
  );

  log.info({ completed: results.length, profitable: results.filter(r => r.totalReturn > 0).length }, 'Per-trader backtests complete');
  return results;
}
