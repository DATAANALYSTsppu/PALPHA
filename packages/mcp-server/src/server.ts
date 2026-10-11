import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { query, shutdown } from '@polymarket-bot/core';
import { readTools } from './tools/read.js';
import { writeTools } from './tools/write.js';
import { executeTools } from './tools/execute.js';

const ACCESS_TIER = (process.env.MCP_ACCESS_TIER || 'read') as 'read' | 'write' | 'execute';

const TIER_LEVELS = { read: 1, write: 2, execute: 3 };

function hasAccess(requiredTier: 'read' | 'write' | 'execute'): boolean {
  return TIER_LEVELS[ACCESS_TIER] >= TIER_LEVELS[requiredTier];
}

const allTools = [
  ...readTools,
  ...(hasAccess('write') ? writeTools : []),
  ...(hasAccess('execute') ? executeTools : []),
];

const toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
for (const tool of allTools) {
  toolHandlers.set(tool.name, tool.handler);
}

const server = new Server(
  { name: 'polymarket-bot', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers.get(name);

  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    const result = await handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Polymarket Bot MCP Server started (tier: ${ACCESS_TIER})`);
}

main().catch(err => { console.error(err); process.exit(1); });

process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
