/**
 * Paper copy trading — monitors target traders and simulates positions.
 *
 * Usage: npx tsx packages/core/src/cli/paper-trader.ts
 *
 * Config env vars:
 *   PAPER_POSITION_SIZE=5          — USD per position (default $5)
 *   PAPER_MAX_POSITIONS=10         — max open positions (default 10)
 *   PAPER_MAX_PRICE=0.95           — max entry price (default $0.95)
 *   PAPER_MAX_HOURS_TO_RESOLUTION=24 — only trade near-term events (default 24h)
 *   PAPER_DAILY_LOSS_LIMIT=20      — stop after daily loss (default $20)
 *   PAPER_EXCLUDE_SUBCATEGORIES=Other — comma-separated subcategories to skip
 *   PAPER_POLL_INTERVAL=60000      — poll every 60s (default)
 */

import { loadAllCategories } from '../registry.js';
import { shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { PaperTradingEngine } from '../trading/paper.js';
import { detectSignals, checkOpenPositions, getFilterConfig } from '../services/signal-detector.js';
import { getActiveTargets, getAccount, updateUnrealizedPnl } from '../services/copy-trader.js';

const log = createLogger('cli:paper-trader');

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
let running = true;

async function main() {
  await loadAllCategories();

  const engine = new PaperTradingEngine();
  const config = getFilterConfig('paper');

  console.log('\n=== Polymarket PAPER Copy Trader ===');
  console.log(`  Position size:    $${config.positionSize}`);
  console.log(`  Max positions:    ${config.maxPositions}`);
  console.log(`  Max price:        $${config.maxPrice}`);
  console.log(`  Max hours to res: ${config.maxHoursToResolution}h`);
  console.log(`  Daily loss limit: $${config.dailyLossLimit}`);
  console.log(`  Exclude subcats:  ${config.excludeSubcategories.join(', ') || 'none'}`);
  console.log(`  Convert threshold:$${config.convertPriceThreshold}`);
  console.log(`  Poll interval:    ${config.pollIntervalMs / 1000}s`);
  console.log('');

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

      // Update unrealized PnL (paper-only: fetches current midpoint prices)
      await updateUnrealizedPnl();

      // Log account status
      const account = await getAccount('paper');
      if (account) {
        const openCount = await engine.getOpenPositionCount();
        log.info({
          open: openCount,
          balance: account.balance?.toFixed(2),
          realized: account.realized_pnl?.toFixed(2),
          unrealized: account.unrealized_pnl?.toFixed(2),
          targets: targets.length,
        }, 'Paper trading cycle complete');
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Error in paper trading loop');
    }

    if (running) await sleep(config.pollIntervalMs);
  }

  await shutdown();
  log.info('Paper trader stopped');
}

main().catch(err => { console.error(err); process.exit(1); });
