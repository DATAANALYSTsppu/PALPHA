import { loadAllCategories } from '../registry.js';
import { runBacktest, type BacktestConfig } from '../backtest/engine.js';
import { shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:backtest');

async function main() {
  await loadAllCategories();

  const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];
  const daysArg = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '30');
  const balanceArg = parseInt(process.argv.find(a => a.startsWith('--balance='))?.split('=')[1] || '1000');
  const positionArg = parseInt(process.argv.find(a => a.startsWith('--position='))?.split('=')[1] || '10');
  const minAlphaArg = parseFloat(process.argv.find(a => a.startsWith('--min-alpha='))?.split('=')[1] || '60');
  const tradersArg = process.argv.find(a => a.startsWith('--traders='))?.split('=')[1];
  const maxPosArg = parseInt(process.argv.find(a => a.startsWith('--max-positions='))?.split('=')[1] || '10');
  const maxPriceArg = parseFloat(process.argv.find(a => a.startsWith('--max-price='))?.split('=')[1] || '0.70');
  const minPriceArg = process.argv.find(a => a.startsWith('--min-price='))?.split('=')[1];
  const dailyLossArg = parseFloat(process.argv.find(a => a.startsWith('--daily-loss='))?.split('=')[1] || '20');

  const traderIds = tradersArg ? tradersArg.split(',').map(Number) : undefined;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - daysArg * 86400000);

  const cfg: BacktestConfig = {
    category: categoryArg,
    startDate,
    endDate,
    initialBalance: balanceArg,
    positionSize: positionArg,
    maxPricePerShare: maxPriceArg,
    minPricePerShare: minPriceArg != null ? parseFloat(minPriceArg) : undefined,
    maxOpenPositions: maxPosArg,
    dailyLossLimit: dailyLossArg,
    minAlphaScore: minAlphaArg,
    traderIds,
  };

  console.log('\n=== Running Backtest ===');
  console.log(`  Category:       ${cfg.category || 'all'}`);
  console.log(`  Period:         ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`  Balance:        $${cfg.initialBalance}`);
  console.log(`  Position size:  $${cfg.positionSize}`);
  console.log(`  Max positions:  ${cfg.maxOpenPositions}`);
  console.log(`  Price band:     $${cfg.minPricePerShare ?? 0} - $${cfg.maxPricePerShare}`);
  console.log(`  Daily loss cap: $${cfg.dailyLossLimit}`);
  if (traderIds) {
    console.log(`  Trader IDs:     ${traderIds.join(', ')}`);
  } else {
    console.log(`  Min Alpha:      ${cfg.minAlphaScore}`);
  }
  console.log('');

  const result = await runBacktest(cfg);

  console.log('\n=== Backtest Results ===');
  console.log(`  Total Return:  $${result.totalReturn.toFixed(2)} (${result.totalReturnPct.toFixed(2)}%)`);
  console.log(`  Sharpe Ratio:  ${result.sharpeRatio.toFixed(2)}`);
  console.log(`  Max Drawdown:  $${result.maxDrawdown.toFixed(2)} (${result.maxDrawdownPct.toFixed(2)}%)`);
  console.log(`  Win Rate:      ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`  Total Trades:  ${result.totalTrades} (W: ${result.wins} / L: ${result.losses})`);

  if (result.perTrader.length > 0) {
    console.log('\n=== Per-Trader Breakdown ===');
    for (const t of result.perTrader.slice(0, 10)) {
      console.log(`  ${(t.name || t.wallet.substring(0, 10)).padEnd(20)} | Trades: ${String(t.trades).padStart(4)} | PnL: $${t.pnl.toFixed(2)}`);
    }
  }

  console.log('\nResult saved to backtest_runs table.');
  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
