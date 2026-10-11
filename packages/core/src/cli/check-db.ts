/**
 * check-db — print current DB connection + schema state.
 *
 * Use before running migrations to confirm DATABASE_URL is pointing at the
 * intended target, and afterward to verify tables were created.
 *
 * Usage:
 *   npm run db:check
 */

import { query, shutdown } from '../db/pool.js';
import { config } from '../config.js';

function maskUrl(url: string): string {
  // postgres://user:password@host:port/db?params  →  postgres://user:***@host:port/db
  return url.replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1***$2');
}

async function scalar(sql: string): Promise<string | null> {
  try {
    const r = await query(sql);
    return r.rows[0] ? String(Object.values(r.rows[0])[0]) : null;
  } catch (err) {
    return `ERR: ${(err as Error).message}`;
  }
}

async function count(table: string): Promise<string> {
  try {
    const r = await query(`SELECT COUNT(*)::text AS count FROM ${table}`);
    return r.rows[0]?.count ?? '0';
  } catch (err) {
    // Table doesn't exist yet — that's fine, just say "(missing)"
    if ((err as Error).message.includes('does not exist')) return '(missing)';
    return `ERR: ${(err as Error).message}`;
  }
}

async function main() {
  console.log('\n=== Database Connection ===');
  console.log(`  URL:        ${maskUrl(config.database.url)}`);
  console.log(`  Database:   ${await scalar('SELECT current_database()')}`);
  console.log(`  User:       ${await scalar('SELECT current_user')}`);
  console.log(`  Server:     ${await scalar('SELECT inet_server_addr()::text || \':\' || inet_server_port()::text')}`);
  console.log(`  Version:    ${await scalar('SELECT version()')}`);

  console.log('\n=== Migrations Applied ===');
  try {
    const r = await query(
      `SELECT filename, applied_at FROM _migrations ORDER BY filename`
    );
    if (r.rows.length === 0) {
      console.log('  (no migrations applied yet — run: npm run db:migrate)');
    } else {
      for (const row of r.rows) {
        console.log(`  ✔ ${row.filename}  (${row.applied_at})`);
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('does not exist')) {
      console.log('  (_migrations table not created yet — run: npm run db:migrate)');
    } else {
      console.log(`  ERR: ${msg}`);
    }
  }

  console.log('\n=== Core Tables (v1) ===');
  for (const t of ['events', 'markets', 'trades', 'traders', 'copy_targets', 'live_positions', 'copy_signals']) {
    console.log(`  ${t.padEnd(20)} ${await count(t)}`);
  }

  console.log('\n=== V2 Enrichment Tables ===');
  for (const t of ['market_price_history', 'orderbook_snapshots', 'position_snapshots', 'execution_log', 'ingest_checkpoints', 'trader_alias_history']) {
    console.log(`  ${t.padEnd(24)} ${await count(t)}`);
  }

  console.log('\n=== V2 Scan Checkpoints ===');
  try {
    const r = await query(
      `SELECT
         split_part(source, ':', 1) AS prefix,
         COUNT(*)::text AS count,
         MAX(last_run_at)::text AS last_run
       FROM ingest_checkpoints
       GROUP BY split_part(source, ':', 1)
       ORDER BY prefix`
    );
    if (r.rows.length === 0) {
      console.log('  (no scans run yet)');
    } else {
      for (const row of r.rows) {
        console.log(`  ${row.prefix.padEnd(16)} ${row.count.padEnd(6)} last run: ${row.last_run || 'never'}`);
      }
    }
  } catch (err) {
    console.log(`  ERR: ${(err as Error).message}`);
  }

  console.log('');
  await shutdown();
}

main().catch(async (err) => {
  console.error('\nFATAL:', err.message);
  try { await shutdown(); } catch { /* ignore */ }
  process.exit(1);
});
