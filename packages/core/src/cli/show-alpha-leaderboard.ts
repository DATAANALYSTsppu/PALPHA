import { loadAllCategories } from '../registry.js';
import { query, shutdown } from '../db/pool.js';

// ─── Alpha scoring helpers (same logic as alpha-scorer.ts) ──────────

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

const DIMENSION_LABELS: Record<string, string> = {
  profit: '💰 Profit',
  efficiency: '📈 Efficiency',
  precision: '🎯 Precision',
  conviction: '💪 Conviction',
  asymmetry: '⚡ Asymmetry',
};

interface ScoredTrader {
  id: number;
  proxy_wallet: string;
  display_name: string;
  total_trades: number;
  total_markets: number;
  win_rate: number;
  roi: number;
  total_pnl: number;
  profit_score: number;
  efficiency_score: number;
  precision_score: number;
  conviction_score: number;
  asymmetry_score: number;
  alpha_score: number;
  alpha_tags: string;
}

async function main() {
  await loadAllCategories();

  const sortArg = process.argv.find(a => a.startsWith('--sort='))?.split('=')[1] || 'alpha';
  const limitArg = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '20');
  const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];
  const minTradesArg = parseInt(process.argv.find(a => a.startsWith('--min-trades='))?.split('=')[1] || '50');
  const sinceArg = process.argv.find(a => a.startsWith('--since='))?.split('=')[1]; // e.g. 2026-03-01

  let scored: ScoredTrader[];

  if (sinceArg) {
    // ─── Date-filtered: compute on-the-fly from raw trades ──────
    scored = await computeDateFilteredAlpha(categoryArg, sinceArg, minTradesArg);
  } else {
    // ─── Pre-computed: read from trader_category_stats / traders ─
    scored = await readPrecomputedAlpha(categoryArg, minTradesArg);
  }

  // Sort
  const sortMap: Record<string, keyof ScoredTrader> = {
    alpha: 'alpha_score', profit: 'profit_score', efficiency: 'efficiency_score',
    precision: 'precision_score', conviction: 'conviction_score', asymmetry: 'asymmetry_score',
    pnl: 'total_pnl', roi: 'roi', win: 'win_rate',
  };
  const sortKey = sortMap[sortArg] || 'alpha_score';
  scored.sort((a, b) => ((b[sortKey] as number) || 0) - ((a[sortKey] as number) || 0));
  scored = scored.slice(0, limitArg);

  // Display
  const scope = categoryArg ? `[${categoryArg}]` : '[global]';
  const dateLabel = sinceArg ? ` since ${sinceArg}` : '';
  console.log(`\n=== Alpha Leaderboard ${scope}${dateLabel} (sort: ${sortArg}, min-trades: ${minTradesArg}) ===\n`);
  console.log(`  #  | Alpha | Tags                          | Pft  | Eff  | Prc  | Cvt  | Asy  | WR%  | ROI%  | PnL       | Mkts | Name`);
  console.log(`  ---+-------+-------------------------------+------+------+------+------+------+------+-------+-----------+------+----`);

  for (let i = 0; i < scored.length; i++) {
    const t = scored[i];
    const idx = String(i + 1).padStart(3);
    const alpha = (t.alpha_score || 0).toFixed(1).padStart(5);
    const tags = (t.alpha_tags || '').padEnd(29).substring(0, 29);
    const pft = (t.profit_score || 0).toFixed(0).padStart(4);
    const eff = (t.efficiency_score || 0).toFixed(0).padStart(4);
    const prc = (t.precision_score || 0).toFixed(0).padStart(4);
    const cvt = (t.conviction_score || 0).toFixed(0).padStart(4);
    const asy = (t.asymmetry_score || 0).toFixed(0).padStart(4);
    const wr = ((t.win_rate || 0) * 100).toFixed(1).padStart(4);
    const roi = ((t.roi || 0) * 100).toFixed(1).padStart(5);
    const pnl = `$${(t.total_pnl || 0).toFixed(0)}`.padStart(9);
    const mkts = String(t.total_markets || 0).padStart(4);
    const name = (t.display_name || t.proxy_wallet?.substring(0, 10) || '?').substring(0, 20);

    console.log(`  ${idx} | ${alpha} | ${tags} | ${pft} | ${eff} | ${prc} | ${cvt} | ${asy} | ${wr} | ${roi} | ${pnl} | ${mkts} | ${name}`);
  }

  console.log(`\n  Total: ${scored.length} traders\n`);
  await shutdown();
}

