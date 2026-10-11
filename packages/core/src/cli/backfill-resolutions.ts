/**
 * backfill-resolutions — fill in `markets.resolved_to` for markets that ALREADY
 * exist in our table, are closed on-chain, but never got their winning outcome
 * recorded.
 *
 * Why this exists (distinct from backfill-markets):
 *   backfill-markets fetches markets that are MISSING from our table entirely.
 *   This script fixes markets that ARE in the table with is_closed=true but
 *   resolved_to=NULL — the common case for short-lived sports markets that were
 *   created (by the scanner or a wallet ingest) before they resolved and were
 *   never revisited. The backtest engine and the bot's resolution-based
 *   position settlement both treat a NULL resolved_to as "unknown / $0", so
 *   these gaps silently corrupt win-rates and PnL. Recovering them from CLOB
 *   (tokens[].winner) makes every downstream number honest.
 *
 * Uses the same plain `fetch()` (no custom User-Agent) as the working CLOB
 * reader in reconcile-positions.ts — a bot-ish UA gets blocked by Cloudflare.
 *
 * Read-only until --apply. Dry-run prints the plan and writes nothing.
 *
 * Usage:
 *   tsx packages/core/src/cli/backfill-resolutions.ts                 # dry-run, all closed+unresolved
 *   tsx packages/core/src/cli/backfill-resolutions.ts --sports        # scope to sports categories
 *   tsx packages/core/src/cli/backfill-resolutions.ts --category=tennis
 *   tsx packages/core/src/cli/backfill-resolutions.ts --traders=681711,627006   # only these traders' markets
 *   tsx packages/core/src/cli/backfill-resolutions.ts --limit=1000
 *   tsx packages/core/src/cli/backfill-resolutions.ts --sports --apply          # WRITE resolved_to
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';

const CLOB_API = config.api.clobUrl || 'https://clob.polymarket.com';
const SPORTS_CATS = ['sports', 'tennis', 'nba', 'esports'];
const CONCURRENCY = 6;

interface ClobToken { outcome: string; winner: boolean }
interface ClobMarket { closed?: boolean; tokens?: ClobToken[] }

type FetchOutcome = { cid: string; winner: string | null; status: number | 'err'; err?: string };

/** Fetch a market's winning outcome from CLOB. Mirrors reconcile-positions'
 *  clobWinningOutcome: plain fetch, no custom UA, short timeout, one retry on
 *  network error. Returns the status so the caller can tally real failures. */
async function fetchResolution(cid: string): Promise<FetchOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${CLOB_API}/markets/${cid}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { cid, winner: null, status: res.status };
      const m = (await res.json()) as ClobMarket;
      const winner = m.closed && Array.isArray(m.tokens)
        ? (m.tokens.find((t) => t.winner)?.outcome ?? null)
        : null;
      return { cid, winner, status: 200 };
    } catch (err) {
      if (attempt === 1) return { cid, winner: null, status: 'err', err: (err as Error).message };
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { cid, winner: null, status: 'err' };
}

function argVal(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sports = process.argv.includes('--sports');
  const category = argVal('category');
  const tradersArg = argVal('traders');
  const limit = argVal('limit') ? parseInt(argVal('limit')!, 10) : null;

  console.log('=== backfill-resolutions ===');
  console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  CLOB:     ${CLOB_API}`);
  console.log(`  Scope:    ${sports ? 'sports cats' : category ? `category=${category}` : tradersArg ? `traders=${tradersArg}` : 'ALL closed+unresolved'}`);
  if (limit) console.log(`  Limit:    ${limit}`);
  console.log('');

  // Build the target query: markets that are closed on-chain but have no winner.
  const conds: string[] = ['m.resolved_to IS NULL', 'm.is_closed = true'];
  const params: unknown[] = [];
  if (sports) {
    params.push(SPORTS_CATS);
    conds.push(`m.event_id IN (SELECT id FROM events WHERE category = ANY($${params.length}))`);
  } else if (category) {
    params.push(category);
    conds.push(`m.event_id IN (SELECT id FROM events WHERE category = $${params.length})`);
  }
  if (tradersArg) {
    const ids = tradersArg.split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    params.push(ids);
    conds.push(`m.id IN (SELECT DISTINCT market_id FROM trades WHERE trader_id = ANY($${params.length}))`);
  }
  const sql = `SELECT m.condition_id FROM markets m WHERE ${conds.join(' AND ')}${limit ? ` LIMIT ${limit}` : ''}`;
  const targetRes = await query(sql, params);
  const cids: string[] = targetRes.rows.map((r: { condition_id: string }) => r.condition_id).filter(Boolean);
  console.log(`Found ${cids.length} closed markets missing resolved_to.\n`);
  if (cids.length === 0) { await shutdown(); return; }

  // Fetch from CLOB with bounded concurrency, tallying real outcomes.
  const found: { cid: string; winner: string }[] = [];
  let noWinner = 0, done = 0;
  const failByStatus = new Map<string, number>(); // status/err -> count
  let firstErr = '';
  for (let i = 0; i < cids.length; i += CONCURRENCY) {
    const batch = cids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((cid) => fetchResolution(cid)));
    for (const r of results) {
      if (r.status === 200) {
        if (r.winner) found.push({ cid: r.cid, winner: r.winner });
        else noWinner++;
      } else {
        const key = String(r.status);
        failByStatus.set(key, (failByStatus.get(key) ?? 0) + 1);
        if (!firstErr && r.err) firstErr = r.err;
      }
    }
    done += batch.length;
    const fails = [...failByStatus.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
    process.stdout.write(`\r  fetched ${done}/${cids.length}  winner=${found.length} no-winner=${noWinner} fails=[${fails}]   `);
    await new Promise((r) => setTimeout(r, 60)); // be gentle on CLOB
  }
  console.log('\n');

  if (failByStatus.size > 0) {
    console.log('--- Fetch failures (status/err → count) ---');
    for (const [k, v] of failByStatus) console.log(`  ${k.padEnd(10)} ${v}`);
    if (firstErr) console.log(`  first error: ${firstErr}`);
    console.log('');
  }

  console.log('--- Sample plan (first 20) ---');
  for (const f of found.slice(0, 20)) {
    console.log(`  ${f.cid.slice(0, 16)}..  resolved_to = ${f.winner}`);
  }
  console.log('');

  if (!apply) {
    console.log(`Dry-run. ${found.length} markets would get resolved_to set. Re-run with --apply to write.`);
    await shutdown();
    return;
  }

  // Apply: only set when still NULL (idempotent / race-safe).
  let updated = 0;
  for (let i = 0; i < found.length; i += CONCURRENCY) {
    const batch = found.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ cid, winner }) => {
      const r = await query(
        `UPDATE markets SET resolved_to = $1, fetched_at = NOW()
          WHERE condition_id = $2 AND resolved_to IS NULL`,
        [winner, cid],
      );
      updated += r.rowCount ?? 0;
    }));
    process.stdout.write(`\r  updated ${Math.min(i + CONCURRENCY, found.length)}/${found.length}`);
  }
  console.log(`\n✓ Set resolved_to on ${updated} markets.`);
  await shutdown();
}

main().catch((err) => { console.error(err); process.exit(1); });
