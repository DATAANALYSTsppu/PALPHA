/**
 * probe-wallet — Ground-truth diagnostic tool for a single Polymarket
 * proxy wallet. Compares three independent sources and prints a side-by-side
 * report so we can see where our recorded data diverges from on-chain reality:
 *
 *   1. POLYMARKET DATA API        — what Polymarket itself reports for the
 *                                   wallet (lifetime PnL + open positions).
 *                                   Pagination caps responses around 3k rows,
 *                                   so we only request summary endpoints.
 *
 *   2. POLYGON RPC (eth_getLogs)  — raw event counts directly from chain,
 *                                   filtered by the wallet as indexed
 *                                   stakeholder. This is what the scanner
 *                                   should have captured.
 *
 *   3. OUR DB (polymarket_v3)     — what we actually recorded in `trades`.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/probe-wallet.ts 0xbd14da50...76b4
 *   npx tsx packages/core/src/cli/probe-wallet.ts <wallet> --from-block=70000000
 *
 * Read-only: no INSERT/UPDATE anywhere. Safe to run against production.
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';
import { request as undiciRequest } from 'undici';

// ─── Constants (same as scan-trades-onchain-v2) ─────────────────

const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const PAYOUT_REDEMPTION_TOPIC = '0x2682012a4a4f1973119f1c9b90745d1bd91fa2bab387344f044cb3586864d18d';
const POSITION_SPLIT_TOPIC = '0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298';
const POSITIONS_MERGE_TOPIC = '0x6f13ca62553fcc2bcd2372180a43949c1e4cebba603901ede2f4e14f36b282ca';

const DEFAULT_START_BLOCK = 60000000;
const POLYMARKET_DATA_API = config.api.dataUrl || 'https://data-api.polymarket.com';
const RPC_URL = config.polygon.rpcUrl;

// ─── Helpers ────────────────────────────────────────────────────

/** Pad a 0x-prefixed 20-byte address to a 32-byte topic (zero-extended on the left). */
function addressToTopic(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
}

/** Generic JSON-RPC call to the Polygon node. */
async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await undiciRequest(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text().catch(() => '<unreadable body>');
    throw new Error(
      `RPC ${method}: HTTP ${res.statusCode}. ` +
        `Endpoint may be rate-limiting or rejecting. ` +
        `Set POLYMARKET_RPC in packages/core/.env to your dedicated provider. ` +
        `Body: ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.body.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (json.error) {
    throw new Error(`RPC ${method}: code=${json.error.code} message=${json.error.message ?? '<no message>'}`);
  }
  if (json.result === undefined) {
    throw new Error(`RPC ${method}: response had neither 'result' nor 'error'. Body: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.result as T;
}

/**
 * eth_getLogs with auto-split on "range too large" errors. Returns the total
 * COUNT of matching logs (we don't keep the bodies — we only need counts and
 * USDC totals to compare against our DB).
 */
async function countLogs(
  address: string,
  topic0Filter: string | string[],
  topic1Filter: string | null,
  fromBlock: number,
  toBlock: number,
  collected: { count: number; sumAmount: number },
): Promise<void> {
  if (fromBlock > toBlock) return;
  const topics: (string | string[] | null)[] = [topic0Filter];
  if (topic1Filter) topics.push(topic1Filter);

  try {
    const logs = await rpc<Array<{ data: string; topics: string[] }>>('eth_getLogs', [
      {
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        address,
        topics,
      },
    ]);
    collected.count += logs.length;
    // Sum the `amount` / `payout` from the event data. For all three event
    // types we care about, the amount is in the last 32-byte word of `data`
    // (uint256, USDC decimals). Skip if data is empty.
    for (const log of logs) {
      const raw = log.data?.replace(/^0x/, '') ?? '';
      if (raw.length < 64) continue;
      const lastWord = raw.slice(-64);
      const usdc = Number(BigInt('0x' + lastWord)) / 1_000_000;
      if (Number.isFinite(usdc)) collected.sumAmount += usdc;
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('range') || msg.includes('more than') || msg.includes('limit')) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      await countLogs(address, topic0Filter, topic1Filter, fromBlock, mid, collected);
      await countLogs(address, topic0Filter, topic1Filter, mid + 1, toBlock, collected);
    } else {
      throw err;
    }
  }
}

// ─── 1. Polymarket Data API ─────────────────────────────────────

interface PolymarketSummary {
  ok: boolean;
  source: string;
  value?: number;
  positions?: number;
  raw?: unknown;
  error?: string;
}

