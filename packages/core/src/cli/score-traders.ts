import { loadAllCategories } from '../registry.js';
import { scoreAllTraders } from '../services/trader-scorer.js';
import { shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:score-traders');

async function main() {
  await loadAllCategories();

  log.info('Starting composite scoring...');
  const start = Date.now();
  const scored = await scoreAllTraders();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\nScored ${scored} traders in ${elapsed}s`);
  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
