import { query } from '../db/pool.js';
import { createLogger } from '../logger.js';
import type { TradingEngine, TradingMode, OpenPositionParams, Position } from '../types.js';

const log = createLogger('paper-engine');

export class PaperTradingEngine implements TradingEngine {
  mode: TradingMode = 'paper';

  async openPosition(params: OpenPositionParams): Promise<{ id: number }> {
    const result = await query(
      `INSERT INTO paper_positions (copy_target_id, market_id, event_id, condition_id, side, entry_price, size_usd, shares, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)
       RETURNING id`,
      [params.copyTargetId, params.marketId, params.eventId, params.conditionId,
       params.side, params.entryPrice, params.sizeUsd, params.shares,
       JSON.stringify(params.metadata || {})]
    );

    await query(`UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE mode = 'paper'`, [params.sizeUsd]);
    log.info({ positionId: result.rows[0].id, side: params.side, price: params.entryPrice, size: params.sizeUsd }, 'Paper position opened');
    return { id: result.rows[0].id };
  }

  async closePosition(positionId: number, exitPrice: number, reason: string): Promise<void> {
    const posRes = await query(`SELECT * FROM paper_positions WHERE id = $1`, [positionId]);
    const pos = posRes.rows[0];
    if (!pos) return;

    const pnl = (exitPrice - pos.entry_price) * pos.shares;
    const status = reason === 'expired' ? 'expired' : 'closed';

    await query(
      `UPDATE paper_positions SET status = $1, exit_price = $2, pnl = $3, closed_at = NOW(),
       metadata = metadata || $4::jsonb WHERE id = $5`,
      [status, exitPrice, pnl, JSON.stringify({ close_reason: reason }), positionId]
    );

    await query(
      `UPDATE accounts SET balance = balance + $1, total_pnl = total_pnl + $2, realized_pnl = realized_pnl + $2, updated_at = NOW() WHERE mode = 'paper'`,
      [pos.size_usd + pnl, pnl]
    );

    log.info({ positionId, exitPrice, pnl: pnl.toFixed(2), reason }, 'Paper position closed');
  }

  async getBalance(): Promise<number> {
    const res = await query(`SELECT balance FROM accounts WHERE mode = 'paper' LIMIT 1`);
    return res.rows[0]?.balance || 0;
  }

  async getOpenPositions(): Promise<Position[]> {
    const res = await query(`SELECT * FROM paper_positions WHERE status = 'open'`);
    return res.rows.map(mapRowToPosition);
  }

  async getOpenPositionCount(): Promise<number> {
    const res = await query(`SELECT COUNT(*)::int as cnt FROM paper_positions WHERE status = 'open'`);
    return res.rows[0].cnt;
  }

  async getDailyRealizedLoss(): Promise<number> {
    const res = await query(
      `SELECT COALESCE(SUM(pnl), 0)::real as loss FROM paper_positions
       WHERE status IN ('closed', 'expired') AND closed_at >= NOW() - INTERVAL '24 hours' AND pnl < 0`
    );
    return Math.abs(res.rows[0].loss);
  }

  async hasOpenPositionForMarket(targetId: number, conditionId: string): Promise<boolean> {
    const res = await query(
      `SELECT 1 FROM paper_positions WHERE copy_target_id = $1 AND condition_id = $2 AND status = 'open' LIMIT 1`,
      [targetId, conditionId]
    );
    return res.rows.length > 0;
  }
}

function mapRowToPosition(row: any): Position {
  return {
    id: row.id,
    copyTargetId: row.copy_target_id,
    marketId: row.market_id,
    eventId: row.event_id,
    conditionId: row.condition_id,
    side: row.side,
    entryPrice: row.entry_price,
    sizeUsd: row.size_usd,
    shares: row.shares,
    status: row.status,
    openedAt: row.created_at,
    closedAt: row.closed_at,
    exitPrice: row.exit_price,
    pnl: row.pnl,
    metadata: row.metadata || {},
  };
}
