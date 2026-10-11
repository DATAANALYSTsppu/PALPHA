import { loadAllCategories } from '../registry.js';
import { query, shutdown } from '../db/pool.js';

async function main() {
  await loadAllCategories();

  const limitArg = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '20');
  const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];

  let traders;
  if (categoryArg) {
    traders = await query(
      `SELECT t.id, t.proxy_wallet, t.display_name,
              tcs.win_rate, tcs.roi, tcs.total_pnl, tcs.total_markets, tcs.total_trades,
              tcs.consistency_score, tcs.composite_score
       FROM trader_category_stats tcs
       JOIN traders t ON t.id = tcs.trader_id
       WHERE tcs.category = $1 AND tcs.composite_score IS NOT NULL
       ORDER BY tcs.composite_score DESC NULLS LAST
       LIMIT $2`,
      [categoryArg, limitArg]
    );
  } else {
    traders = await query(
      `SELECT id, proxy_wallet, display_name, win_rate, roi, total_pnl,
              total_markets, total_trades, consistency_score, composite_score
       FROM traders
       WHERE composite_score IS NOT NULL
       ORDER BY composite_score DESC NULLS LAST
       LIMIT $1`,
      [limitArg]
    );
  }

  const scope = categoryArg ? `[${categoryArg}]` : '[global]';
  console.log(`\n=== Leaderboard ${scope} ===\n`);
  console.log(`  #  | Score | Win%  | ROI%   | PnL       | Markets | Trades | Name`);
  console.log(`  ---+-------+-------+--------+-----------+---------+--------+----`);

  for (let i = 0; i < traders.rows.length; i++) {
    const t = traders.rows[i];
    const idx = String(i + 1).padStart(3);
    const score = (t.composite_score || 0).toFixed(3).padStart(5);
    const wr = ((t.win_rate || 0) * 100).toFixed(1).padStart(5);
    const roi = ((t.roi || 0) * 100).toFixed(1).padStart(6);
    const pnl = `$${(t.total_pnl || 0).toFixed(0)}`.padStart(9);
    const mkts = String(t.total_markets || 0).padStart(7);
    const trades = String(t.total_trades || 0).padStart(6);
    const name = (t.display_name || t.proxy_wallet?.substring(0, 10) || '?').substring(0, 20);

    console.log(`  ${idx} | ${score} | ${wr} | ${roi} | ${pnl} | ${mkts} | ${trades} | ${name}`);
  }

  console.log(`\n  Total: ${traders.rows.length} traders\n`);
  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
