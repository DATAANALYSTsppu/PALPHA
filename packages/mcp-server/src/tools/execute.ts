import { query } from '@polymarket-bot/core';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const executeTools: Tool[] = [
  {
    name: 'start_paper_trading',
    description: 'Start the paper trading loop. REQUIRES USER APPROVAL.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      return {
        status: 'confirmation_required',
        message: 'Paper trading would start a long-running process. Please run: npm run copy:start',
        action: 'npm run copy:start',
      };
    },
  },
  {
    name: 'kill_switch',
    description: 'Emergency: close all open live positions. REQUIRES USER APPROVAL.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      // Check for open live positions
      const liveRes = await query(`SELECT COUNT(*)::int as cnt FROM live_positions WHERE status = 'open'`);
      const liveCount = liveRes.rows[0].cnt;

      if (liveCount === 0) {
        return { status: 'no_action', message: 'No open live positions to close.' };
      }

      return {
        status: 'confirmation_required',
        message: `This will close ${liveCount} open live positions at current market price. This action is irreversible.`,
        live_positions: liveCount,
        action: 'Confirm by calling kill_switch_confirm',
      };
    },
  },
  {
    name: 'pause_all_targets',
    description: 'Pause all active copy targets',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const result = await query(`UPDATE copy_targets SET status = 'paused', updated_at = NOW() WHERE status = 'active'`);
      return { paused: result.rowCount };
    },
  },
  {
    name: 'resume_all_targets',
    description: 'Resume all paused copy targets',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const result = await query(`UPDATE copy_targets SET status = 'active', updated_at = NOW() WHERE status = 'paused'`);
      return { resumed: result.rowCount };
    },
  },
];
