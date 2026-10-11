import { loadAllCategories } from '../registry.js';
import { query, shutdown } from '../db/pool.js';

async function main() {
  await loadAllCategories();

  // Account
  const accountRes = await query(`SELECT * FROM accounts WHERE mode = 'paper' LIMIT 1`);
  const account = accountRes.rows[0];

  if (!account) {
    console.log('No paper trading account found. Run: npm run db:migrate');
    await shutdown();
    return;
  }

  const equity = account.balance + (account.unrealized_pnl || 0);
  const netReturn = equity - account.total_deposited;
  const netPct = ((netReturn / account.total_deposited) * 100).toFixed(2);

  console.log('\n=== Paper Trading Status ===');
  console.log(`  Deposited:    $${account.total_deposited.toFixed(2)}`);
  console.log(`  Balance:      $${account.balance.toFixed(2)}`);
  console.log(`  Realized PnL: $${(account.realized_pnl || 0).toFixed(2)}`);
  console.log(`  Unrealized:   $${(account.unrealized_pnl || 0).toFixed(2)}`);
  console.log(`  Equity:       $${equity.toFixed(2)}`);
  console.log(`  Net Return:   $${netReturn.toFixed(2)} (${netPct}%)`);

  // Open positions
  const openRes = await query(
    `SELECT pp.*, e.title, e.category, e.subcategory
     FROM paper_positions pp
     JOIN events e ON pp.event_id = e.id
     WHERE pp.status = 'open'
     ORDER BY pp.opened_at DESC
     LIMIT 20`
  );

  console.log(`\n=== Open Positions (${openRes.rows.length}) ===`);
  for (const pos of openRes.rows) {
    console.log(`  ${pos.side} ${pos.category}/${pos.subcategory || '?'} | $${pos.size_usd.toFixed(2)} @ ${pos.entry_price.toFixed(3)} | ${pos.title?.substring(0, 50)}`);
  }

  // Closed trades summary
  const closedRes = await query(
    `SELECT COUNT(*) as total,
            COUNT(CASE WHEN pnl > 0 THEN 1 END) as wins,
            COUNT(CASE WHEN pnl <= 0 THEN 1 END) as losses,
            COALESCE(SUM(pnl), 0) as total_pnl
     FROM paper_positions WHERE status IN ('closed', 'expired')`
  );
  const c = closedRes.rows[0];
  console.log(`\n=== Closed Trades ===`);
  console.log(`  Total: ${c.total} | Wins: ${c.wins} | Losses: ${c.losses} | PnL: $${parseFloat(c.total_pnl).toFixed(2)}`);

  // Per-target breakdown
  const targetRes = await query(
    `SELECT ct.display_name, ct.category,
            COUNT(CASE WHEN pp.status = 'open' THEN 1 END) as open_count,
            COUNT(CASE WHEN pp.status IN ('closed', 'expired') THEN 1 END) as closed_count,
            COALESCE(SUM(CASE WHEN pp.status IN ('closed', 'expired') THEN pp.pnl ELSE 0 END), 0) as realized
     FROM copy_targets ct
     LEFT JOIN paper_positions pp ON pp.copy_target_id = ct.id
     WHERE ct.status = 'active'
     GROUP BY ct.id, ct.display_name, ct.category
     ORDER BY realized DESC`
  );

  if (targetRes.rows.length > 0) {
    console.log(`\n=== Per-Target Breakdown ===`);
    for (const t of targetRes.rows) {
      console.log(`  ${t.display_name || 'Unknown'} (${t.category || 'all'}) | Open: ${t.open_count} | Closed: ${t.closed_count} | PnL: $${parseFloat(t.realized).toFixed(2)}`);
    }
  }

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
