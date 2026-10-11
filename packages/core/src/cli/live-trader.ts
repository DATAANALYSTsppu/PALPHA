/**
 * Live copy trading — monitors target traders and executes real CLOB orders.
 *
 * Usage: npx tsx packages/core/src/cli/live-trader.ts
 *
 * Env vars required:
 *   POLY_PRIVATE_KEY  — your wallet private key
 *   DATABASE_URL      — your postgres connection
 *
 * Optional (saved after first derivation):
 *   POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE
 *
 * Config env vars:
 *   LIVE_POSITION_SIZE=5              — USD per position (default $5)
 *   LIVE_MAX_POSITIONS=10             — max open positions (default 10)
 *   LIVE_MAX_PRICE=0.95               — max entry price (default $0.95)
 *   LIVE_MAX_HOURS_TO_RESOLUTION=24   — only trade near-term events (default 24h)
 *   LIVE_DAILY_LOSS_LIMIT=20          — stop after daily loss (default $20)
 *   LIVE_EXCLUDE_SUBCATEGORIES=Other  — comma-separated subcategories to skip
 *   LIVE_POLL_INTERVAL=60000          — poll every 60s (default)
 */

import { loadAllCategories } from '../registry.js';
import { shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { LiveTradingEngine } from '../trading/live.js';
import { detectSignals, checkOpenPositions, getFilterConfig } from '../services/signal-detector.js';
import { getActiveTargets, getAccount } from '../services/copy-trader.js';

const log = createLogger('cli:live-trader');

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
let running = true;

async function main() {
  await loadAllCategories();

  const engine = new LiveTradingEngine();
  const config = getFilterConfig('live');

  console.log('\n=== Polymarket LIVE Copy Trader ===');
  console.log(`  Position size:    $${config.positionSize}`);
  console.log(`  Max positions:    ${config.maxPositions}`);
  console.log(`  Max price:        $${config.maxPrice}`);
  console.log(`  Max hours to res: ${config.maxHoursToResolution}h`);
  console.log(`  Daily loss limit: $${config.dailyLossLimit}`);
  console.log(`  Exclude subcats:  ${config.excludeSubcategories.join(', ') || 'none'}`);
  console.log(`  Convert threshold:$${config.convertPriceThreshold}`);
  console.log(`  Poll interval:    ${config.pollIntervalMs / 1000}s`);
  console.log('');

  // Initialize live trading engine (derives API keys)
  await engine.initialize();

  process.on('SIGINT', () => { running = false; log.info('Shutting down...'); });
  process.on('SIGTERM', () => { running = false; log.info('Shutting down...'); });

  while (running) {
    try {
      const targets = await getActiveTargets();
      if (targets.length === 0) {
        log.info('No active copy targets');
      } else {
        for (const target of targets) {
          if (!running) break;
          await detectSignals(target, engine, config);
        }
      }

      // Check for resolved/expired positions
      await checkOpenPositions(engine);

      // Refresh the real on-chain balance once per cycle. getBalance() reads
      // it from CLOB and mirrors it into the accounts row, so the dashboard
      // stays current even on idle cycles (no candidate trades to gate).
      const balance = await engine.getBalance();

      // Log status
      const openCount = await engine.getOpenPositionCount();
      const account = await getAccount('live');
      log.info({
        open: openCount,
        balance: balance.toFixed(2),
        realized_pnl: (account?.realized_pnl || 0).toFixed(2),
        targets: targets.length,
      }, 'Live trading cycle complete');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Error in live trading loop');
    }

    if (running) await sleep(config.pollIntervalMs);
  }

  await shutdown();
  log.info('Live trader stopped');
}

main().catch(err => { console.error(err); process.exit(1); });
