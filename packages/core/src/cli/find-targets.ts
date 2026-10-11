/**
 * Find copy-worthy targets by combining alpha scores with LIVE position health.
 *
 * Unlike the basic leaderboard which only uses realized PnL,
 * this script validates each candidate against their actual Polymarket
 * portfolio to filter out traders with massive unrealized losses.
 *
 * Usage: npx tsx packages/core/src/cli/find-targets.ts --category=sports [--since=2026-03-01] [--limit=20] [--min-trades=50]
 */

import { loadAllCategories } from '../registry.js';
import { fetchPositionsForUser } from '../api/data.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { runPerTraderBacktest, type PerTraderBacktestResult } from '../backtest/engine.js';

const log = createLogger('cli:find-targets');

const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1] || 'sports';
const sinceArg = process.argv.find(a => a.startsWith('--since='))?.split('=')[1];
const limitArg = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '20');
const minTradesArg = parseInt(process.argv.find(a => a.startsWith('--min-trades='))?.split('=')[1] || '50');
const topNToCheck = parseInt(process.argv.find(a => a.startsWith('--check='))?.split('=')[1] || '50');
const skipBacktest = process.argv.includes('--skip-backtest');
const btDaysArg = parseInt(process.argv.find(a => a.startsWith('--bt-days='))?.split('=')[1] || '30');

// ─── Alpha scoring helpers ──────────────────────────────────────────

function percentileRank(value: number, sorted: number[]): number {
  if (sorted.length === 0) return 50;
  let count = 0;
  for (const v of sorted) {
    if (v < value) count++;
    else if (v === value) count += 0.5;
  }
  return (count / sorted.length) * 100;
}

function calcProfitScore(pnl: number): number {
  if (pnl <= 0) return 0;
  if (pnl >= 50000) return 90 + Math.min(10, (pnl - 50000) / 50000 * 10);
  if (pnl >= 10000) return 70 + (pnl - 10000) / 40000 * 20;
  if (pnl >= 1000) return 50 + (pnl - 1000) / 9000 * 20;
  if (pnl >= 100) return 25 + (pnl - 100) / 900 * 25;
  return (pnl / 100) * 25;
}

const DIM_LABELS: Record<string, string> = {
  profit: '💰 Profit', efficiency: '📈 Efficiency', precision: '🎯 Precision',
  conviction: '💪 Conviction', asymmetry: '⚡ Asymmetry',
};

// ─── Live Position Health ───────────────────────────────────────────