async function fetchPolymarketSummary(wallet: string): Promise<PolymarketSummary> {
  // Try a few common endpoint shapes. Polymarket has changed paths over time,
  // and individual endpoints may or may not be open without auth — so we try
  // the documented ones and record what worked.
  const candidates = [
    { url: `${POLYMARKET_DATA_API}/value?user=${wallet}`, field: 'value' },
    { url: `${POLYMARKET_DATA_API}/positions?user=${wallet}&limit=500`, field: 'positions' },
  ];
  const result: PolymarketSummary = { ok: false, source: POLYMARKET_DATA_API };
  for (const c of candidates) {
    try {
      const res = await undiciRequest(c.url, { method: 'GET' });
      if (res.statusCode !== 200) continue;
      const body = await res.body.json();
      if (c.field === 'value') {
        // Response is often a single object or array with `pnl`/`value` field.
        const v = Array.isArray(body)
          ? (body[0] as { value?: number; pnl?: number })
          : (body as { value?: number; pnl?: number });
        result.value = v.value ?? v.pnl;
        result.ok = true;
      } else if (c.field === 'positions') {
        result.positions = Array.isArray(body) ? body.length : undefined;
        result.raw = body;
      }
    } catch (err) {
      result.error = (err as Error).message;
    }
  }
  return result;
}

// ─── 2. On-chain (Polygon RPC) — count raw events for this wallet ──

interface OnChainCounts {
  startBlock: number;
  endBlock: number;
  orderFilled_maker: number;       // wallet was maker
  orderFilled_taker: number;       // wallet was taker
  splits: number;
  splits_usd: number;
  merges: number;
  merges_usd: number;
  redeems: number;
  redeems_usd: number;
}

async function fetchOnChainCounts(wallet: string, fromBlock: number): Promise<OnChainCounts> {
  const latestBlockHex = await rpc<string>('eth_blockNumber', []);
  const endBlock = parseInt(latestBlockHex, 16);
  const topicWallet = addressToTopic(wallet);

  // Conditional Tokens: SPLIT / MERGE / REDEEM emit `stakeholder` (or
  // `redeemer` for PayoutRedemption) as the first indexed topic.
  const splitC = { count: 0, sumAmount: 0 };
  const mergeC = { count: 0, sumAmount: 0 };
  const redeemC = { count: 0, sumAmount: 0 };

  await Promise.all([
    countLogs(CTF_CONTRACT, POSITION_SPLIT_TOPIC, topicWallet, fromBlock, endBlock, splitC),
    countLogs(CTF_CONTRACT, POSITIONS_MERGE_TOPIC, topicWallet, fromBlock, endBlock, mergeC),
    countLogs(CTF_CONTRACT, PAYOUT_REDEMPTION_TOPIC, topicWallet, fromBlock, endBlock, redeemC),
  ]);

  // OrderFilled on the exchanges: wallet appears as `maker` (topic2) or
  // `taker` (topic3). We do two separate calls to count each role.
  const makerC = { count: 0, sumAmount: 0 };
  const takerC = { count: 0, sumAmount: 0 };

  // Indexed positions for OrderFilled on Polymarket CTF Exchange:
  //   topic0 = sig hash
  //   topic1 = orderHash
  //   topic2 = maker
  //   topic3 = taker
  // We can only filter by ONE wallet topic per RPC call, so we issue two:
  // one filtering topic2=wallet (maker), one filtering topic3=wallet (taker).
  await Promise.all([
    // maker — pass null for topic1 and topic2=wallet
    (async () => {
      const c1 = { count: 0, sumAmount: 0 };
      const c2 = { count: 0, sumAmount: 0 };
      // eth_getLogs lets us pass [topic0, null, topic2] to match by position.
      await countLogsWithPos(CTF_EXCHANGE,        [ORDER_FILLED_TOPIC, null, topicWallet], fromBlock, endBlock, c1);
      await countLogsWithPos(NEG_RISK_CTF_EXCHANGE, [ORDER_FILLED_TOPIC, null, topicWallet], fromBlock, endBlock, c2);
      makerC.count = c1.count + c2.count;
    })(),
    (async () => {
      const c1 = { count: 0, sumAmount: 0 };
      const c2 = { count: 0, sumAmount: 0 };
      await countLogsWithPos(CTF_EXCHANGE,        [ORDER_FILLED_TOPIC, null, null, topicWallet], fromBlock, endBlock, c1);
      await countLogsWithPos(NEG_RISK_CTF_EXCHANGE, [ORDER_FILLED_TOPIC, null, null, topicWallet], fromBlock, endBlock, c2);
      takerC.count = c1.count + c2.count;
    })(),
  ]);

  return {
    startBlock: fromBlock,
    endBlock,
    orderFilled_maker: makerC.count,
    orderFilled_taker: takerC.count,
    splits: splitC.count,
    splits_usd: splitC.sumAmount,
    merges: mergeC.count,
    merges_usd: mergeC.sumAmount,
    redeems: redeemC.count,
    redeems_usd: redeemC.sumAmount,
  };
}

