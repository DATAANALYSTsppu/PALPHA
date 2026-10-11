import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { pool, query } from './pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('migrate');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(): Promise<void> {
  // Create migrations tracking table
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Get already applied migrations
  const applied = await query(`SELECT filename FROM _migrations ORDER BY filename`);
  const appliedSet = new Set(applied.rows.map((r: { filename: string }) => r.filename));

  // Get migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      log.info({ file }, 'Already applied, skipping');
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    log.info({ file }, 'Applying migration');

    try {
      await query(sql);
      await query(`INSERT INTO _migrations (filename) VALUES ($1)`, [file]);
      log.info({ file }, 'Migration applied successfully');
    } catch (err) {
      log.error({ file, err }, 'Migration failed');
      throw err;
    }
  }

  log.info('All migrations applied');
}
