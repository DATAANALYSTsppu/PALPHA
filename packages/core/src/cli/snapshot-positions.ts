/**
 * snapshot-positions — daily snapshot of positions for each copy target.
 *
 * Run daily (cron or manual). For each active copy target, fetches their current
 * positions from data-api and stores aggregate + per-position detail in position_snapshots.
 *
 * This gives us a time series of trader exposure that we can cross-reference with
 * their trade history to detect things like:
 *  - Position size conviction (what % of their book is this bet?)
 *  - Realized vs unrealized PnL divergence
 *  - When they exit (position disappears between snapshots)
 *
 * Usage:
 *   npx tsx packages/core/src/cli/snapshot-positions.ts [--all]
 *
 * By default only snapshots active copy targets. --all snapshots every tracked trader.
 */

import { loadAllCategories } from '../registry.js';
import { fetchPositionsRaw } from '../api/data.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:snapshot-positions');

interface PositionDetail {
  asset: string;
  conditionId: string;
  eventSlug?: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  outcome: string;
}

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

async function snapshotWallet(wallet: string): Promise<{ count: number; totalSize: number }> {
  const wl = wallet.toLowerCase();
  const raw = await fetchPositionsRaw(wl);
  const snapshotDate = new Date().toISOString().split('T')[0];
  const capturedAt = new Date();

  const positions: PositionDetail[] = raw.map(p => ({
    asset: String(p.asset || ''),
    conditionId: String(p.conditionId || ''),
    eventSlug: p.eventSlug as string | undefined,
    size: toNum(p.size),
    avgPrice: toNum(p.avgPrice),
    initialValue: toNum(p.initialValue),
    currentValue: toNum(p.currentValue),
    cashPnl: toNum(p.cashPnl),
    percentPnl: toNum(p.percentPnl),
    totalBought: toNum(p.totalBought),
    realizedPnl: toNum(p.realizedPnl),
    curPrice: toNum(p.curPrice),
    redeemable: Boolean(p.redeemable),
    outcome: String(p.outcome || ''),
  }));

  const totalSizeUsd = positions.reduce((s, p) => s + p.currentValue, 0);
  const totalCashPnl = positions.reduce((s, p) => s + p.cashPnl, 0);
  const totalRealizedPnl = positions.reduce((s, p) => s + p.realizedPnl, 0);

  await query(
    `INSERT INTO position_snapshots (
       proxy_wallet, snapshot_date, captured_at,
       total_positions, total_size_usd, total_cash_pnl, total_realized_pnl,
       positions, raw_payload, source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'data-api')
     ON CONFLICT (proxy_wallet, snapshot_date) DO UPDATE SET
       captured_at = EXCLUDED.captured_at,
       total_positions = EXCLUDED.total_positions,
       total_size_usd = EXCLUDED.total_size_usd,
       total_cash_pnl = EXCLUDED.total_cash_pnl,
       total_realized_pnl = EXCLUDED.total_realized_pnl,
       positions = EXCLUDED.positions,
       raw_payload = EXCLUDED.raw_payload`,
    [wl, snapshotDate, capturedAt, positions.length, totalSizeUsd, totalCashPnl, totalRealizedPnl,
     JSON.stringify(positions), JSON.stringify(raw)]
  );

  return { count: positions.length, totalSize: totalSizeUsd };
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await loadAllCategories();

  const all = process.argv.includes('--all');

  const walletsRes = all
    ? await query(`SELECT proxy_wallet FROM traders WHERE status = 'active' ORDER BY alpha_score DESC NULLS LAST`)
    : await query(`SELECT proxy_wallet FROM copy_targets WHERE status = 'active'`);

  const wallets = walletsRes.rows.map(r => r.proxy_wallet);
  console.log(`\n=== Position Snapshot ===`);
  console.log(`  Mode:    ${all ? 'all active traders' : 'active copy targets'}`);
  console.log(`  Wallets: ${wallets.length}`);
  console.log('');

  let totalPositions = 0;
  let totalBook = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    try {
      const { count, totalSize } = await snapshotWallet(wallet);
      totalPositions += count;
      totalBook += totalSize;
      log.info({ progress: `${i + 1}/${wallets.length}`, wallet, positions: count, bookUsd: totalSize.toFixed(0) }, 'Snapshot saved');
    } catch (err) {
      log.error({ wallet, err: (err as Error).message }, 'Snapshot failed');
    }
    await sleep(200);
  }

  console.log(`\n=== Snapshot Results ===`);
  console.log(`  Wallets snapshotted: ${wallets.length}`);
  console.log(`  Total positions:     ${totalPositions}`);
  console.log(`  Combined book size:  $${totalBook.toFixed(2)}`);

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
