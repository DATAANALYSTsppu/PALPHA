/**
 * dump-signals-30d — every target trade we DETECTED, both sides, to CSV.
 *
 * Read-only. Unlike dump-trades-30d.ts (one row per position, therefore
 * buy-only), this reads copy_signals — which the bot writes for every target
 * BUY and SELL, whether or not we acted — so exits appear too.
 *
 * Each row is enriched with our own position where one can be matched:
 *   BUY  → joined on source_trade_key (the buy that opened the position)
 *   SELL → matched on {target wallet, market, outcome}, since the exit path
 *          intentionally leaves source_trade_key NULL so a failed sell can be
 *          retried next cycle rather than being filtered out as "seen".
 *
 * Usage:
 *   npx tsx packages/core/src/cli/dump-signals-30d.ts [--days=30] [--out=path.csv]
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { query, shutdown } from '../db/pool.js';

const daysArg = process.argv.find((a) => a.startsWith('--days='))?.split('=')[1];
const DAYS = Math.min(Math.max(parseInt(daysArg || '30', 10) || 30, 1), 3650);
const outArg = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1];
const OUT = resolve(process.cwd(), outArg || `signals-${DAYS}d-buys-sells.csv`);

async function main() {
  const res = await query(
    `SELECT
        to_char(cs.detected_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS detected_ist,
        cs.side,
        COALESCE(tn.display_name, left(cs.proxy_wallet, 10))        AS trader,
        cs.proxy_wallet,
        cs.outcome,
        COALESCE(NULLIF(m.question, ''), '')                        AS market,
        cs.condition_id,
        cs.price::real                                              AS target_price,
        cs.size::real                                               AS target_shares,
        (cs.price * cs.size)::real                                  AS target_usd,
        cs.acted_on,
        COALESCE(cs.skip_reason, '')                                AS skip_reason,
        lp.entry_price::real                                        AS our_entry_price,
        lp.exit_price::real                                         AS our_exit_price,
        lp.shares::real                                             AS our_shares_now,
        lp.size_usd::real                                           AS our_invested_usd,
        lp.proceeds_usd::real                                       AS our_proceeds_usd,
        lp.exit_count,
        lp.status                                                   AS our_status,
        lp.pnl::real                                                AS our_pnl
      FROM copy_signals cs
      LEFT JOIN markets m ON m.condition_id = cs.condition_id
      LEFT JOIN LATERAL (
        SELECT t.display_name
          FROM copy_targets c JOIN traders t ON t.id = c.trader_id
         WHERE lower(c.proxy_wallet) = lower(cs.proxy_wallet)
         LIMIT 1
      ) tn ON TRUE
      LEFT JOIN LATERAL (
        SELECT p.*
          FROM live_positions p
         WHERE (cs.source_trade_key IS NOT NULL AND p.source_trade_key = cs.source_trade_key)
            OR (cs.source_trade_key IS NULL
                AND lower(p.metadata->>'target_wallet') = lower(cs.proxy_wallet)
                AND p.condition_id = cs.condition_id
                AND p.outcome = cs.outcome)
         ORDER BY p.opened_at DESC
         LIMIT 1
      ) lp ON TRUE
     WHERE cs.detected_at >= NOW() - ($1 || ' days')::interval
     ORDER BY cs.detected_at DESC`,
    [String(DAYS)],
  );

  const cols = [
    'detected_ist', 'side', 'trader', 'proxy_wallet', 'outcome', 'market', 'condition_id',
    'target_price', 'target_shares', 'target_usd', 'acted_on', 'skip_reason',
    'our_entry_price', 'our_exit_price', 'our_shares_now', 'our_invested_usd',
    'our_proceeds_usd', 'exit_count', 'our_status', 'our_pnl', 'slippage',
  ];
  const esc = (v: unknown) => {
    const x = v == null ? '' : String(v);
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };

  const lines = [cols.join(',')];
  let buys = 0, sells = 0, actedBuys = 0, actedSells = 0;
  const skips = new Map<string, number>();

  for (const r of res.rows) {
    // Slippage is only meaningful on a BUY we actually filled.
    const slip = r.side === 'BUY' && r.target_price != null && r.our_entry_price != null && r.acted_on
      ? +(Number(r.our_entry_price) - Number(r.target_price)).toFixed(4)
      : '';
    if (r.side === 'BUY') { buys++; if (r.acted_on) actedBuys++; }
    else { sells++; if (r.acted_on) actedSells++; }
    if (r.skip_reason) skips.set(r.skip_reason, (skips.get(r.skip_reason) ?? 0) + 1);
    lines.push(cols.map((c) => esc(c === 'slippage' ? slip : r[c])).join(','));
  }

  writeFileSync(OUT, lines.join('\n') + '\n');

  console.log(`\nsignals in last ${DAYS}d: ${res.rows.length}`);
  console.log(`  BUY  ${String(buys).padStart(6)}   acted ${actedBuys}  (${buys ? ((100 * actedBuys) / buys).toFixed(1) : 0}%)`);
  console.log(`  SELL ${String(sells).padStart(6)}   acted ${actedSells}  (${sells ? ((100 * actedSells) / sells).toFixed(1) : 0}%)`);
  console.log('\n  top skip reasons:');
  for (const [k, v] of [...skips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  console.log(`\nCSV → ${OUT}\n`);
  await shutdown();
}

main().catch((e) => { console.error(e); process.exit(1); });