/** Variant of countLogs that takes a positional topics array (with `null`s allowed). */
async function countLogsWithPos(
  address: string,
  topics: (string | string[] | null)[],
  fromBlock: number,
  toBlock: number,
  collected: { count: number; sumAmount: number },
): Promise<void> {
  if (fromBlock > toBlock) return;
  try {
    const logs = await rpc<Array<{ data: string; topics: string[] }>>('eth_getLogs', [
      {
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        address,
        topics,
      },
    ]);
    collected.count += logs.length;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('range') || msg.includes('more than') || msg.includes('limit')) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      await countLogsWithPos(address, topics, fromBlock, mid, collected);
      await countLogsWithPos(address, topics, mid + 1, toBlock, collected);
    } else {
      throw err;
    }
  }
}

// ─── 3. Our DB ──────────────────────────────────────────────────

interface OurDbStats {
  total_trades: number;
  buys: number;
  sells: number;
  splits: number;
  merges: number;
  redeems: number;
  distinct_markets: number;
  resolved_markets: number;
  bought_usd: number;
  sold_usd: number;
  splits_usd: number;
  merges_usd: number;
  redeems_usd: number;
  cash_flow_pnl: number;
}

async function fetchOurDbStats(wallet: string): Promise<OurDbStats> {
  const res = await query(
    `
    SELECT
      COUNT(*)::int AS total_trades,
      COUNT(*) FILTER (WHERE side='BUY')::int    AS buys,
      COUNT(*) FILTER (WHERE side='SELL')::int   AS sells,
      COUNT(*) FILTER (WHERE side='SPLIT')::int  AS splits,
      COUNT(*) FILTER (WHERE side='MERGE')::int  AS merges,
      COUNT(*) FILTER (WHERE side='REDEEM')::int AS redeems,
      COUNT(DISTINCT market_id)::int             AS distinct_markets,
      COUNT(DISTINCT market_id) FILTER (
        WHERE market_id IN (SELECT id FROM markets WHERE resolved_to IS NOT NULL)
      )::int AS resolved_markets,
      COALESCE(SUM(CASE WHEN side='BUY'  THEN price*size END), 0)::float AS bought_usd,
      COALESCE(SUM(CASE WHEN side='SELL' THEN price*size END), 0)::float AS sold_usd,
      COALESCE(SUM(CASE WHEN side='SPLIT'  THEN size END), 0)::float     AS splits_usd,
      COALESCE(SUM(CASE WHEN side='MERGE'  THEN size END), 0)::float     AS merges_usd,
      COALESCE(SUM(CASE WHEN side='REDEEM' THEN size END), 0)::float     AS redeems_usd
    FROM trades
    WHERE proxy_wallet = LOWER($1)
    `,
    [wallet],
  );
  const r = res.rows[0];
  // Cash flow PnL (matches the scorer's methodology, ignores still-open positions):
  //   pnl = sells_usd + redeems_usd + merges_usd - buys_usd - splits_usd
  r.cash_flow_pnl = r.sold_usd + r.redeems_usd + r.merges_usd - r.bought_usd - r.splits_usd;
  return r as OurDbStats;
}

// ─── Report ─────────────────────────────────────────────────────

function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '   —   ';
  const sign = n < 0 ? '-' : ' ';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function diffMark(ours: number, theirs: number): string {
  if (ours === theirs) return '✅';
  if (theirs > 0 && ours === 0) return '❌ MISSING';
  return `❌ Δ ${ours - theirs > 0 ? '+' : ''}${ours - theirs}`;
}