// ─── Pre-computed path (fast, reads stored scores) ──────────────────

async function readPrecomputedAlpha(category?: string, minTrades: number = 50): Promise<ScoredTrader[]> {
  let result;
  if (category) {
    result = await query(
      `SELECT t.id, t.proxy_wallet, t.display_name, tcs.total_trades, tcs.total_markets,
              tcs.win_rate, tcs.roi, tcs.total_pnl,
              tcs.profit_score, tcs.efficiency_score, tcs.precision_score,
              tcs.conviction_score, tcs.asymmetry_score, tcs.alpha_score, tcs.alpha_tags
       FROM trader_category_stats tcs
       JOIN traders t ON t.id = tcs.trader_id
       WHERE tcs.category = $1 AND tcs.total_trades >= $2 AND tcs.alpha_score IS NOT NULL
       ORDER BY tcs.alpha_score DESC NULLS LAST`,
      [category, minTrades]
    );
  } else {
    result = await query(
      `SELECT id, proxy_wallet, display_name, total_trades, total_markets,
              win_rate, roi, total_pnl,
              profit_score, efficiency_score, precision_score,
              conviction_score, asymmetry_score, alpha_score, alpha_tags
       FROM traders
       WHERE total_trades >= $1 AND alpha_score IS NOT NULL
       ORDER BY alpha_score DESC NULLS LAST`,
      [minTrades]
    );
  }
  return result.rows;
}

// ─── Date-filtered path (computes on-the-fly from raw trades) ───────