async function checkLiveHealth(wallet: string, category: string): Promise<{
  netPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openCount: number;
  winCount: number;
  loseCount: number;
  matchedCount: number;
  healthy: boolean;
}> {
  const positions = await fetchPositionsForUser(wallet);

  // Get tracked condition_ids for this category
  const trackedRes = await query(
    `SELECT m.condition_id FROM markets m JOIN events e ON m.event_id = e.id WHERE e.category = $1`,
    [category]
  );
  const tracked = new Set(trackedRes.rows.map((r: any) => r.condition_id));
  const catPositions = positions.filter(p => tracked.has(p.conditionId));

  let realized = 0, unrealized = 0, invested = 0;
  let openCount = 0, winCount = 0, loseCount = 0;

  for (const pos of catPositions) {
    const size = parseFloat(String(pos.size)) || 0;
    const initial = parseFloat(String(pos.initialValue)) || 0;
    const current = parseFloat(String(pos.currentValue)) || 0;
    const posRealized = parseFloat(String(pos.realizedPnl)) || 0;

    realized += posRealized;
    invested += initial;

    if (size > 0) {
      openCount++;
      unrealized += (current - initial);
      if (current >= initial) winCount++; else loseCount++;
    }
  }

  const netPnl = realized + unrealized;
  const healthy = netPnl >= 0 || (unrealized > -1000 && loseCount < winCount * 3);

  return { netPnl, realizedPnl: realized, unrealizedPnl: unrealized, openCount, winCount, loseCount, matchedCount: catPositions.length, healthy };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  await loadAllCategories();

  console.log(`\n=== Finding Copy Targets [${categoryArg}] ===`);
  console.log(`  Min trades: ${minTradesArg} | Check top: ${topNToCheck} | Return: ${limitArg}`);
  if (sinceArg) console.log(`  Since: ${sinceArg}`);
  console.log('');

  // Step 1: Get alpha-ranked candidates from DB
  console.log('Step 1: Getting alpha-ranked candidates...');
  const step1Start = Date.now();

  let candidates: any[];

  if (sinceArg) {
    // On-the-fly scoring from recent trades
    console.log(`  Querying trades since ${sinceArg} for category=${categoryArg}...`);
    const sinceTs = Math.floor(new Date(sinceArg).getTime() / 1000);

    const statsResult = await query(`
      WITH filtered AS (
        SELECT t.trader_id, m.condition_id, t.outcome, t.price, t.size, m.resolved_to
        FROM trades t
        JOIN markets m ON t.market_id = m.id
        JOIN events e ON t.event_id = e.id
        WHERE t.timestamp >= $1 AND t.side = 'BUY' AND m.resolved_to IS NOT NULL AND e.category = $2
      ),
      market_pnl AS (
        SELECT trader_id, condition_id,
          SUM(CASE WHEN outcome = resolved_to THEN (1 - price) * size ELSE -price * size END) AS pnl,
          SUM(price * size) AS invested
        FROM filtered GROUP BY trader_id, condition_id
      ),
      trader_agg AS (
        SELECT trader_id,
          COUNT(DISTINCT condition_id) AS total_markets,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
          SUM(pnl) AS total_pnl,
          SUM(invested) AS total_invested
        FROM market_pnl GROUP BY trader_id
      ),
      trade_counts AS (
        SELECT t.trader_id, COUNT(*) AS total_trades
        FROM trades t JOIN events e ON t.event_id = e.id
        WHERE t.timestamp >= $1 AND e.category = $2
        GROUP BY t.trader_id
      )
      SELECT ta.trader_id AS id, tr.proxy_wallet, tr.display_name,
        COALESCE(tc.total_trades, 0) AS total_trades, ta.total_markets,
        ta.wins::real / NULLIF(ta.total_markets, 0) AS win_rate,
        ta.total_pnl / NULLIF(ta.total_invested, 0) AS roi,
        ta.total_pnl
      FROM trader_agg ta
      JOIN traders tr ON tr.id = ta.trader_id
      LEFT JOIN trade_counts tc ON tc.trader_id = ta.trader_id
      WHERE COALESCE(tc.total_trades, 0) >= $3 AND ta.total_markets >= 1
      ORDER BY ta.total_pnl DESC
      LIMIT $4
    `, [sinceTs, categoryArg, minTradesArg, topNToCheck * 2]);

    candidates = statsResult.rows;
  } else {
    // Use pre-computed scores
    const result = await query(
      `SELECT t.id, t.proxy_wallet, t.display_name,
              tcs.total_trades, tcs.total_markets, tcs.win_rate, tcs.roi, tcs.total_pnl,
              tcs.alpha_score
       FROM trader_category_stats tcs
       JOIN traders t ON t.id = tcs.trader_id
       WHERE tcs.category = $1 AND tcs.total_trades >= $2 AND tcs.alpha_score IS NOT NULL
       ORDER BY tcs.alpha_score DESC
       LIMIT $3`,
      [categoryArg, minTradesArg, topNToCheck * 2]
    );
    candidates = result.rows;
  }

  console.log(`  Found ${candidates.length} candidates from DB (${((Date.now() - step1Start) / 1000).toFixed(1)}s)\n`);

  if (candidates.length === 0) {
    console.log('No qualifying candidates found.');
    await shutdown();
    return;
  }

  // Step 2: Compute alpha scores in memory (for since-filtered or re-rank)
  console.log('Step 2: Computing alpha scores...');
  const step2Start = Date.now();
  console.log('  Loading asymmetry data from DB...');

  // Asymmetry from DB
  const sinceTs = sinceArg ? Math.floor(new Date(sinceArg).getTime() / 1000) : 0;
  const asymQuery = sinceArg
    ? `SELECT t.trader_id,
         AVG(CASE WHEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) > 0
              THEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) END) AS avg_win,
         AVG(CASE WHEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) < 0
              THEN ABS(CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) END) AS avg_loss,
         COUNT(CASE WHEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) < 0 THEN 1 END) AS loss_count
       FROM trades t JOIN markets m ON t.market_id = m.id JOIN events e ON t.event_id = e.id
       WHERE t.side = 'BUY' AND m.resolved_to IS NOT NULL AND e.category = '${categoryArg}' AND t.timestamp >= ${sinceTs}
       GROUP BY t.trader_id`
    : `SELECT t.trader_id,
         AVG(CASE WHEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) > 0
              THEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) END) AS avg_win,
         AVG(CASE WHEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) < 0
              THEN ABS(CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) END) AS avg_loss,
         COUNT(CASE WHEN (CASE WHEN t.outcome = m.resolved_to THEN (1-t.price)*t.size ELSE -t.price*t.size END) < 0 THEN 1 END) AS loss_count
       FROM trades t JOIN markets m ON t.market_id = m.id JOIN events e ON t.event_id = e.id
       WHERE t.side = 'BUY' AND m.resolved_to IS NOT NULL AND e.category = '${categoryArg}'
       GROUP BY t.trader_id`;

  const asymResult = await query(asymQuery);
  const asymMap = new Map<number, number>();
  for (const r of asymResult.rows) {
    const lc = parseInt(r.loss_count) || 0;
    const aw = parseFloat(r.avg_win) || 0;
    const al = parseFloat(r.avg_loss) || 0;
    if (lc === 0) asymMap.set(r.trader_id, -1);
    else if (al > 0) asymMap.set(r.trader_id, aw / al);
    else asymMap.set(r.trader_id, 0);
  }

  // Compute percentiles and alpha
  const mapped = candidates.map((t: any) => ({
    id: t.id, proxy_wallet: t.proxy_wallet, display_name: t.display_name,
    total_markets: parseInt(t.total_markets), win_rate: parseFloat(t.win_rate) || 0,
    roi: parseFloat(t.roi) || 0, total_pnl: parseFloat(t.total_pnl) || 0,
    total_trades: parseInt(t.total_trades),
  }));

  const roiSorted = mapped.map(t => t.roi).sort((a, b) => a - b);
  const precSorted = mapped.map(t => t.win_rate * Math.min(1, t.total_markets / 50) * 100).sort((a, b) => a - b);
  const convMap = new Map(mapped.map(t => [t.id, t.total_pnl > 0 ? t.total_pnl / t.total_trades : 0]));
  const convSorted = Array.from(convMap.values()).sort((a, b) => a - b);
  const asymSorted = Array.from(asymMap.values()).filter(v => v >= 0).sort((a, b) => a - b);

  const scored = mapped.map(t => {
    const profit = calcProfitScore(t.total_pnl);
    const efficiency = percentileRank(t.roi, roiSorted);
    const precision = percentileRank(t.win_rate * Math.min(1, t.total_markets / 50) * 100, precSorted);
    const conviction = percentileRank(convMap.get(t.id) || 0, convSorted);
    const ra = asymMap.get(t.id);
    const asymmetry = ra === undefined ? 50 : ra === -1 ? 75 : percentileRank(ra, asymSorted);

    const dims = [
      { key: 'profit', score: profit }, { key: 'efficiency', score: efficiency },
      { key: 'precision', score: precision }, { key: 'conviction', score: conviction },
      { key: 'asymmetry', score: asymmetry },
    ].sort((a, b) => b.score - a.score);

    const alpha = dims[0].score * 0.4 + dims[1].score * 0.35 + dims[2].score * 0.25;
    const tags = dims.slice(0, 2).map(d => DIM_LABELS[d.key]).join(' | ');

    return { ...t, alpha, tags, profit, efficiency, precision, conviction, asymmetry };
  }).sort((a, b) => b.alpha - a.alpha).slice(0, topNToCheck);

  console.log(`  Computed alpha for ${scored.length} candidates (${((Date.now() - step2Start) / 1000).toFixed(1)}s)`);
  console.log(`  Alpha range: ${scored[scored.length - 1]?.alpha.toFixed(1)} - ${scored[0]?.alpha.toFixed(1)}\n`);

  // Step 3: Per-trader backtest
  let btResults = new Map<number, PerTraderBacktestResult>();

  if (!skipBacktest) {
    const step3Start = Date.now();
    console.log(`Step 3: Running individual backtests for ${scored.length} candidates (${btDaysArg} days)...`);
    console.log(`  Config: $1000 balance, $5 position, 10 max positions, $0.70 max price, $20 daily loss`);

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - btDaysArg * 86400000);
    console.log(`  Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

    const btList = await runPerTraderBacktest(
      scored.map(s => s.id),
      {
        category: categoryArg,
        startDate,
        endDate,
        initialBalance: 1000,
        positionSize: 5,
        maxPricePerShare: 0.70,
        maxOpenPositions: 10,
        dailyLossLimit: 20,
      }
    );

    for (const r of btList) btResults.set(r.traderId, r);

    const profitable = btList.filter(r => r.totalReturn > 0).length;
    const totalBtPnl = btList.reduce((s, r) => s + r.totalReturn, 0);
    console.log(`  ${profitable}/${btList.length} traders profitable in backtest (${((Date.now() - step3Start) / 1000).toFixed(1)}s)`);
    console.log(`  Aggregate backtest PnL: $${totalBtPnl.toFixed(2)}\n`);

    // Show top 10 backtest results
    for (const r of btList.slice(0, 10)) {
      const status = r.totalReturn > 0 ? '✅' : '❌';
      const name = (r.name || r.wallet.substring(0, 10)).padEnd(20);
      console.log(`  ${status} ${name} | Return: $${r.totalReturn.toFixed(2)} (${r.totalReturnPct.toFixed(1)}%) | WR: ${(r.winRate * 100).toFixed(0)}% | Trades: ${r.trades}`);
    }
    console.log('');
  } else {
    console.log('Step 3: Skipping backtest (--skip-backtest)\n');
  }

  // Step 4: Live health check on candidates that passed backtest (or all if skipped)
  const btFiltered = skipBacktest
    ? scored
    : scored.filter(s => {
        const bt = btResults.get(s.id);
        return bt && bt.totalReturn > 0;
      });

  const step4Start = Date.now();
  console.log(`Step 4: Checking live Polymarket positions for ${btFiltered.length} candidates...`);
  console.log('  (This fetches real data from Polymarket API — may take a minute)\n');

  type VerifiedCandidate = typeof scored[0] & {
    btReturn: number; btReturnPct: number; btWinRate: number; btTrades: number;
    liveNetPnl: number; liveUnrealized: number; liveOpen: string; liveHealthy: boolean;
    combinedScore: number;
  };

  const verified: VerifiedCandidate[] = [];

  for (let i = 0; i < btFiltered.length; i++) {
    const t = btFiltered[i];
    const name = t.display_name || t.proxy_wallet.substring(0, 10);
    const bt = btResults.get(t.id);

    try {
      const health = await checkLiveHealth(t.proxy_wallet, categoryArg);

      verified.push({
        ...t,
        btReturn: bt?.totalReturn || 0,
        btReturnPct: bt?.totalReturnPct || 0,
        btWinRate: bt?.winRate || 0,
        btTrades: bt?.trades || 0,
        liveNetPnl: health.netPnl,
        liveUnrealized: health.unrealizedPnl,
        liveOpen: `${health.openCount} (${health.winCount}W/${health.loseCount}L)`,
        liveHealthy: health.healthy,
        combinedScore: 0, // calculated below
      });

      const status = health.healthy ? '✅' : '❌';
      const btStr = bt ? `BT: $${bt.totalReturn.toFixed(0)}` : 'BT: N/A';
      const progress = `[${i + 1}/${btFiltered.length}]`;
      console.log(`  ${progress} ${status} ${name.padEnd(20)} | Alpha: ${t.alpha.toFixed(1)} | ${btStr} | Live Net: $${health.netPnl.toFixed(0)} | Open: ${health.openCount}`);
    } catch (err) {
      console.log(`  ⚠️ ${name.padEnd(20)} | Failed to check: ${(err as Error).message}`);
    }

    // Rate limit
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n  Live check complete (${((Date.now() - step4Start) / 1000).toFixed(1)}s) — ${verified.filter(v => v.liveHealthy).length} healthy, ${verified.filter(v => !v.liveHealthy).length} unhealthy\n`);

  // Step 5: Combined ranking — alpha * 0.4 + backtest * 0.4 + live health * 0.2
  console.log('Step 5: Computing combined scores...');
  // Normalize backtest returns to 0-100 percentile scale
  const btReturnsSorted = verified.map(v => v.btReturnPct).sort((a, b) => a - b);

  for (const v of verified) {
    const btScore = skipBacktest ? 50 : percentileRank(v.btReturnPct, btReturnsSorted);
    const healthScore = v.liveHealthy ? 100 : 0;
    v.combinedScore = v.alpha * 0.4 + btScore * 0.4 + healthScore * 0.2;
  }

  const ranked = verified
    .filter(v => v.liveHealthy && !v.liveOpen.startsWith('0 '))
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limitArg);

  console.log(`\n=== Recommended Targets (${ranked.length} healthy out of ${verified.length} checked) ===\n`);
  console.log('  #  | Score | Alpha | BT Return  | Tags                          | WR%  | Live Net    | Open         | Name');
  console.log('  ---+-------+-------+------------+-------------------------------+------+-------------+--------------+----');

  for (let i = 0; i < ranked.length; i++) {
    const t = ranked[i];
    const idx = String(i + 1).padStart(3);
    const score = t.combinedScore.toFixed(1).padStart(5);
    const alpha = t.alpha.toFixed(1).padStart(5);
    const btRet = `$${t.btReturn.toFixed(0)} (${t.btReturnPct.toFixed(0)}%)`.padStart(10);
    const tags = t.tags.padEnd(29).substring(0, 29);
    const wr = (t.win_rate * 100).toFixed(1).padStart(4);
    const liveNet = `$${t.liveNetPnl.toFixed(0)}`.padStart(11);
    const open = t.liveOpen.padStart(12);
    const name = (t.display_name || t.proxy_wallet.substring(0, 10)).substring(0, 20);

    console.log(`  ${idx} | ${score} | ${alpha} | ${btRet} | ${tags} | ${wr} | ${liveNet} | ${open} | ${name}`);
  }

  // Show add commands
  if (ranked.length > 0) {
    console.log('\n  To add as copy targets:');
    for (const t of ranked) {
      const name = t.display_name || t.proxy_wallet.substring(0, 10);
      console.log(`    npx tsx packages/core/src/cli/manage-targets.ts add-wallet ${t.proxy_wallet} --name=${name} --category=${categoryArg}`);
    }
  } else {
    console.log('\n  No healthy targets found. Try lowering --min-trades or widening the search.');
  }

  const rejected = verified.filter(v => !v.liveHealthy);
  if (rejected.length > 0) {
    console.log(`\n  Rejected ${rejected.length} traders with negative live positions.`);
  }

  const inactive = verified.filter(v => v.liveHealthy && v.liveOpen.startsWith('0 '));
  if (inactive.length > 0) {
    console.log(`  Filtered ${inactive.length} inactive traders (0 open positions).`);
  }

  const btRejected = skipBacktest ? 0 : scored.length - btFiltered.length;
  if (btRejected > 0) {
    console.log(`  Filtered ${btRejected} traders with negative backtest returns.`);
  }

  console.log('');
  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
