import { loadAllCategories } from '../registry.js';
import { scoreAllAlpha } from '../services/alpha-scorer.js';
import { shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:score-alpha');

async function main() {
  await loadAllCategories();

  const minTrades = parseInt(process.argv.find(a => a.startsWith('--min-trades='))?.split('=')[1] || '50');

  log.info({ minTrades }, 'Starting alpha scoring...');
  const start = Date.now();
  const result = await scoreAllAlpha(minTrades);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n=== Alpha Scoring Results (${elapsed}s) ===`);
  console.log(`  Global: ${result.global} traders scored`);
  for (const [cat, count] of Object.entries(result.perCategory)) {
    console.log(`  ${cat}: ${count} traders scored`);
  }

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