async function computeDateFilteredAlpha(category: string | undefined, since: string, minTrades: number): Promise<ScoredTrader[]> {
  console.log(`Computing alpha from trades since ${since}...`);
  const sinceTs = Math.floor(new Date(since).getTime() / 1000);

  const categoryWhere = category ? `AND e.category = '${category}'` : '';

  // Step 1: Get per-trader stats from trades in the date range
  const statsResult = await query(`
    WITH filtered_trades AS (
      SELECT t.trader_id, t.market_id, t.outcome, t.side, t.price, t.size,
             m.resolved_to
      FROM trades t
      JOIN markets m ON t.market_id = m.id
      JOIN events e ON t.event_id = e.id
      WHERE t.timestamp >= $1
        AND t.side = 'BUY'
        AND m.resolved_to IS NOT NULL
        ${categoryWhere}
    ),
    market_pnl AS (
      SELECT
        trader_id,
        market_id,
        SUM(CASE
          WHEN outcome = resolved_to THEN (1 - price) * size
          ELSE -price * size
        END) AS pnl,
        SUM(price * size) AS invested
      FROM filtered_trades
      GROUP BY trader_id, market_id
    ),
    trader_agg AS (
      SELECT
        trader_id,
        COUNT(DISTINCT market_id) AS total_markets,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(pnl) AS total_pnl,
        SUM(invested) AS total_invested
      FROM market_pnl
      GROUP BY trader_id
    ),
    trade_counts AS (
      SELECT t.trader_id, COUNT(*) AS total_trades
      FROM trades t
      JOIN events e ON t.event_id = e.id
      WHERE t.timestamp >= $1 ${categoryWhere}
      GROUP BY t.trader_id
    )
    SELECT
      ta.trader_id AS id,
      tr.proxy_wallet,
      tr.display_name,
      COALESCE(tc.total_trades, 0) AS total_trades,
      ta.total_markets,
      ta.wins::real / NULLIF(ta.total_markets, 0) AS win_rate,
      ta.total_pnl / NULLIF(ta.total_invested, 0) AS roi,
      ta.total_pnl
    FROM trader_agg ta
    JOIN traders tr ON tr.id = ta.trader_id
    LEFT JOIN trade_counts tc ON tc.trader_id = ta.trader_id
    WHERE COALESCE(tc.total_trades, 0) >= $2
      AND ta.total_markets >= 1
    ORDER BY ta.total_pnl DESC
  `, [sinceTs, minTrades]);

  const traders = statsResult.rows;
  if (traders.length === 0) return [];

  console.log(`  Found ${traders.length} qualifying traders, computing asymmetry...`);

  // Step 2: Asymmetry — single bulk query
  const asymResult = await query(`
    WITH filtered_pnl AS (
      SELECT
        t.trader_id,
        CASE
          WHEN t.outcome = m.resolved_to THEN (1 - t.price) * t.size
          ELSE -t.price * t.size
        END AS pnl
      FROM trades t
      JOIN markets m ON t.market_id = m.id
      JOIN events e ON t.event_id = e.id
      WHERE t.timestamp >= $1
        AND t.side = 'BUY'
        AND m.resolved_to IS NOT NULL
        ${categoryWhere}
    )
    SELECT
      trader_id,
      AVG(CASE WHEN pnl > 0 THEN pnl END) AS avg_win,
      AVG(CASE WHEN pnl < 0 THEN ABS(pnl) END) AS avg_loss,
      COUNT(CASE WHEN pnl < 0 THEN 1 END) AS loss_count
    FROM filtered_pnl
    GROUP BY trader_id
  `, [sinceTs]);

  const asymmetryMap = new Map<number, number>();
  for (const row of asymResult.rows) {
    const avgWin = parseFloat(row.avg_win) || 0;
    const avgLoss = parseFloat(row.avg_loss) || 0;
    const lossCount = parseInt(row.loss_count) || 0;
    if (lossCount === 0) asymmetryMap.set(row.trader_id, -1);
    else if (avgLoss > 0) asymmetryMap.set(row.trader_id, avgWin / avgLoss);
    else asymmetryMap.set(row.trader_id, 0);
  }

  // Step 3: Compute alpha scores in memory
  console.log(`  Computing 5-dimensional alpha scores...`);

  const mapped = traders.map((t: any) => ({
    id: t.id,
    total_markets: parseInt(t.total_markets),
    win_rate: parseFloat(t.win_rate) || 0,
    roi: parseFloat(t.roi) || 0,
    total_pnl: parseFloat(t.total_pnl) || 0,
    total_trades: parseInt(t.total_trades),
  }));

  const roiValues = mapped.map(t => t.roi).sort((a, b) => a - b);
  const precisionRaw = mapped.map(t => {
    return t.win_rate * Math.min(1, t.total_markets / 50) * 100;
  }).sort((a, b) => a - b);

  const convictionRaw = new Map<number, number>();
  for (const t of mapped) {
    convictionRaw.set(t.id, t.total_pnl > 0 ? t.total_pnl / t.total_trades : 0);
  }
  const convictionValues = Array.from(convictionRaw.values()).sort((a, b) => a - b);

  const asymmetryValues = Array.from(asymmetryMap.values()).filter(v => v >= 0).sort((a, b) => a - b);

  const scored: ScoredTrader[] = [];

  for (const t of mapped) {
    const trader = traders.find((tr: any) => tr.id === t.id);
    const profit = calcProfitScore(t.total_pnl);
    const efficiency = percentileRank(t.roi, roiValues);
    const rawPrecision = t.win_rate * Math.min(1, t.total_markets / 50) * 100;
    const precision = percentileRank(rawPrecision, precisionRaw);
    const rawConviction = convictionRaw.get(t.id) || 0;
    const conviction = percentileRank(rawConviction, convictionValues);

    let asymmetry: number;
    const rawAsym = asymmetryMap.get(t.id);
    if (rawAsym === undefined) asymmetry = 50;
    else if (rawAsym === -1) asymmetry = 75;
    else asymmetry = percentileRank(rawAsym, asymmetryValues);

    const dims = [
      { key: 'profit', score: profit },
      { key: 'efficiency', score: efficiency },
      { key: 'precision', score: precision },
      { key: 'conviction', score: conviction },
      { key: 'asymmetry', score: asymmetry },
    ].sort((a, b) => b.score - a.score);

    const top3 = dims.slice(0, 3);
    const alpha = top3[0].score * 0.4 + top3[1].score * 0.35 + top3[2].score * 0.25;
    const tags = dims.slice(0, 2).map(d => DIMENSION_LABELS[d.key]).join(' | ');

    scored.push({
      id: t.id,
      proxy_wallet: trader.proxy_wallet,
      display_name: trader.display_name,
      total_trades: t.total_trades,
      total_markets: t.total_markets,
      win_rate: t.win_rate,
      roi: t.roi,
      total_pnl: t.total_pnl,
      profit_score: profit,
      efficiency_score: efficiency,
      precision_score: precision,
      conviction_score: conviction,
      asymmetry_score: asymmetry,
      alpha_score: alpha,
      alpha_tags: tags,
    });
  }

  return scored;
}

main().catch(err => { console.error(err); process.exit(1); });
