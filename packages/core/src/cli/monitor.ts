/**
 * Continuous monitoring daemon.
 * Periodically scans for new markets, discovers traders, and re-scores.
 *
 * Usage: npx tsx packages/core/src/cli/monitor.ts
 *
 * Schedule:
 *   - Market scan:   every 30 minutes
 *   - Trader scan:   every 2 hours (new events only)
 *   - Composite score: every 6 hours
 *   - Alpha score:   every 6 hours (after composite)
 *
 * Environment:
 *   MONITOR_SCAN_INTERVAL=1800000      (30 min default)
 *   MONITOR_TRADER_INTERVAL=7200000    (2 hr default)
 *   MONITOR_SCORE_INTERVAL=21600000    (6 hr default)
 */

import { loadAllCategories, getAllCategories } from '../registry.js';
import { paginateEvents } from '../api/gamma.js';
import { fetchTradesForEvent } from '../api/data.js';
import { processEventTrades } from '../services/trader-discovery.js';
import { scoreAllTraders } from '../services/trader-scorer.js';
import { scoreAllAlpha } from '../services/alpha-scorer.js';
import { runBacktest } from '../backtest/engine.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('monitor');
const RUN_ONCE = process.argv.includes('--run-once');
const BACKFILL = process.argv.includes('--backfill');
const BACKTEST_TRADERS = process.argv.find(a => a.startsWith('--traders='))?.split('=')[1];

const SCAN_INTERVAL = parseInt(process.env.MONITOR_SCAN_INTERVAL || '1800000');     // 30 min
const TRADER_INTERVAL = parseInt(process.env.MONITOR_TRADER_INTERVAL || '7200000');  // 2 hr
const SCORE_INTERVAL = parseInt(process.env.MONITOR_SCORE_INTERVAL || '21600000');   // 6 hr

let running = true;
let lastMarketScan = 0;
let lastTraderScan = 0;
let lastScore = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Market Scan ────────────────────────────────────────────────────

