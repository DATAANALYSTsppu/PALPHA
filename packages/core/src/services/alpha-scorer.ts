import { query } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('alpha-scorer');

interface TraderScores {
  traderId: number;
  profit: number;
  efficiency: number;
  precision: number;
  conviction: number;
  asymmetry: number;
  alpha: number;
  tags: string;
}

const DIMENSION_LABELS: Record<string, string> = {
  profit: '💰 Profit',
  efficiency: '📈 Efficiency',
  precision: '🎯 Precision',
  conviction: '💪 Conviction',
  asymmetry: '⚡ Asymmetry',
};

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

function computeAlphaScores(
  traders: { id: number; total_markets: number; win_rate: number; roi: number; total_pnl: number; total_trades: number }[],
  asymmetryMap: Map<number, number>,
): TraderScores[] {
  if (traders.length === 0) return [];

  const roiValues = traders.map(t => t.roi).sort((a, b) => a - b);
  const precisionRaw = traders.map(t => {
    const confidenceWeight = Math.min(1, t.total_markets / 50);
    return t.win_rate * confidenceWeight * 100;
  }).sort((a, b) => a - b);

  const convictionRaw: Map<number, number> = new Map();
  for (const t of traders) {
    convictionRaw.set(t.id, t.total_pnl > 0 ? t.total_pnl / t.total_trades : 0);
  }
  const convictionValues = Array.from(convictionRaw.values()).sort((a, b) => a - b);

  const asymmetryValues = Array.from(asymmetryMap.values())
    .filter(v => v >= 0)
    .sort((a, b) => a - b);

  const allScores: TraderScores[] = [];

  for (const t of traders) {
    const profit = calcProfitScore(t.total_pnl);
    const efficiency = percentileRank(t.roi, roiValues);

    const confidenceWeight = Math.min(1, t.total_markets / 50);
    const rawPrecision = t.win_rate * confidenceWeight * 100;
    const precision = percentileRank(rawPrecision, precisionRaw);

    const rawConviction = convictionRaw.get(t.id) || 0;
    const conviction = percentileRank(rawConviction, convictionValues);

    let asymmetry: number;
    const rawAsymmetry = asymmetryMap.get(t.id);
    if (rawAsymmetry === undefined) {
      asymmetry = 50;
    } else if (rawAsymmetry === -1) {
      asymmetry = 75;
    } else {
      asymmetry = percentileRank(rawAsymmetry, asymmetryValues);
    }

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

    allScores.push({ traderId: t.id, profit, efficiency, precision, conviction, asymmetry, alpha, tags });
  }

  return allScores;
}

/**
 * Build asymmetry map using a single bulk query (no batching needed — DB does the work).
 */
async function buildAsymmetryMap(minTrades: number, category?: string): Promise<Map<number, number>> {
  const categoryJoin = category ? `JOIN events e ON t.event_id = e.id` : '';
  const categoryWhere = category ? `AND e.category = '${category}'` : '';
  const traderFilter = category
    ? `AND t.trader_id IN (SELECT trader_id FROM trader_category_stats WHERE category = '${category}' AND total_trades >= ${minTrades})`
    : `AND t.trader_id IN (SELECT id FROM traders WHERE total_trades >= ${minTrades} AND total_markets >= 1)`;

  const result = await query(`
    WITH trade_pnl AS (
      SELECT
        t.trader_id,
        CASE
          WHEN t.side = 'BUY' AND t.outcome = m.resolved_to THEN (1 - t.price) * t.size
          WHEN t.side = 'BUY' AND t.outcome != m.resolved_to THEN -t.price * t.size
          ELSE 0
        END AS pnl
      FROM trades t
      JOIN markets m ON t.market_id = m.id
      ${categoryJoin}
      WHERE m.resolved_to IS NOT NULL
        AND t.side = 'BUY'
        ${traderFilter}
        ${categoryWhere}
    ),
    trader_agg AS (
      SELECT
        trader_id,
        AVG(CASE WHEN pnl > 0 THEN pnl ELSE NULL END) AS avg_win,
        AVG(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE NULL END) AS avg_loss,
        COUNT(CASE WHEN pnl < 0 THEN 1 END) AS loss_count
      FROM trade_pnl
      GROUP BY trader_id
    )
    SELECT trader_id, avg_win, avg_loss, loss_count
    FROM trader_agg
  `);

  const asymmetryMap = new Map<number, number>();
  for (const row of result.rows) {
    const avgWin = parseFloat(row.avg_win) || 0;
    const avgLoss = parseFloat(row.avg_loss) || 0;
    const lossCount = parseInt(row.loss_count) || 0;

    if (lossCount === 0) {
      asymmetryMap.set(row.trader_id, -1);
    } else if (avgLoss > 0) {
      asymmetryMap.set(row.trader_id, avgWin / avgLoss);
    } else {
      asymmetryMap.set(row.trader_id, 0);
    }
  }

  log.info({ traders: asymmetryMap.size, category: category || 'global' }, 'Asymmetry map built');
  return asymmetryMap;
}

