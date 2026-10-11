import { loadAllCategories } from '../registry.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:manage-targets');

async function main() {
  await loadAllCategories();

  const action = process.argv[2] || 'list';

  switch (action) {
    case 'list': {
      const res = await query(
        `SELECT ct.*, t.alpha_score, t.total_pnl, t.win_rate
         FROM copy_targets ct
         JOIN traders t ON t.id = ct.trader_id
         ORDER BY ct.status, t.alpha_score DESC NULLS LAST`
      );
      console.log('\n=== Copy Targets ===\n');
      for (const t of res.rows) {
        const alpha = t.alpha_score?.toFixed(1) || '?';
        const pnl = t.total_pnl?.toFixed(0) || '?';
        console.log(`  [${t.status}] ${t.display_name || t.proxy_wallet.substring(0, 10)} | Alpha: ${alpha} | PnL: $${pnl} | Category: ${t.category || 'all'}`);
      }
      if (res.rows.length === 0) console.log('  No targets. Use: npm run copy:add add-wallet <address>');
      break;
    }

    case 'add-wallet': {
      const wallet = process.argv[3];
      if (!wallet) {
        console.log('Usage: npm run copy:add add-wallet <wallet-address> [--name=DisplayName] [--category=sports] [--paused]');
        break;
      }

      const nameArg = process.argv.find(a => a.startsWith('--name='))?.split('=')[1];
      const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];
      // --paused adds (or sets) the target in a paused state — useful for
      // staging candidates we want to backtest/track without copying them live.
      const desiredStatus = process.argv.includes('--paused') ? 'paused' : 'active';

      // Check if trader exists in our DB
      let traderRes = await query(`SELECT id, proxy_wallet, display_name, alpha_score FROM traders WHERE proxy_wallet = $1`, [wallet]);

      if (traderRes.rows.length === 0) {
        // Create trader record for unknown wallet
        console.log(`  Trader not in DB. Creating record for ${wallet.substring(0, 10)}...`);
        traderRes = await query(
          `INSERT INTO traders (proxy_wallet, display_name, status, created_at, updated_at)
           VALUES ($1, $2, 'active', NOW(), NOW())
           RETURNING id, proxy_wallet, display_name, alpha_score`,
          [wallet, nameArg || null]
        );
      }

      const trader = traderRes.rows[0];
      const displayName = nameArg || trader.display_name || wallet.substring(0, 10);

      // Update display name if provided
      if (nameArg && nameArg !== trader.display_name) {
        await query(`UPDATE traders SET display_name = $1, updated_at = NOW() WHERE id = $2`, [nameArg, trader.id]);
      }

      // Check if already a target
      const existingTarget = await query(
        `SELECT id, status FROM copy_targets WHERE trader_id = $1 AND status IN ('active', 'paused')`,
        [trader.id]
      );

      if (existingTarget.rows.length > 0) {
        const t = existingTarget.rows[0];
        if (t.status !== desiredStatus) {
          await query(`UPDATE copy_targets SET status = $2, updated_at = NOW() WHERE id = $1`, [t.id, desiredStatus]);
          console.log(`  Set ${displayName} → ${desiredStatus} (was ${t.status})`);
        } else {
          console.log(`  Already ${desiredStatus}: ${displayName}`);
        }
      } else {
        // Reactivate stopped target or create new
        const stoppedTarget = await query(
          `SELECT id FROM copy_targets WHERE trader_id = $1 AND status = 'stopped'`,
          [trader.id]
        );

        if (stoppedTarget.rows.length > 0) {
          await query(
            `UPDATE copy_targets SET status = $4, display_name = $1, category = $2, added_by = 'manual', updated_at = NOW() WHERE id = $3`,
            [displayName, categoryArg || null, stoppedTarget.rows[0].id, desiredStatus]
          );
        } else {
          await query(
            `INSERT INTO copy_targets (trader_id, proxy_wallet, display_name, category, status, added_by)
             VALUES ($1, $2, $3, $4, $5, 'manual')`,
            [trader.id, wallet, displayName, categoryArg || null, desiredStatus]
          );
        }
        const alpha = trader.alpha_score?.toFixed(1) || 'unscored';
        console.log(`  Added: ${displayName} | Wallet: ${wallet.substring(0, 10)}... | Status: ${desiredStatus} | Category: ${categoryArg || 'all'}`);
      }
      break;
    }

    case 'add-top': {
      const limitArg = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '10');
      const minAlpha = parseFloat(process.argv.find(a => a.startsWith('--min-alpha='))?.split('=')[1] || '60');
      const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];

      let topTraders;
      if (categoryArg) {
        topTraders = await query(
          `SELECT t.id, t.proxy_wallet, t.display_name, tcs.alpha_score
           FROM trader_category_stats tcs
           JOIN traders t ON t.id = tcs.trader_id
           WHERE tcs.category = $1 AND tcs.alpha_score >= $2
           AND t.id NOT IN (SELECT trader_id FROM copy_targets WHERE status IN ('active', 'paused'))
           ORDER BY tcs.alpha_score DESC LIMIT $3`,
          [categoryArg, minAlpha, limitArg]
        );
      } else {
        topTraders = await query(
          `SELECT id, proxy_wallet, display_name, alpha_score
           FROM traders
           WHERE alpha_score >= $1
           AND id NOT IN (SELECT trader_id FROM copy_targets WHERE status IN ('active', 'paused'))
           ORDER BY alpha_score DESC LIMIT $2`,
          [minAlpha, limitArg]
        );
      }

      let added = 0;
      for (const t of topTraders.rows) {
        await query(
          `INSERT INTO copy_targets (trader_id, proxy_wallet, display_name, category, status, added_by)
           VALUES ($1, $2, $3, $4, 'active', 'auto')
           ON CONFLICT DO NOTHING`,
          [t.id, t.proxy_wallet, t.display_name, categoryArg || null]
        );
        added++;
        console.log(`  Added: ${t.display_name || t.proxy_wallet.substring(0, 10)} (alpha: ${t.alpha_score?.toFixed(1)})`);
      }
      console.log(`\nAdded ${added} targets`);
      break;
    }

    case 'remove': {
      const wallet = process.argv[3];
      const nameSearch = process.argv.find(a => a.startsWith('--name='))?.split('=')[1];

      if (!wallet && !nameSearch) {
        console.log('Usage: npm run copy:add remove <wallet> OR npm run copy:add remove --name=DisplayName');
        break;
      }

      let result;
      if (wallet) {
        result = await query(
          `UPDATE copy_targets SET status = 'stopped', updated_at = NOW() WHERE proxy_wallet = $1 AND status IN ('active', 'paused')
           RETURNING display_name, proxy_wallet`,
          [wallet]
        );
      } else {
        result = await query(
          `UPDATE copy_targets SET status = 'stopped', updated_at = NOW() WHERE display_name ILIKE $1 AND status IN ('active', 'paused')
           RETURNING display_name, proxy_wallet`,
          [`%${nameSearch}%`]
        );
      }

      if (result.rowCount && result.rowCount > 0) {
        for (const r of result.rows) {
          console.log(`  Stopped: ${r.display_name || r.proxy_wallet.substring(0, 10)}`);
        }
      } else {
        console.log('  No matching active target found');
      }
      break;
    }

    case 'clear': {
      const result = await query(`UPDATE copy_targets SET status = 'stopped', updated_at = NOW() WHERE status = 'active' RETURNING id`);
      console.log(`All active targets stopped (${result.rowCount})`);
      break;
    }

    case 'pause-all': {
      const result = await query(`UPDATE copy_targets SET status = 'paused', updated_at = NOW() WHERE status = 'active' RETURNING id`);
      console.log(`All active targets paused (${result.rowCount})`);
      break;
    }

    case 'resume-all': {
      const result = await query(`UPDATE copy_targets SET status = 'active', updated_at = NOW() WHERE status = 'paused' RETURNING id`);
      console.log(`All paused targets resumed (${result.rowCount})`);
      break;
    }

    default:
      console.log('\nUsage: npm run copy:add <action>\n');
      console.log('  Actions:');
      console.log('    list                           Show all copy targets');
      console.log('    add-wallet <address>            Add a wallet manually');
      console.log('      --name=DisplayName            Optional display name');
      console.log('      --category=sports             Optional category scope');
      console.log('    add-top                         Auto-add top alpha traders');
      console.log('      --limit=10 --min-alpha=60 --category=sports');
      console.log('    remove <address>                Stop copying a wallet');
      console.log('    remove --name=DisplayName       Stop copying by name');
      console.log('    clear                           Stop all active targets');
      console.log('    pause-all                       Pause all active targets');
      console.log('    resume-all                      Resume all paused targets');
  }

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
