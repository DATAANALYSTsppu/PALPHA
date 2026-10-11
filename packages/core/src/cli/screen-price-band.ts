/**
 * screen-price-band — copyability pre-filter for a list of candidate wallets.
 *
 * For each wallet it computes, over the trader's SPORTS buys, what fraction
 * land in the copyable $0.05–0.70 price band vs. expensive favorites we can't
 * profitably mirror (taker market-buy + hold gives up edge to slippage, so a
 * trader who only buys 0.85+ favorites is uncopyable however high their win%).
 *
 * Runs ONE indexed query per trader (WHERE trader_id = $1) on a single pooled
 * connection — the 100-trader IN-list version hash-joins the whole partitioned
 * trades table and times out; per-trader nested-loop lookups are instant.
 *
 * Usage:
 *   tsx packages/core/src/cli/screen-price-band.ts <csv-with-Wallet-Address-col>
 */

import { readFileSync } from 'node:fs';
import { query, shutdown } from '../db/pool.js';

const SPORTS_CATS = [
  'sports', 'tennis', 'nba', 'esports', 'nfl', 'nhl', 'mlb', 'soccer',
  'golf', 'mma', 'boxing', 'cricket', 'f1', 'nascar', 'ufc', 'epl',
  'laliga', 'ncaaf', 'ncaab', 'wnba', 'rugby',
];

const LO = 0.05, HI = 0.70;

function parseWallets(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const wi = header.findIndex((h) => h.includes('wallet'));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const w = (cols[wi] || '').trim().replace(/^"|"$/g, '').toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(w) && !seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

interface Row {
  name: string; wallet: string; buys: number; inBand: number;
  pctBand: number; avgPx: number; bandPx: number; mkts: number; notional: number;
}

async function main() {
  const csv = process.argv[2];
  if (!csv) { console.error('Usage: tsx screen-price-band.ts <csv>'); process.exit(1); }

  const wallets = parseWallets(csv);
  console.log(`Screening ${wallets.length} wallets (sports buys, band $${LO}–$${HI})...\n`);

  // wallet -> trader
  const tg = await query(
    `SELECT lower(proxy_wallet) AS w, id, display_name
       FROM traders WHERE lower(proxy_wallet) = ANY($1)`,
    [wallets],
  );
  const traders = new Map<string, { id: number; name: string }>();
  for (const r of tg.rows) traders.set(r.w, { id: Number(r.id), name: r.display_name || r.w.slice(0, 10) });

  const rows: Row[] = [];
  let done = 0;
  for (const w of wallets) {
    const t = traders.get(w);
    if (!t) continue;
    const res = await query(
      `SELECT count(*)::int AS buys,
              count(*) FILTER (WHERE tr.price BETWEEN $2 AND $3)::int AS in_band,
              avg(tr.price)::float AS avg_px,
              avg(tr.price) FILTER (WHERE tr.price BETWEEN $2 AND $3)::float AS band_px,
              count(DISTINCT tr.market_id)::int AS mkts,
              sum(tr.price * tr.size)::float AS notional
         FROM trades tr
         JOIN events e ON e.id = tr.event_id
        WHERE tr.trader_id = $1 AND tr.side = 'BUY' AND e.category = ANY($4)`,
      [t.id, LO, HI, SPORTS_CATS],
    );
    const r = res.rows[0];
    const buys = r.buys ?? 0;
    if (buys > 0) {
      rows.push({
        name: t.name, wallet: w, buys, inBand: r.in_band ?? 0,
        pctBand: Math.round((100 * (r.in_band ?? 0)) / buys),
        avgPx: r.avg_px ?? 0, bandPx: r.band_px ?? 0,
        mkts: r.mkts ?? 0, notional: Math.round(r.notional ?? 0),
      });
    }
    done++;
    if (done % 20 === 0) process.stderr.write(`  ...${done}/${wallets.length}\n`);
  }

  // Rank: copyable = high % in band, decent volume
  rows.sort((a, b) => b.pctBand - a.pctBand || b.buys - a.buys);

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const padR = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(`${padR('name', 22)} ${pad('buys', 5)} ${pad('mkts', 5)} ${pad('%band', 6)} ${pad('avgPx', 6)} ${pad('bandPx', 7)} ${pad('notional$', 10)}`);
  console.log('─'.repeat(70));
  for (const r of rows) {
    console.log(
      `${padR(r.name.slice(0, 22), 22)} ${pad(r.buys, 5)} ${pad(r.mkts, 5)} ${pad(r.pctBand + '%', 6)} ${pad(r.avgPx.toFixed(3), 6)} ${pad((r.bandPx || 0).toFixed(3), 7)} ${pad(r.notional.toLocaleString(), 10)}`,
    );
  }

  // CSV dump for downstream use
  const csvOut = ['name,wallet,buys,mkts,pct_band,avg_px,band_px,notional'];
  for (const r of rows) csvOut.push(`${r.name},${r.wallet},${r.buys},${r.mkts},${r.pctBand},${r.avgPx.toFixed(4)},${(r.bandPx||0).toFixed(4)},${r.notional}`);
  const outPath = '/tmp/price-band-screen.csv';
  (await import('node:fs')).writeFileSync(outPath, csvOut.join('\n'));
  console.log(`\n${rows.length} traders with sports buys. CSV → ${outPath}`);

  await shutdown();
}

main().catch((err) => { console.error(err); process.exit(1); });
