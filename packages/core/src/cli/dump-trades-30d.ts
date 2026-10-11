/** TEMP (not committed): all copied trades last 30d with copy-latency + P/L → CSV. */
import { writeFileSync } from 'node:fs';
import { query, shutdown } from '../db/pool.js';

async function main() {
  const res = await query(
    `SELECT to_char(lp.opened_at   AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS our_fill_ist,
            to_char(cs.detected_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS target_detected_ist,
            EXTRACT(EPOCH FROM (lp.opened_at - cs.detected_at))::int AS latency_sec,
            COALESCE(t.display_name, left(ct.proxy_wallet,10)) AS trader,
            lp.outcome,
            COALESCE(NULLIF(m.question,''),'') AS market,
            cs.price::real       AS target_price,
            lp.entry_price::real AS our_fill_price,
            lp.size_usd::real    AS size_usd,
            lp.status,
            CASE WHEN lp.exit_price IS NULL THEN '' WHEN lp.exit_price>=0.99 THEN 'WIN'
                 WHEN lp.exit_price<=0.01 THEN 'LOSS' ELSE '' END AS result,
            lp.pnl::real AS pnl
       FROM live_positions lp
       LEFT JOIN copy_signals cs ON cs.source_trade_key = lp.source_trade_key
       LEFT JOIN copy_targets ct ON ct.id = lp.copy_target_id
       LEFT JOIN traders t ON t.id = ct.trader_id
       LEFT JOIN markets m ON m.id = lp.market_id
      WHERE lp.opened_at >= now() - interval '30 days'
      ORDER BY lp.opened_at DESC`,
  );

  const cols = ['our_fill_ist', 'target_detected_ist', 'latency_sec', 'trader', 'outcome', 'market',
    'target_price', 'our_fill_price', 'size_usd', 'slippage', 'status', 'result', 'pnl'];
  const esc = (v: unknown) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const lines = [cols.join(',')];

  let lat: number[] = [], pnlSum = 0, wins = 0, settled = 0;
  for (const r of res.rows) {
    const slip = r.target_price != null && r.our_fill_price != null ? +(r.our_fill_price - r.target_price).toFixed(3) : '';
    if (r.latency_sec != null) lat.push(r.latency_sec);
    if (r.pnl != null) pnlSum += Number(r.pnl);
    if (r.result) { settled++; if (r.result === 'WIN') wins++; }
    lines.push([r.our_fill_ist, r.target_detected_ist, r.latency_sec, r.trader, r.outcome, r.market,
      r.target_price, r.our_fill_price, r.size_usd, slip, r.status, r.result, r.pnl].map(esc).join(','));
  }
  lat.sort((a, b) => a - b);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;
  const med = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  const p90 = lat.length ? lat[Math.floor(lat.length * 0.9)] : 0;

  const out = '/Users/office/Documents/Mr_Mac/Codes/kamal/Polymarket-Bot/trades-30d-latency-pnl.csv';
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`rows: ${res.rows.length} | settled: ${settled} | wins: ${wins} (${settled ? (100 * wins / settled).toFixed(0) : 0}%) | total pnl: $${pnlSum.toFixed(2)}`);
  console.log(`latency sec — avg: ${avg.toFixed(0)} | median: ${med} | p90: ${p90} | min: ${lat[0] ?? 0} | max: ${lat[lat.length - 1] ?? 0}`);
  console.log(`CSV → ${out}`);
  await shutdown();
}
main().catch((e) => { console.error(e); process.exit(1); });
