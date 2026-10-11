/**
 * db-query — run an ad-hoc SQL query against the bot's database.
 *
 * Read-only by design: refuses anything that isn't a SELECT/WITH/EXPLAIN/SHOW.
 * Useful on hosts without psql for poking at scan progress, category counts,
 * resolution status breakdowns, etc.
 *
 * Usage:
 *   npm run db:query -- "SELECT category, COUNT(*) FROM events GROUP BY 1"
 *   npm run db:query -- "SELECT * FROM markets ORDER BY volume DESC LIMIT 5"
 *   cat my_query.sql | npm run db:query --
 */

import { query, shutdown } from '../db/pool.js';

function isReadOnly(sql: string): boolean {
  const trimmed = sql.trim().replace(/^\s*--[^\n]*\n/gm, '').trim();
  const first = trimmed.toUpperCase();
  return first.startsWith('SELECT')
    || first.startsWith('WITH')
    || first.startsWith('EXPLAIN')
    || first.startsWith('SHOW');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const json = JSON.stringify(v);
    return json.length > 80 ? json.slice(0, 77) + '...' : json;
  }
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(0 rows)');
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(
    c.length,
    ...rows.map(r => formatValue(r[c]).length),
  ));

  const sep = widths.map(w => '─'.repeat(w)).join('─┼─');
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join(' │ '));
  console.log(sep);
  for (const row of rows) {
    console.log(cols.map((c, i) => formatValue(row[c]).padEnd(widths[i])).join(' │ '));
  }
  console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})`);
}

async function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  // Everything after "--" is the SQL. If nothing, read stdin.
  const argSql = process.argv.slice(2).join(' ').trim();
  const sql = argSql || (await readStdin()).trim();

  if (!sql) {
    console.error('Usage: npm run db:query -- "SELECT ..."');
    console.error('   or: cat query.sql | npm run db:query --');
    process.exit(1);
  }

  if (!isReadOnly(sql)) {
    console.error('Refused: only SELECT/WITH/EXPLAIN/SHOW queries allowed.');
    console.error('For schema changes, add a migration under db/migrations/.');
    process.exit(1);
  }

  const start = Date.now();
  try {
    const res = await query(sql);
    printTable(res.rows);
    console.log(`(${Date.now() - start} ms)`);
  } catch (err) {
    console.error('ERR:', (err as Error).message);
    process.exit(1);
  } finally {
    await shutdown();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
