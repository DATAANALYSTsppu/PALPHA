import { runMigrations } from '../db/migrate.js';
import { shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:migrate');

async function main() {
  try {
    log.info('Running database migrations...');
    await runMigrations();
    log.info('Migrations complete');
  } catch (err) {
    log.error({ err }, 'Migration failed');
    process.exit(1);
  } finally {
    await shutdown();
  }
}

main();