async function upsertEventAndMarkets(plugin: any, event: any): Promise<{ newEvents: number; newMarkets: number }> {
  const classified = plugin.classifyEvent(event);
  if (!classified) return { newEvents: 0, newMarkets: 0 };

  let newEvents = 0;
  let newMarkets = 0;

  const eventResult = await query(
    `INSERT INTO events (poly_event_id, title, slug, description, category, subcategory, subcategory_detail, end_date, tags, is_resolved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (poly_event_id) DO UPDATE SET
       title = EXCLUDED.title, end_date = EXCLUDED.end_date,
       is_resolved = GREATEST(events.is_resolved::int, EXCLUDED.is_resolved::int)::boolean,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
    [classified.polyEventId, classified.title, classified.slug, classified.description,
     classified.category, classified.subcategory, classified.subcategoryDetail,
     classified.endDate, classified.tags, event.closed || false]
  );

  if (eventResult.rows[0].is_new) newEvents++;
  const eventDbId = eventResult.rows[0].id;

  if (event.markets) {
    for (const market of event.markets) {
      let yesToken: string | null = null;
      let noToken: string | null = null;
      if (market.clobTokenIds) {
        try { const t = JSON.parse(market.clobTokenIds); yesToken = t[0]; noToken = t[1]; } catch {}
      }
      let resolvedTo: string | null = null;
      if (market.outcomePrices) {
        try {
          const p = JSON.parse(market.outcomePrices);
          if (parseFloat(p[0]) >= 0.99) resolvedTo = 'Yes';
          else if (parseFloat(p[1]) >= 0.99) resolvedTo = 'No';
        } catch {}
      }

      const mResult = await query(
        `INSERT INTO markets (event_id, condition_id, question, slug, outcome_yes_token, outcome_no_token, is_closed, resolved_to, end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (condition_id) DO UPDATE SET
           is_closed = EXCLUDED.is_closed,
           resolved_to = COALESCE(EXCLUDED.resolved_to, markets.resolved_to),
           outcome_yes_token = COALESCE(EXCLUDED.outcome_yes_token, markets.outcome_yes_token),
           outcome_no_token = COALESCE(EXCLUDED.outcome_no_token, markets.outcome_no_token)
         RETURNING (xmax = 0) AS is_new`,
        [eventDbId, market.conditionId, market.question, market.slug,
         yesToken, noToken, market.closed || false, resolvedTo, market.endDate || null]
      );
      if (mResult.rows[0].is_new) newMarkets++;
    }
  }

  return { newEvents, newMarkets };
}

async function scanMarkets(): Promise<{ events: number; markets: number }> {
  const categories = getAllCategories();
  let totalEvents = 0;
  let totalMarkets = 0;

  for (const plugin of categories) {
    // Scan active events
    log.info({ category: plugin.name }, 'Scanning active events...');
    let pageCount = 0;
    let matchedCount = 0;
    for await (const batch of paginateEvents({ active: true, closed: false }, 50)) {
      pageCount++;
      for (const event of batch) {
        if (!plugin.isMatchingEvent(event)) continue;
        matchedCount++;
        const { newEvents, newMarkets } = await upsertEventAndMarkets(plugin, event);
        totalEvents += newEvents;
        totalMarkets += newMarkets;
      }
      if (pageCount % 5 === 0) {
        log.info({ category: plugin.name, pages: pageCount, matched: matchedCount, newEvents: totalEvents, newMarkets: totalMarkets }, 'Active scan progress');
      }
    }
    log.info({ category: plugin.name, pages: pageCount, matched: matchedCount }, 'Active scan complete');

    // Backfill: also scan closed/resolved events (catches April 1-13 gap and resolution updates)
    if (BACKFILL) {
      log.info({ category: plugin.name }, 'Backfilling closed/resolved events...');
      let bfPages = 0;
      let bfMatched = 0;
      for await (const batch of paginateEvents({ active: false, closed: true }, 200)) {
        bfPages++;
        for (const event of batch) {
          if (!plugin.isMatchingEvent(event)) continue;
          bfMatched++;
          const { newEvents, newMarkets } = await upsertEventAndMarkets(plugin, event);
          totalEvents += newEvents;
          totalMarkets += newMarkets;
        }
        if (bfPages % 5 === 0) {
          log.info({ category: plugin.name, pages: bfPages, matched: bfMatched, newEvents: totalEvents, newMarkets: totalMarkets }, 'Backfill progress');
        }
      }
      log.info({ category: plugin.name, pages: bfPages, matched: bfMatched }, 'Backfill complete');
    }
  }

  return { events: totalEvents, markets: totalMarkets };
}

// ─── Trader Scan (new events only) ──────────────────────────────────

async function scanTraders(): Promise<{ events: number; trades: number; traders: number }> {
  const eventsResult = await query(
    `SELECT e.id, e.poly_event_id, e.title
     FROM events e
     WHERE e.id NOT IN (SELECT event_id FROM scan_progress)
     ORDER BY e.id
     LIMIT 500`
  );

  const events = eventsResult.rows;
  let totalTrades = 0;
  let totalTraders = 0;

  if (events.length > 0) {
    log.info({ unscannedEvents: events.length }, 'Starting trader scan');
  }

  for (let ei = 0; ei < events.length; ei++) {
    const event = events[ei];
    try {
      const trades = await fetchTradesForEvent(event.poly_event_id);
      if (trades.length === 0) {
        await query(`INSERT INTO scan_progress (event_id, trades_fetched, traders_found) VALUES ($1, 0, 0) ON CONFLICT (event_id) DO NOTHING`, [event.id]);
        if ((ei + 1) % 10 === 0) {
          log.info({ progress: `${ei + 1}/${events.length}`, totalTrades, totalTraders }, 'Trader scan progress');
        }
        continue;
      }

      const marketsResult = await query(`SELECT id, condition_id FROM markets WHERE event_id = $1`, [event.id]);
      const conditionMap = new Map<string, number>();
      for (const m of marketsResult.rows) conditionMap.set(m.condition_id, m.id);

      const { newTraders, newTrades } = await processEventTrades(trades, event.id, conditionMap);
      totalTrades += newTrades;
      totalTraders += newTraders;

      await query(
        `INSERT INTO scan_progress (event_id, trades_fetched, traders_found) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO UPDATE SET trades_fetched = $2, traders_found = $3, scanned_at = NOW()`,
        [event.id, trades.length, newTraders]
      );

      if ((ei + 1) % 10 === 0 || ei === events.length - 1) {
        log.info({ progress: `${ei + 1}/${events.length}`, trades: trades.length, totalTrades, totalTraders }, 'Trader scan progress');
      }
    } catch (err) {
      log.error({ event: event.title, err: (err as Error).message }, 'Failed to scan event');
    }

    await sleep(200);
  }

  return { events: events.length, trades: totalTrades, traders: totalTraders };
}

// ─── Run Once Mode ──────────────────────────────────────────────────

async function runOnce() {
  const start = Date.now();
  const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];

  console.log('\n=== Polymarket Full Pipeline (run-once) ===\n');

  // Step 1: Market scan
  console.log('Step 1/5: Scanning markets...');
  let stepStart = Date.now();
  try {
    const result = await scanMarkets();
    console.log(`  New events: ${result.events}, New markets: ${result.markets} (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Market scan failed');
  }

  // Step 2: Trader scan
  console.log('\nStep 2/5: Scanning traders...');
  stepStart = Date.now();
  try {
    const result = await scanTraders();
    console.log(`  Events scanned: ${result.events}, New trades: ${result.trades}, New traders: ${result.traders} (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Trader scan failed');
  }

  // Step 3: Composite scoring
  console.log('\nStep 3/5: Running composite scoring...');
  stepStart = Date.now();
  try {
    const count = await scoreAllTraders();
    console.log(`  Scored: ${count} traders (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Composite scoring failed');
  }

  // Step 4: Alpha scoring
  console.log('\nStep 4/5: Running alpha scoring...');
  stepStart = Date.now();
  try {
    const result = await scoreAllAlpha(50);
    console.log(`  Global: ${result.global} traders`);
    for (const [cat, count] of Object.entries(result.perCategory)) {
      console.log(`  ${cat}: ${count} traders`);
    }
    console.log(`  (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Alpha scoring failed');
  }

  // Step 5: Backtest (if traders specified)
  if (BACKTEST_TRADERS) {
    const traderIds = BACKTEST_TRADERS.split(',').map(Number);
    const daysArg = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '45');
    const balanceArg = parseInt(process.argv.find(a => a.startsWith('--balance='))?.split('=')[1] || '100');
    const positionArg = parseInt(process.argv.find(a => a.startsWith('--position='))?.split('=')[1] || '5');

    console.log(`\nStep 5/5: Running backtest on ${traderIds.length} traders (${daysArg} days)...`);
    try {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - daysArg * 86400000);
      const result = await runBacktest({
        category: categoryArg,
        startDate,
        endDate,
        initialBalance: balanceArg,
        positionSize: positionArg,
        maxPricePerShare: 0.70,
        maxOpenPositions: 10,
        dailyLossLimit: 20,
        traderIds,
      });

      console.log(`\n=== Backtest Results ===`);
      console.log(`  Return:       $${result.totalReturn.toFixed(2)} (${result.totalReturnPct.toFixed(2)}%)`);
      console.log(`  Sharpe:       ${result.sharpeRatio.toFixed(2)}`);
      console.log(`  Max Drawdown: $${result.maxDrawdown.toFixed(2)} (${result.maxDrawdownPct.toFixed(2)}%)`);
      console.log(`  Win Rate:     ${(result.winRate * 100).toFixed(1)}%`);
      console.log(`  Trades:       ${result.totalTrades} (W: ${result.wins} / L: ${result.losses})`);

      if (result.perTrader.length > 0) {
        console.log(`\n  Per-Trader:`);
        for (const t of result.perTrader) {
          console.log(`    ${(t.name || t.wallet.substring(0, 10)).padEnd(20)} | Trades: ${String(t.trades).padStart(4)} | PnL: $${t.pnl.toFixed(2)}`);
        }
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Backtest failed');
    }
  } else {
    console.log('\nStep 5/5: Skipped backtest (no --traders= specified)');
  }

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  console.log(`\n=== Pipeline complete in ${elapsed} minutes ===\n`);
}

// ─── Main Loop ──────────────────────────────────────────────────────

async function main() {
  await loadAllCategories();

  if (RUN_ONCE) {
    await runOnce();
    await shutdown();
    return;
  }

  log.info({
    scanInterval: `${SCAN_INTERVAL / 60000}m`,
    traderInterval: `${TRADER_INTERVAL / 60000}m`,
    scoreInterval: `${SCORE_INTERVAL / 60000}m`,
  }, 'Monitor daemon started');

  process.on('SIGINT', () => { running = false; log.info('Shutting down...'); });
  process.on('SIGTERM', () => { running = false; log.info('Shutting down...'); });

  while (running) {
    const now = Date.now();

    // Market scan
    if (now - lastMarketScan >= SCAN_INTERVAL) {
      try {
        log.info('Running market scan...');
        const result = await scanMarkets();
        log.info(result, 'Market scan complete');
        lastMarketScan = now;
      } catch (err) {
        log.error({ err: (err as Error).message }, 'Market scan failed');
      }
    }

    // Trader scan
    if (now - lastTraderScan >= TRADER_INTERVAL) {
      try {
        log.info('Running trader scan...');
        const result = await scanTraders();
        log.info(result, 'Trader scan complete');
        lastTraderScan = now;
      } catch (err) {
        log.error({ err: (err as Error).message }, 'Trader scan failed');
      }
    }

    // Scoring (composite + alpha)
    if (now - lastScore >= SCORE_INTERVAL) {
      try {
        log.info('Running scoring...');
        const compositeCount = await scoreAllTraders();
        log.info({ compositeCount }, 'Composite scoring complete');

        const alphaResult = await scoreAllAlpha(50);
        log.info(alphaResult, 'Alpha scoring complete');

        lastScore = now;
      } catch (err) {
        log.error({ err: (err as Error).message }, 'Scoring failed');
      }
    }

    // Sleep 1 minute between checks
    if (running) await sleep(60000);
  }

  await shutdown();
  log.info('Monitor stopped');
}

main().catch(err => { console.error(err); process.exit(1); });
