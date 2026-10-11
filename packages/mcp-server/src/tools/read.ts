import { query } from '@polymarket-bot/core';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const readTools: Tool[] = [
  {
    name: 'get_status',
    description: 'Get paper trading account status including balance, PnL, and open position count',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const account = await query(`SELECT * FROM accounts WHERE mode = 'paper' LIMIT 1`);
      const openCount = await query(`SELECT COUNT(*)::int as cnt FROM paper_positions WHERE status = 'open'`);
      const a = account.rows[0];
      if (!a) return { error: 'No paper account found' };
      return {
        balance: a.balance,
        deposited: a.total_deposited,
        realized_pnl: a.realized_pnl,
        unrealized_pnl: a.unrealized_pnl,
        equity: a.balance + (a.unrealized_pnl || 0),
        open_positions: openCount.rows[0].cnt,
      };
    },
  },
  {
    name: 'get_leaderboard',
    description: 'Get top traders by alpha score, optionally filtered by category',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category filter (e.g., "sports", "weather")' },
        limit: { type: 'number', description: 'Number of results (default 10)' },
      },
      required: [],
    },
    handler: async (args) => {
      const limit = (args.limit as number) || 10;
      const cat = args.category as string;
      let result;
      if (cat) {
        result = await query(
          `SELECT t.proxy_wallet, t.display_name, tcs.alpha_score, tcs.alpha_tags, tcs.win_rate, tcs.roi, tcs.total_pnl, tcs.total_trades
           FROM trader_category_stats tcs JOIN traders t ON t.id = tcs.trader_id
           WHERE tcs.category = $1 AND tcs.alpha_score IS NOT NULL
           ORDER BY tcs.alpha_score DESC LIMIT $2`, [cat, limit]
        );
      } else {
        result = await query(
          `SELECT proxy_wallet, display_name, alpha_score, alpha_tags, win_rate, roi, total_pnl, total_trades
           FROM traders WHERE alpha_score IS NOT NULL ORDER BY alpha_score DESC LIMIT $1`, [limit]
        );
      }
      return { traders: result.rows };
    },
  },
  {
    name: 'get_positions',
    description: 'Get open paper trading positions',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max positions (default 20)' } },
      required: [],
    },
    handler: async (args) => {
      const limit = (args.limit as number) || 20;
      const result = await query(
        `SELECT pp.*, e.title, e.category FROM paper_positions pp JOIN events e ON pp.event_id = e.id WHERE pp.status = 'open' ORDER BY pp.opened_at DESC LIMIT $1`, [limit]
      );
      return { positions: result.rows };
    },
  },
  {
    name: 'get_signals',
    description: 'Get recent copy trading signals',
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'Hours to look back (default 24)' } },
      required: [],
    },
    handler: async (args) => {
      const hours = (args.hours as number) || 24;
      const result = await query(
        `SELECT cs.*, ct.display_name as target_name FROM copy_signals cs
         LEFT JOIN copy_targets ct ON cs.copy_target_id = ct.id
         WHERE cs.created_at >= NOW() - INTERVAL '${hours} hours'
         ORDER BY cs.created_at DESC LIMIT 50`
      );
      return { signals: result.rows };
    },
  },
  {
    name: 'get_backtest_results',
    description: 'Get recent backtest results',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max results (default 5)' } },
      required: [],
    },
    handler: async (args) => {
      const limit = (args.limit as number) || 5;
      const result = await query(
        `SELECT id, category, strategy, start_date, end_date, total_return, sharpe_ratio, max_drawdown, win_rate, total_trades, total_pnl, created_at
         FROM backtest_runs ORDER BY created_at DESC LIMIT $1`, [limit]
      );
      return { backtests: result.rows };
    },
  },
];
