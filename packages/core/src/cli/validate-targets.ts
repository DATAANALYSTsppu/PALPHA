/**
 * Validate copy targets by checking their Polymarket portfolio,
 * filtered by category (sports, weather, etc.)
 *
 * Usage: npx tsx packages/core/src/cli/validate-targets.ts [--category=sports]
 */

import { loadAllCategories } from '../registry.js';
import { fetchPositionsForUser } from '../api/data.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:validate-targets');

const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];

interface TargetHealth {
  name: string;
  wallet: string;
  category: string;
  totalPositions: number;
  matchedPositions: number;
  openPositions: number;
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
  totalInvested: number;
  currentValue: number;
  winningPositions: number;
  losingPositions: number;
  healthy: boolean;
  reason?: string;
}

async function validateTarget(wallet: string, name: string, category: string): Promise<TargetHealth> {
  // Fetch all positions from Polymarket
  const positions = await fetchPositionsForUser(wallet);

  // Get our tracked condition_ids for this category
  const trackedRes = await query(
    `SELECT m.condition_id FROM markets m
     JOIN events e ON m.event_id = e.id
     WHERE e.category = $1`,
    [category]
  );
  const trackedConditions = new Set(trackedRes.rows.map((r: any) => r.condition_id));

  // Filter positions to only our category
  const categoryPositions = positions.filter(p => trackedConditions.has(p.conditionId));

  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let totalInvested = 0;
  let currentValue = 0;
  let openCount = 0;
  let winCount = 0;
  let loseCount = 0;

  for (const pos of categoryPositions) {
    const size = parseFloat(String(pos.size)) || 0;
    const initial = parseFloat(String(pos.initialValue)) || 0;
    const current = parseFloat(String(pos.currentValue)) || 0;
    const realized = parseFloat(String(pos.realizedPnl)) || 0;

    totalInvested += initial;
    currentValue += current;
    realizedPnl += realized;

    if (size > 0) {
      openCount++;
      unrealizedPnl += (current - initial);
      if (current >= initial) winCount++;
      else loseCount++;
    }
  }

  const netPnl = realizedPnl + unrealizedPnl;

  // Health checks
  let healthy = true;
  let reason: string | undefined;

  if (netPnl < -500) {
    healthy = false;
    reason = `Net PnL negative in ${category}: $${netPnl.toFixed(2)}`;
  } else if (unrealizedPnl < -1000) {
    healthy = false;
    reason = `Large unrealized losses in ${category}: $${unrealizedPnl.toFixed(2)}`;
  } else if (openCount > 5 && loseCount > winCount * 2) {
    healthy = false;
    reason = `Most ${category} positions losing: ${loseCount}L vs ${winCount}W`;
  } else if (categoryPositions.length === 0) {
    healthy = true;
    reason = `No ${category} positions found (may be new to category)`;
  }

  return {
    name,
    wallet,
    category,
    totalPositions: positions.length,
    matchedPositions: categoryPositions.length,
    openPositions: openCount,
    realizedPnl,
    unrealizedPnl,
    netPnl,
    totalInvested,
    currentValue,
    winningPositions: winCount,
    losingPositions: loseCount,
    healthy,
    reason,
  };
}

async function main() {
  await loadAllCategories();

  const targetsRes = await query(
    `SELECT ct.proxy_wallet, ct.display_name, ct.status, ct.category
     FROM copy_targets ct
     WHERE ct.status IN ('active', 'paused')
     ORDER BY ct.status`
  );

  if (targetsRes.rows.length === 0) {
    console.log('No active copy targets.');
    await shutdown();
    return;
  }

  const filterCategory = categoryArg;

  console.log(`\n=== Copy Target Validation (Live Polymarket Data) ===`);
  console.log(`  Category filter: ${filterCategory || 'all'}\n`);

  const results: TargetHealth[] = [];

  for (const target of targetsRes.rows) {
    const category = filterCategory || target.category || 'sports';
    try {
      console.log(`Checking ${target.display_name || target.proxy_wallet.substring(0, 10)} [${category}]...`);
      const health = await validateTarget(target.proxy_wallet, target.display_name || target.proxy_wallet.substring(0, 10), category);
      results.push(health);
    } catch (err) {
      console.log(`  Error: ${(err as Error).message}`);
      results.push({
        name: target.display_name || target.proxy_wallet.substring(0, 10),
        wallet: target.proxy_wallet,
        category,
        totalPositions: 0, matchedPositions: 0, openPositions: 0,
        realizedPnl: 0, unrealizedPnl: 0, netPnl: 0,
        totalInvested: 0, currentValue: 0,
        winningPositions: 0, losingPositions: 0,
        healthy: false, reason: 'Failed to fetch positions',
      });
    }
  }

  // Display
  console.log('\n  Name                 | Status  | Category | Net PnL      | Realized     | Unrealized   | Open (W/L)   | Matched');
  console.log('  ---------------------+---------+----------+--------------+--------------+--------------+--------------+--------');

  for (const r of results) {
    const status = r.healthy ? '\x1b[32mOK     \x1b[0m' : '\x1b[31mWARNING\x1b[0m';
    const name = r.name.padEnd(20).substring(0, 20);
    const cat = r.category.padEnd(8).substring(0, 8);
    const net = `$${r.netPnl.toFixed(2)}`.padStart(12);
    const realized = `$${r.realizedPnl.toFixed(2)}`.padStart(12);
    const unrealized = `$${r.unrealizedPnl.toFixed(2)}`.padStart(12);
    const open = `${r.openPositions} (${r.winningPositions}W/${r.losingPositions}L)`.padStart(12);
    const matched = `${r.matchedPositions}/${r.totalPositions}`.padStart(7);

    console.log(`  ${name} | ${status} | ${cat} | ${net} | ${realized} | ${unrealized} | ${open} | ${matched}`);
    if (r.reason) {
      console.log(`  ${''.padEnd(20)} |         | ${''.padEnd(8)} | ${r.reason}`);
    }
  }

  // Summary
  const unhealthy = results.filter(r => !r.healthy);
  if (unhealthy.length > 0) {
    console.log(`\n  ${unhealthy.length} target(s) flagged. Consider removing:`);
    for (const r of unhealthy) {
      console.log(`    npx tsx packages/core/src/cli/manage-targets.ts remove --name=${r.name}`);
    }
  } else {
    console.log('\n  All targets healthy for their category.');
  }

  console.log('');
  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
