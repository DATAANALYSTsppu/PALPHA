/**
 * Shared copy trading helpers — used by both paper-trader and live-trader CLIs.
 * Signal detection logic is in signal-detector.ts.
 */

import { query } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { getMidpoint } from '../api/clob.js';
import type { TradingMode } from '../types.js';

const log = createLogger('copy-trader');

// ─── Shared Queries ────────────────────────────────────────────────

interface CopyTarget {
  id: number;
  trader_id: number;
  proxy_wallet: string;
  display_name: string;
  category: string;
  status: string;
}

export async function getActiveTargets(): Promise<CopyTarget[]> {
  const res = await query(`SELECT id, trader_id, proxy_wallet, display_name, category, status FROM copy_targets WHERE status = 'active'`);
  return res.rows;
}

export async function getAccount(mode: TradingMode = 'paper') {
  const res = await query(`SELECT * FROM accounts WHERE mode = $1 LIMIT 1`, [mode]);
  return res.rows[0];
}

// ─── Unrealized PnL (paper-only) ──────────────────────────────────

export async function updateUnrealizedPnl(): Promise<void> {
  const posRes = await query(`SELECT * FROM paper_positions WHERE status = 'open'`);
  const positions = posRes.rows;
  if (positions.length === 0) return;

  let totalUnrealized = 0;

  for (const pos of positions) {
    const marketRes = await query(
      `SELECT m.outcome_yes_token, m.outcome_no_token FROM markets m WHERE m.condition_id = $1`,
      [pos.condition_id]
    );
    const market = marketRes.rows[0];
    if (!market) continue;

    const tokenId = pos.side === 'YES' ? market.outcome_yes_token : market.outcome_no_token;
    if (!tokenId) continue;

    try {
      const mid = await getMidpoint(tokenId);
      totalUnrealized += (parseFloat(mid.mid) - pos.entry_price) * pos.shares;
    } catch { /* skip */ }
  }

  await query(`UPDATE accounts SET unrealized_pnl = $1, updated_at = NOW() WHERE mode = 'paper'`, [totalUnrealized]);
}
