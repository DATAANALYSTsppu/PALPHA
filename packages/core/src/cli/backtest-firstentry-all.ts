/**
 * backtest-firstentry-all — copy-trade backtest for a whole wallet list, done
 * correctly for our partial-resolution data.
 *
 * Model: copy each trader's FIRST in-band ($0.05–0.70) BUY per sports market,
 * hold to resolution. Win iff bought outcome == markets.resolved_to. PnL on a
 * flat $10 stake: win → $10/price−$10, loss → −$10.
 *
 * Critically, markets with NO resolved_to are EXCLUDED, not scored as $0 (which
 * is what the engine does and why low-coverage traders look fake-terrible). We
 * report coverage % = resolved / in-band markets so you know how much of each
 * trader's activity we could actually score. Trust ROI only at high coverage
 * AND decent resolved-sample size.
 *
 * One indexed query per trader on a single connection — the all-traders-at-once
 * join hash-joins the partitioned trades table and times out.
 *
 * Usage:
 *   tsx packages/core/src/cli/backtest-firstentry-all.ts <csv-with-Wallet-Address-col>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { query, shutdown } from '../db/pool.js';

const SPORTS_CATS = ['sports', 'tennis', 'nba', 'esports'];
const LO = 0.05, HI = 0.70;
// For binary Yes/No markets the stored price is the primary token's price, not
// the cost of the side actually bought — proven by a trader whose Yes AND No
// buys both average ~$0.10. That makes Yes/No PnL unreliable. --team-only keeps
// just multi-outcome (team-name) bets, where price = the bought token's real
// cost, so the backtest is honest.
const TEAM_ONLY = process.argv.includes('--team-only');
// --save writes one row per trader to backtest_runs so the dashboard shows them.
// DB WRITE — only runs when explicitly asked.
const SAVE = process.argv.includes('--save');

function parseWallets(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const wi = header.findIndex((h) => h.includes('wallet'));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const w = (line.split(',')[wi] || '').trim().replace(/^"|"$/g, '').toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(w) && !seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

interface Row {
  name: string; wallet: string; bandMkts: number; resolved: number; cov: number;
  wins: number; winPct: number; avgPx: number; pnl: number; roi: number;
  curve: { date: string; equity: number }[];
}

async function main() {
  const csv = process.argv[2];
  if (!csv) { console.error('Usage: tsx backtest-firstentry-all.ts <csv>'); process.exit(1); }

  const wallets = parseWallets(csv);
  console.log(`Backtesting ${wallets.length} wallets — first in-band BUY/market, hold to resolution.\n`);

  const tg = await query(
    `SELECT lower(proxy_wallet) AS w, id, display_name
       FROM traders WHERE lower(proxy_wallet) = ANY($1)`, [wallets],
  );
  const traders = new Map<string, { id: number; name: string }>();
  for (const r of tg.rows) traders.set(r.w, { id: Number(r.id), name: r.display_name || r.w.slice(0, 10) });

  const rows: Row[] = [];
  let done = 0;
  for (const w of wallets) {
    const t = traders.get(w);
    if (!t) continue;
    // Return each first-entry-per-market bet (resolved + unresolved), ordered
    // by entry time, so we can compute the aggregate metrics AND a cumulative
    // equity curve in JS.
    const res = await query(
      `SELECT price, outcome, resolved_to, ts FROM (
         SELECT DISTINCT ON (m.condition_id)
                tr.price::numeric AS price, tr.outcome, m.resolved_to, tr.timestamp AS ts
         FROM trades tr
         JOIN markets m ON m.id = tr.market_id
         JOIN events e ON e.id = tr.event_id
         WHERE tr.trader_id = $1 AND tr.side='BUY' AND tr.price BETWEEN $2 AND $3
           AND e.category = ANY($4)
           ${TEAM_ONLY ? "AND tr.outcome NOT IN ('Yes','No')" : ''}
         ORDER BY m.condition_id, tr.timestamp ASC
       ) s
       ORDER BY ts ASC`,
      [t.id, LO, HI, SPORTS_CATS],
    );
    const bets = res.rows as { price: string; outcome: string; resolved_to: string | null; ts: string }[];
    const band = bets.length;
    const resolvedBets = bets.filter((b) => b.resolved_to != null);
    const resolved = resolvedBets.length;

    let wins = 0, pnl = 0, pxSum = 0;
    const initial = 10 * resolved;
    let bal = initial;
    const curve: { date: string; equity: number }[] = resolved
      ? [{ date: new Date(parseInt(resolvedBets[0].ts, 10) * 1000).toISOString().slice(0, 10), equity: initial }]
      : [];
    for (const b of resolvedBets) {
      const price = parseFloat(b.price);
      const win = b.resolved_to!.trim().toLowerCase() === b.outcome.trim().toLowerCase();
      const p = win ? 10 / price - 10 : -10;
      if (win) wins++;
      pnl += p; bal += p; pxSum += price;
      curve.push({ date: new Date(parseInt(b.ts, 10) * 1000).toISOString().slice(0, 10), equity: +bal.toFixed(2) });
    }

    if (band > 0) {
      rows.push({
        name: t.name, wallet: w, bandMkts: band, resolved, cov: band ? Math.round((100 * resolved) / band) : 0,
        wins, winPct: resolved ? +(100 * wins / resolved).toFixed(1) : 0,
        avgPx: resolved ? pxSum / resolved : 0, pnl: +pnl.toFixed(2),
        roi: resolved ? +(100 * pnl / (10 * resolved)).toFixed(1) : 0,
        curve,
      });
    }
    if (++done % 25 === 0) process.stderr.write(`  ...${done}/${wallets.length}\n`);
  }

  // Trustworthy = enough resolved sample AND high coverage. Rank those by ROI.
  const MIN_RESOLVED = 30, MIN_COV = 60;
  const trustworthy = rows.filter((r) => r.resolved >= MIN_RESOLVED && r.cov >= MIN_COV).sort((a, b) => b.roi - a.roi);
  const rest = rows.filter((r) => !(r.resolved >= MIN_RESOLVED && r.cov >= MIN_COV)).sort((a, b) => b.resolved - a.resolved);

  const padR = (s: string | number, n: number) => String(s).padEnd(n);
  const padL = (s: string | number, n: number) => String(s).padStart(n);
  const head = `${padR('name', 20)} ${padL('mkts', 5)} ${padL('resolv', 6)} ${padL('cov%', 5)} ${padL('win%', 6)} ${padL('avgPx', 6)} ${padL('pnl@10', 8)} ${padL('roi%', 6)}`;
  const line = (r: Row) => `${padR(r.name.slice(0, 20), 20)} ${padL(r.bandMkts, 5)} ${padL(r.resolved, 6)} ${padL(r.cov + '%', 5)} ${padL(r.winPct + '%', 6)} ${padL(r.avgPx.toFixed(3), 6)} ${padL(r.pnl.toFixed(0), 8)} ${padL(r.roi + '%', 6)}`;

  console.log(`\n=== TRUSTWORTHY (resolved ≥ ${MIN_RESOLVED}, coverage ≥ ${MIN_COV}%) — ranked by ROI ===`);
  console.log(head); console.log('─'.repeat(head.length));
  for (const r of trustworthy) console.log(line(r));

  console.log(`\n=== LOW COVERAGE / SMALL SAMPLE (numbers unreliable until on-chain resolution backfill) ===`);
  console.log(head); console.log('─'.repeat(head.length));
  for (const r of rest) console.log(line(r));

  const out = ['name,band_mkts,resolved,coverage_pct,win_pct,avg_px,pnl_at_10,roi_pct,trustworthy'];
  for (const r of [...trustworthy, ...rest]) {
    const tw = r.resolved >= MIN_RESOLVED && r.cov >= MIN_COV;
    out.push(`${r.name},${r.bandMkts},${r.resolved},${r.cov},${r.winPct},${r.avgPx.toFixed(4)},${r.pnl},${r.roi},${tw}`);
  }
  writeFileSync('/tmp/backtest-all.csv', out.join('\n'));
  console.log(`\n${rows.length} traders. ${trustworthy.length} trustworthy, ${trustworthy.filter(r=>r.roi>0).length} of those profitable. CSV → /tmp/backtest-all.csv`);

  if (SAVE) {
    // One backtest_runs row per trader (strategy='copy_firstentry') so the
    // dashboard Backtests page shows all of them. Return %% is derived by the
    // dashboard as total_return / config.initialBalance, so we set
    // initialBalance = $10 * resolved (total staked) → Return %% == ROI.
    // 'Trades' shows resolved-market count = the honest sample size; coverage
    // is stored in config for anyone who inspects the run.
    const strategy = TEAM_ONLY ? 'copy_firstentry_team' : 'copy_firstentry';
    // Idempotent: clear this strategy's prior rows so re-running doesn't
    // duplicate. Scoped to our own analytics rows only.
    const del = await query(`DELETE FROM backtest_runs WHERE strategy = $1`, [strategy]);
    if ((del.rowCount ?? 0) > 0) console.log(`  cleared ${del.rowCount} prior ${strategy} rows`);

    const end = new Date();
    const start = new Date(end.getTime() - 730 * 86400000);
    let saved = 0;
    for (const r of rows) {
      if (r.resolved === 0) continue; // nothing to score
      // maxDrawdown from the curve (largest peak-to-trough drop) for the dashboard.
      let peak = -Infinity, maxDd = 0;
      for (const pt of r.curve) { if (pt.equity > peak) peak = pt.equity; if (peak - pt.equity > maxDd) maxDd = peak - pt.equity; }
      await query(
        `INSERT INTO backtest_runs
           (category, strategy, start_date, end_date, config, total_return,
            sharpe_ratio, max_drawdown, win_rate, total_trades, total_pnl,
            equity_curve, per_trader)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          'sports', strategy, start, end,
          JSON.stringify({ initialBalance: 10 * r.resolved, coverage: r.cov, bandMarkets: r.bandMkts, teamOnly: TEAM_ONLY, band: [LO, HI], avgPx: r.avgPx }),
          r.pnl, 0, maxDd, r.winPct / 100, r.resolved, r.pnl,
          JSON.stringify(r.curve),
          JSON.stringify([{ name: r.name, wallet: r.wallet, trades: r.resolved, pnl: r.pnl, winRate: r.winPct / 100, coverage: r.cov }]),
        ],
      );
      saved++;
    }
    console.log(`✓ Saved ${saved} runs to backtest_runs (strategy=${strategy}). They'll show on the dashboard Backtests page.`);
  }

  await shutdown();
}

main().catch((err) => { console.error(err); process.exit(1); });