/**
 * Bulk update scores using a temp table + UPDATE JOIN (single query instead of N updates).
 */
async function bulkUpdateTraderAlpha(scores: TraderScores[]): Promise<void> {
  if (scores.length === 0) return;

  // Create temp table with scores
  await query(`CREATE TEMP TABLE IF NOT EXISTS _alpha_scores (
    trader_id INTEGER, profit REAL, efficiency REAL, precision_s REAL,
    conviction REAL, asymmetry REAL, alpha REAL, tags TEXT
  )`);
  await query(`TRUNCATE _alpha_scores`);

  // Bulk insert into temp table
  const CHUNK = 500;
  for (let i = 0; i < scores.length; i += CHUNK) {
    const chunk = scores.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const s of chunk) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(s.traderId, s.profit, s.efficiency, s.precision, s.conviction, s.asymmetry, s.alpha, s.tags);
    }

    await query(
      `INSERT INTO _alpha_scores (trader_id, profit, efficiency, precision_s, conviction, asymmetry, alpha, tags) VALUES ${values.join(',')}`,
      params
    );
  }

  // Single UPDATE from temp table
  await query(`
    UPDATE traders SET
      profit_score = a.profit,
      efficiency_score = a.efficiency,
      precision_score = a.precision_s,
      conviction_score = a.conviction,
      asymmetry_score = a.asymmetry,
      alpha_score = a.alpha,
      alpha_tags = a.tags,
      score_updated_at = NOW(),
      updated_at = NOW()
    FROM _alpha_scores a
    WHERE traders.id = a.trader_id
  `);

  await query(`DROP TABLE IF EXISTS _alpha_scores`);
}

/**
 * Bulk update category alpha scores using temp table.
 */
async function bulkUpdateCategoryAlpha(scores: TraderScores[], category: string): Promise<void> {
  if (scores.length === 0) return;

  await query(`CREATE TEMP TABLE IF NOT EXISTS _cat_alpha (
    trader_id INTEGER, profit REAL, efficiency REAL, precision_s REAL,
    conviction REAL, asymmetry REAL, alpha REAL, tags TEXT
  )`);
  await query(`TRUNCATE _cat_alpha`);

  const CHUNK = 500;
  for (let i = 0; i < scores.length; i += CHUNK) {
    const chunk = scores.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const s of chunk) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(s.traderId, s.profit, s.efficiency, s.precision, s.conviction, s.asymmetry, s.alpha, s.tags);
    }

    await query(
      `INSERT INTO _cat_alpha (trader_id, profit, efficiency, precision_s, conviction, asymmetry, alpha, tags) VALUES ${values.join(',')}`,
      params
    );
  }

  await query(`
    UPDATE trader_category_stats SET
      profit_score = a.profit,
      efficiency_score = a.efficiency,
      precision_score = a.precision_s,
      conviction_score = a.conviction,
      asymmetry_score = a.asymmetry,
      alpha_score = a.alpha,
      alpha_tags = a.tags,
      updated_at = NOW()
    FROM _cat_alpha a
    WHERE trader_category_stats.trader_id = a.trader_id
      AND trader_category_stats.category = $1
  `, [category]);

  await query(`DROP TABLE IF EXISTS _cat_alpha`);
}

