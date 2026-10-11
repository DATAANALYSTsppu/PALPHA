/**
 * scan-prices-v2 — fetch historical midpoint price series per market.
 *
 * For each market in our DB, pulls the price history for both Yes and No tokens
 * from CLOB /prices-history. Stored in market_price_history for realistic slippage
 * backtesting.
 *
 * Incremental by default: each market resumes from the max timestamp we've
 * stored. First run pulls the full N-month window; subsequent runs only
 * pull points after the last cursor (with a small overlap to catch the
 * current fidelity bucket re-settling).
 *
 * Usage:
 *   npx tsx packages/core/src/cli/scan-prices-v2.ts [--months=6] [--fidelity=60] [--limit=N] [--full-rescan]
 *
 * Fidelity: 1 = 1min, 60 = 1hr, 1440 = daily
 * Default 60 (hourly) is a good balance for backtest replay without huge row counts.
 *   --full-rescan   ignore cursors; re-pull the full N-month window for every market
 */

import { loadAllCategories } from '../registry.js';
import { getPriceHistory } from '../api/clob.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:scan-prices-v2');

interface MarketRow {
  id: number;
  condition_id: string;
  outcome_yes_token: string | null;
  outcome_no_token: string | null;
}

// Postgres protocol caps a single query at 65,535 bind params. With 7 params
// per row, 1000 rows/batch (= 7000 params) stays well under the limit even if
// we later add columns. Minute-fidelity over 6 months is ~260k points per token
// — chunking keeps each statement small and each failure bounded.
const PRICES_BATCH_SIZE = 1000;

