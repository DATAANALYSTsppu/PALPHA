import { query } from '@polymarket-bot/core';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const writeTools: Tool[] = [
  {
    name: 'add_target',
    description: 'Add a trader as a copy target by wallet address or display name',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: 'Trader proxy wallet address' },
        name: { type: 'string', description: 'Trader display name to search for' },
        category: { type: 'string', description: 'Category scope (optional)' },
      },
      required: [],
    },
    handler: async (args) => {
      let trader;
      if (args.wallet) {
        const res = await query(`SELECT id, proxy_wallet, display_name, alpha_score FROM traders WHERE proxy_wallet = $1`, [args.wallet]);
        trader = res.rows[0];
      } else if (args.name) {
        const res = await query(`SELECT id, proxy_wallet, display_name, alpha_score FROM traders WHERE display_name ILIKE $1 LIMIT 1`, [`%${args.name}%`]);
        trader = res.rows[0];
      }
      if (!trader) return { error: 'Trader not found' };

      await query(
        `INSERT INTO copy_targets (trader_id, proxy_wallet, display_name, category, status, added_by)
         VALUES ($1, $2, $3, $4, 'active', 'mcp')
         ON CONFLICT DO NOTHING`,
        [trader.id, trader.proxy_wallet, trader.display_name, (args.category as string) || null]
      );
      return { success: true, trader: { wallet: trader.proxy_wallet, name: trader.display_name, alpha: trader.alpha_score } };
    },
  },
  {
    name: 'remove_target',
    description: 'Stop copying a trader',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: 'Trader proxy wallet to remove' },
      },
      required: ['wallet'],
    },
    handler: async (args) => {
      await query(`UPDATE copy_targets SET status = 'stopped', updated_at = NOW() WHERE proxy_wallet = $1 AND status = 'active'`, [args.wallet]);
      return { success: true };
    },
  },
  {
    name: 'run_backtest',
    description: 'Run a backtest with specified parameters',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        days: { type: 'number', description: 'Number of days to backtest (default 30)' },
        balance: { type: 'number', description: 'Initial balance (default 1000)' },
        min_alpha: { type: 'number', description: 'Minimum alpha score for traders (default 60)' },
      },
      required: [],
    },
    handler: async (args) => {
      // Import dynamically to avoid circular deps
      const { runBacktest } = await import('@polymarket-bot/core/backtest');
      const days = (args.days as number) || 30;
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 86400000);
      const result = await runBacktest({
        category: args.category as string,
        startDate, endDate,
        initialBalance: (args.balance as number) || 1000,
        positionSize: 10,
        maxPricePerShare: 0.70,
        maxOpenPositions: 20,
        dailyLossLimit: 100,
        minAlphaScore: (args.min_alpha as number) || 60,
      });
      return {
        total_return: result.totalReturn,
        return_pct: result.totalReturnPct,
        sharpe: result.sharpeRatio,
        max_drawdown_pct: result.maxDrawdownPct,
        win_rate: result.winRate,
        total_trades: result.totalTrades,
      };
    },
  },
];
