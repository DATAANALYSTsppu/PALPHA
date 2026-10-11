import { loadAllCategories } from '../registry.js';
import { fetchTradesForEvent } from '../api/data.js';
import { processEventTrades } from '../services/trader-discovery.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:scan-traders');

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await loadAllCategories();

  const forceAll = process.argv.includes('--force');
  const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];
  const limitArg = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];

  if (!forceAll) {
    whereClause += ` AND e.id NOT IN (SELECT event_id FROM scan_progress)`;
  }
  if (categoryArg) {
    params.push(categoryArg);
    whereClause += ` AND e.category = $${params.length}`;
  }

  let limitClause = '';
  if (limitArg > 0) {
    limitClause = ` LIMIT ${limitArg}`;
  }

  const eventsResult = await query(
    `SELECT e.id, e.poly_event_id, e.title, e.category FROM events e ${whereClause} ORDER BY e.id${limitClause}`,
    params
  );

  const events = eventsResult.rows;
  log.info({ total: events.length, force: forceAll, category: categoryArg }, 'Events to scan');

  let totalNewTraders = 0;
  let totalNewTrades = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    log.info({ progress: `${i + 1}/${events.length}`, event: event.title }, 'Scanning event');

    try {
      const trades = await fetchTradesForEvent(event.poly_event_id);
      if (trades.length === 0) {
        await query(
          `INSERT INTO scan_progress (event_id, trades_fetched, traders_found) VALUES ($1, 0, 0) ON CONFLICT (event_id) DO UPDATE SET scanned_at = NOW()`,
          [event.id]
        );
        continue;
      }

      // Build condition_id -> market_id map
      const marketsResult = await query(
        `SELECT id, condition_id FROM markets WHERE event_id = $1`,
        [event.id]
      );
      const conditionMap = new Map<string, number>();
      for (const m of marketsResult.rows) {
        conditionMap.set(m.condition_id, m.id);
      }

      const { newTraders, newTrades } = await processEventTrades(trades, event.id, conditionMap);
      totalNewTraders += newTraders;
      totalNewTrades += newTrades;

      await query(
        `INSERT INTO scan_progress (event_id, trades_fetched, traders_found) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO UPDATE SET trades_fetched = $2, traders_found = $3, scanned_at = NOW()`,
        [event.id, trades.length, newTraders]
      );

      log.info({ trades: trades.length, newTraders, newTrades }, 'Event scanned');
    } catch (err) {
      log.error({ event: event.title, err }, 'Failed to scan event');
    }

    await sleep(200);
  }

  console.log(`\n=== Trader Scan Results ===`);
  console.log(`  Events scanned: ${events.length}`);
  console.log(`  New traders: ${totalNewTraders}`);
  console.log(`  New trades: ${totalNewTrades}`);

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