async function fetchAndStore(
  market: MarketRow,
  outcome: 'Yes' | 'No',
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelity: number
): Promise<{ written: number; maxTs: number }> {
  try {
    const result = await getPriceHistory(tokenId, { startTs, endTs, fidelity });
    const points = result.history || [];
    if (points.length === 0) return { written: 0, maxTs: 0 };

    let maxTs = 0;
    for (const p of points) if (p.t > maxTs) maxTs = p.t;

    let written = 0;
    for (let start = 0; start < points.length; start += PRICES_BATCH_SIZE) {
      const chunk = points.slice(start, start + PRICES_BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      for (const point of chunk) {
        values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, NOW())`);
        params.push(market.id, market.condition_id, tokenId, outcome, point.t, point.p, fidelity);
      }

      await query(
        `INSERT INTO market_price_history
           (market_id, condition_id, token_id, outcome, timestamp, price, fidelity, fetched_at)
         VALUES ${values.join(',')}
         ON CONFLICT (token_id, timestamp, fidelity) DO NOTHING`,
        params
      );
      written += chunk.length;
    }

    return { written, maxTs };
  } catch (err) {
    log.error({ conditionId: market.condition_id, outcome, err: (err as Error).message }, 'Price history fetch failed');
    return { written: 0, maxTs: 0 };
  }
}

async function upsertCheckpoint(source: string, cursor: string, records: number, status: string, error?: string) {
  await query(
    `INSERT INTO ingest_checkpoints (source, cursor_value, records_ingested, last_run_at, last_error, status, updated_at)
     VALUES ($1, $2, $3, NOW(), $4, $5, NOW())
     ON CONFLICT (source) DO UPDATE SET
       cursor_value = EXCLUDED.cursor_value,
       records_ingested = EXCLUDED.records_ingested,
       last_run_at = NOW(),
       last_error = EXCLUDED.last_error,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [source, cursor, records, error || null, status]
  );
}

/**
 * Read the last-seen price timestamp for this market from its checkpoint.
 * Cursor format: "yesMaxTs:noMaxTs" (unix seconds). Returns 0s if missing.
 */
async function getPriceCursor(conditionId: string): Promise<{ yes: number; no: number }> {
  const source = `prices-v2:${conditionId}`;
  const res = await query(
    `SELECT cursor_value FROM ingest_checkpoints WHERE source = $1 AND status = 'idle'`,
    [source],
  );
  const raw = res.rows[0]?.cursor_value;
  if (!raw || typeof raw !== 'string' || !raw.includes(':')) return { yes: 0, no: 0 };
  const [y, n] = raw.split(':').map(s => parseInt(s, 10));
  return {
    yes: Number.isFinite(y) && y > 0 ? y : 0,
    no: Number.isFinite(n) && n > 0 ? n : 0,
  };
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await loadAllCategories();

  const months = parseInt(process.argv.find(a => a.startsWith('--months='))?.split('=')[1] || '6');
  const fidelity = parseInt(process.argv.find(a => a.startsWith('--fidelity='))?.split('=')[1] || '60');
  const limitArg = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');
  const fullRescan = process.argv.includes('--full-rescan');
  // Comma-separated list of event.category values to include. Defaults to the
  // categories we actively track. Override with --category=sports or similar.
  const categoriesArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1]
    || process.env.SCAN_V2_CATEGORIES
    || 'sports,weather';
  const categories = categoriesArg.split(',').map(s => s.trim()).filter(Boolean);

  const endTs = Math.floor(Date.now() / 1000);
  const fullStartTs = endTs - months * 30 * 24 * 3600;
  // Overlap = 2× fidelity buckets, so the current-bucket reseat still
  // overwrites correctly via ON CONFLICT DO NOTHING (dedup by timestamp).
  const overlapSec = Math.max(3600, fidelity * 60 * 2);

  const catPlaceholders = categories.map((_, i) => `$${i + 1}`).join(',');
  const whereClause = `WHERE e.category IN (${catPlaceholders})
    AND m.outcome_yes_token IS NOT NULL AND m.outcome_no_token IS NOT NULL`;
  const limitClause = limitArg > 0 ? ` LIMIT ${limitArg}` : '';

  const marketsRes = await query(
    `SELECT m.id, m.condition_id, m.outcome_yes_token, m.outcome_no_token
     FROM markets m JOIN events e ON m.event_id = e.id
     ${whereClause}
     ORDER BY m.id${limitClause}`,
    categories
  );

  const markets: MarketRow[] = marketsRes.rows;
  console.log(`\n=== Polymarket Price History Scan (v2) ===`);
  console.log(`  Categories:  ${categories.join(', ')}`);
  console.log(`  Markets:     ${markets.length}`);
  console.log(`  Full window: ${new Date(fullStartTs * 1000).toISOString()} → ${new Date(endTs * 1000).toISOString()}`);
  console.log(`  Fidelity:    ${fidelity} min`);
  console.log(`  Mode:        ${fullRescan ? 'full rescan (ignoring cursors)' : 'incremental (resume from cursor)'}`);
  console.log('');

  let totalPoints = 0;
  let failedMarkets = 0;
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const source = `prices-v2:${m.condition_id}`;

    const prior = fullRescan ? { yes: 0, no: 0 } : await getPriceCursor(m.condition_id);
    // Per-token window: if we have a cursor, start 2 buckets before it to
    // catch any late-arriving points that settled into an earlier bucket.
    // Otherwise fall back to the full N-month window.
    const yesStart = prior.yes > 0 ? Math.max(fullStartTs, prior.yes - overlapSec) : fullStartTs;
    const noStart  = prior.no  > 0 ? Math.max(fullStartTs, prior.no  - overlapSec) : fullStartTs;

    await upsertCheckpoint(source, `${prior.yes}:${prior.no}`, 0, 'running');

    let marketPoints = 0;
    let marketErr: string | null = null;
    let yesMaxTs = prior.yes;
    let noMaxTs = prior.no;
    try {
      if (m.outcome_yes_token) {
        const r = await fetchAndStore(m, 'Yes', m.outcome_yes_token, yesStart, endTs, fidelity);
        marketPoints += r.written;
        if (r.maxTs > yesMaxTs) yesMaxTs = r.maxTs;
        await sleep(100);
      }
      if (m.outcome_no_token) {
        const r = await fetchAndStore(m, 'No', m.outcome_no_token, noStart, endTs, fidelity);
        marketPoints += r.written;
        if (r.maxTs > noMaxTs) noMaxTs = r.maxTs;
        await sleep(100);
      }
    } catch (err) {
      marketErr = (err as Error).message;
    }
    totalPoints += marketPoints;

    if (marketErr) {
      failedMarkets++;
      // Don't advance cursor on error — next run retries the same window.
      await upsertCheckpoint(source, `${prior.yes}:${prior.no}`, marketPoints, 'error', marketErr);
    } else {
      await upsertCheckpoint(source, `${yesMaxTs}:${noMaxTs}`, marketPoints, 'idle');
    }

    if ((i + 1) % 10 === 0) {
      log.info({ progress: `${i + 1}/${markets.length}`, totalPoints, failedMarkets }, 'Price scan progress');
    }
  }

  console.log(`\n=== Price History Scan Results ===`);
  console.log(`  Markets scanned: ${markets.length}`);
  console.log(`  Price points:    ${totalPoints}`);
  console.log(`  Failed markets:  ${failedMarkets}`);

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