/**
 * Score all traders globally with alpha scoring.
 */
export async function scoreGlobalAlpha(minTrades: number = 50): Promise<number> {
  const start = Date.now();

  // Fetch all qualifying traders in one query
  const tradersResult = await query(
    `SELECT id, total_trades AS total_trades, total_markets AS total_markets,
            win_rate, roi, total_pnl
     FROM traders
     WHERE total_trades >= $1 AND total_markets >= 1
       AND win_rate IS NOT NULL`,
    [minTrades]
  );

  const traders = tradersResult.rows;
  if (traders.length === 0) {
    log.info('No qualifying traders for global alpha');
    return 0;
  }

  log.info({ count: traders.length }, 'Scoring global alpha');

  // Build asymmetry map — single bulk query
  const asymmetryMap = await buildAsymmetryMap(minTrades);

  const mapped = traders.map((t: any) => ({
    id: t.id,
    total_markets: t.total_markets,
    win_rate: t.win_rate,
    roi: t.roi,
    total_pnl: t.total_pnl,
    total_trades: t.total_trades,
  }));

  // Compute scores in memory (fast)
  const allScores = computeAlphaScores(mapped, asymmetryMap);

  // Bulk update — temp table + single UPDATE JOIN
  await bulkUpdateTraderAlpha(allScores);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log.info({ scored: allScores.length, elapsed: `${elapsed}s` }, 'Global alpha scoring complete');
  return allScores.length;
}

/**
 * Score traders for a specific category.
 */
export async function scoreCategoryAlpha(category: string, minTrades: number = 30): Promise<number> {
  const start = Date.now();

  // Use trader_category_stats (already populated by composite scorer)
  const tradersResult = await query(
    `SELECT tcs.trader_id AS id, tcs.total_trades, tcs.total_markets,
            tcs.win_rate, tcs.roi, tcs.total_pnl
     FROM trader_category_stats tcs
     WHERE tcs.category = $1
       AND tcs.total_trades >= $2
       AND tcs.total_markets >= 1
       AND tcs.win_rate IS NOT NULL`,
    [category, minTrades]
  );

  const traders = tradersResult.rows;
  if (traders.length === 0) {
    log.info({ category }, 'No qualifying traders for category alpha');
    return 0;
  }

  log.info({ category, count: traders.length }, 'Scoring category alpha');

  const asymmetryMap = await buildAsymmetryMap(minTrades, category);

  const mapped = traders.map((t: any) => ({
    id: t.id,
    total_markets: t.total_markets,
    win_rate: t.win_rate,
    roi: t.roi,
    total_pnl: t.total_pnl,
    total_trades: t.total_trades,
  }));

  const allScores = computeAlphaScores(mapped, asymmetryMap);

  // Bulk update category stats
  await bulkUpdateCategoryAlpha(allScores, category);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log.info({ category, scored: allScores.length, elapsed: `${elapsed}s` }, 'Category alpha scoring complete');
  return allScores.length;
}

export async function scoreAllAlpha(minTrades: number = 50): Promise<{ global: number; perCategory: Record<string, number> }> {
  const categoriesResult = await query(`SELECT DISTINCT category FROM events ORDER BY category`);
  const categories = categoriesResult.rows.map((r: { category: string }) => r.category);

  log.info({ categories }, 'Starting full alpha scoring');

  const globalScored = await scoreGlobalAlpha(minTrades);

  const categoryMinTrades = Math.max(10, Math.floor(minTrades / 2));
  const perCategory: Record<string, number> = {};
  for (const cat of categories) {
    perCategory[cat] = await scoreCategoryAlpha(cat, categoryMinTrades);
  }

  return { global: globalScored, perCategory };
}