function printReport(
  wallet: string,
  poly: PolymarketSummary,
  chain: OnChainCounts,
  db: OurDbStats,
): void {
  const totalOrderFilled = chain.orderFilled_maker + chain.orderFilled_taker;
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  GROUND-TRUTH PROBE: ${wallet}`);
  console.log(`  Block range scanned on chain: ${chain.startBlock} → ${chain.endBlock}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  POLYMARKET DATA API');
  console.log(`    Lifetime PnL (reported):    ${fmtUsd(poly.value)}`);
  console.log(`    Open positions:             ${poly.positions ?? '—'}`);
  if (!poly.ok) console.log(`    [warn] one or more endpoints did not return 200: ${poly.error ?? 'see above'}`);
  console.log('');
  console.log('  POLYGON RPC (raw events for this wallet)');
  console.log(`    OrderFilled  (maker):       ${chain.orderFilled_maker}`);
  console.log(`    OrderFilled  (taker):       ${chain.orderFilled_taker}`);
  console.log(`    OrderFilled  TOTAL:         ${totalOrderFilled}`);
  console.log(`    PositionSplit:              ${chain.splits}    (${fmtUsd(chain.splits_usd)})`);
  console.log(`    PositionsMerge:             ${chain.merges}    (${fmtUsd(chain.merges_usd)})`);
  console.log(`    PayoutRedemption:           ${chain.redeems}    (${fmtUsd(chain.redeems_usd)})`);
  console.log('');
  console.log('  OUR DB (polymarket_v3)');
  console.log(`    BUY  rows:                  ${db.buys}`);
  console.log(`    SELL rows:                  ${db.sells}`);
  console.log(`    BUY+SELL total:             ${db.buys + db.sells}     ${diffMark(db.buys + db.sells, totalOrderFilled)}`);
  console.log(`    SPLIT rows:                 ${db.splits}     ${diffMark(db.splits, chain.splits)}`);
  console.log(`    MERGE rows:                 ${db.merges}     ${diffMark(db.merges, chain.merges)}`);
  console.log(`    REDEEM rows:                ${db.redeems}     ${diffMark(db.redeems, chain.redeems)}`);
  console.log(`    Distinct markets:           ${db.distinct_markets}`);
  console.log(`    Resolved markets:           ${db.resolved_markets}`);
  console.log(`    Bought (USD):               ${fmtUsd(db.bought_usd)}`);
  console.log(`    Sold   (USD):               ${fmtUsd(db.sold_usd)}`);
  console.log(`    Splits (USD):               ${fmtUsd(db.splits_usd)}`);
  console.log(`    Merges (USD):               ${fmtUsd(db.merges_usd)}`);
  console.log(`    Redeems (USD):              ${fmtUsd(db.redeems_usd)}`);
  console.log(`    Computed cash-flow PnL:     ${fmtUsd(db.cash_flow_pnl)}`);
  console.log('');
  console.log('  COMPARISON');
  if (poly.value !== undefined) {
    const drift = db.cash_flow_pnl - poly.value;
    console.log(`    Polymarket says:            ${fmtUsd(poly.value)}`);
    console.log(`    Our computed:               ${fmtUsd(db.cash_flow_pnl)}`);
    console.log(`    Drift:                      ${fmtUsd(drift)}     ${Math.abs(drift) < 10 ? '✅' : '❌'}`);
  } else {
    console.log('    [skipped — Polymarket value unavailable]');
  }
  console.log('');
  console.log('  DIAGNOSIS');
  const lines: string[] = [];
  if (db.splits === 0 && chain.splits > 0) lines.push(`    • Scanner missing ${chain.splits} SPLIT events.`);
  if (db.merges === 0 && chain.merges > 0) lines.push(`    • Scanner missing ${chain.merges} MERGE events.`);
  if (db.redeems < chain.redeems)         lines.push(`    • Scanner missing ${chain.redeems - db.redeems} REDEEM events.`);
  if (db.buys + db.sells !== totalOrderFilled)
    lines.push(`    • OrderFilled discrepancy: chain has ${totalOrderFilled}, DB has ${db.buys + db.sells}.`);
  if (lines.length === 0) {
    console.log('    No discrepancy detected between chain and DB.');
  } else {
    lines.forEach(l => console.log(l));
  }
  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const wallet = args.find(a => a.startsWith('0x'));
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    console.error('Usage: probe-wallet <0xWalletAddress> [--from-block=N]');
    process.exit(1);
  }
  const fromBlockArg = args.find(a => a.startsWith('--from-block='));
  const fromBlock = fromBlockArg ? parseInt(fromBlockArg.split('=')[1]) : DEFAULT_START_BLOCK;

  console.log(`Probing wallet ${wallet} from block ${fromBlock}...`);
  console.log(`(RPC: ${RPC_URL.replace(/\/\/.*@/, '//***@').slice(0, 60)}...)`);

  const [poly, chain, db] = await Promise.all([
    fetchPolymarketSummary(wallet),
    fetchOnChainCounts(wallet, fromBlock),
    fetchOurDbStats(wallet),
  ]);

  printReport(wallet, poly, chain, db);
  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
