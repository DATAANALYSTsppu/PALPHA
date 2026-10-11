/**
 * scan-trades-onchain-v2 — Optimized trade + redemption ingestion from Polygon.
 *
 * Improvements over v1:
 *  1. Skips trader upserts (trader_id = NULL). Backfill traders after scan.
 *  2. Pipelines: fetches chunk N+1 while writing chunk N to DB.
 *  3. Adds redemption tracking (PayoutRedemption, PositionSplit, PositionsMerge).
 *  4. Supports --to-block and --redemptions-only flags.
 *  5. Fetches both exchange contracts in parallel (not sequential).
 *
 * Usage:
 *   npx tsx packages/core/src/cli/scan-trades-onchain-v2.ts [options]
 *
 *   --from-block=N       Start from specific block
 *   --to-block=N         Stop at specific block (default: latest)
 *   --chunk=N            Blocks per RPC query (default: 500)
 *   --redemptions-only   Only fetch redemption/split/merge events (skip trades)
 */

import { Agent, setGlobalDispatcher } from 'undici';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { query, getClient, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

// Reuse TCP+TLS connections across all RPC calls. Without this, every
// fetch() opens a fresh socket — adding ~50-100ms per request which compounds
// to minutes per chunk. With keepalive: ~50 persistent sockets handle all calls.
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connections: 50,
  pipelining: 10,
}));

const log = createLogger('cli:scan-onchain-v2');

// ── Constants ──────────────────────────────────────────────────

// Exchange contracts (OrderFilled events)
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const EXCHANGE_ADDRESSES = new Set([CTF_EXCHANGE.toLowerCase(), NEG_RISK_CTF_EXCHANGE.toLowerCase()]);

// Conditional Tokens Framework (redemption/split/merge events)
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Event topic0 hashes
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const PAYOUT_REDEMPTION_TOPIC = '0x2682012a4a4f1973119f1c9b90745d1bd91fa2bab387344f044cb3586864d18d';
const POSITION_SPLIT_TOPIC = '0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298';
const POSITIONS_MERGE_TOPIC = '0x6f13ca62553fcc2bcd2372180a43949c1e4cebba603901ede2f4e14f36b282ca';

const POLYMARKET_START_BLOCK = 60000000; // Aug 2025
const USDC_DECIMALS = 6;

const RPC_URL = config.polygon.rpcUrl;
const DEFAULT_CHUNK = config.polygon.chunkSize || 500;

// ── RPC helpers ────────────────────────────────────────────────

// ── Rate limiter: stay under RPC provider's req/sec limit ──
// Reads RPC_RATE_LIMIT env var (default 40 to leave headroom under 50/sec QuickNode cap).
const RPC_RATE_LIMIT = parseInt(process.env.RPC_RATE_LIMIT || '40');
const recentRpcTimestamps: number[] = [];

async function rateLimitGate() {
  // Iterative (not recursive) to avoid stack overflow under high concurrency.
  // With batched timestamp fetches + parallel contract fetches, many gate
  // calls can be pending simultaneously. Recursive version blew the stack.
  while (true) {
    const now = Date.now();
    // Prune old timestamps
    while (recentRpcTimestamps.length > 0 && now - recentRpcTimestamps[0] > 1000) {
      recentRpcTimestamps.shift();
    }
    if (recentRpcTimestamps.length < RPC_RATE_LIMIT) {
      recentRpcTimestamps.push(Date.now());
      return;
    }
    const waitMs = Math.max(10, 1001 - (now - recentRpcTimestamps[0]));
    await new Promise(r => setTimeout(r, waitMs));
  }
}

async function rpcCall(method: string, params: unknown[], retries = 5): Promise<unknown> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await rateLimitGate(); // wait for rate-limit slot before each call
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const json = await res.json() as { result?: unknown; error?: { message: string; code: number } };
      if (json.error) {
        // If we still hit rate limit despite gating, back off and retry
        if (json.error.message?.includes('limited') || json.error.message?.includes('rate')) {
          if (attempt < retries) {
            const delay = attempt * 1000;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }
        throw new Error(`RPC error: ${json.error.message}`);
      }
      return json.result;
    } catch (err) {
      if (attempt < retries) {
        const delay = attempt * 1000; // 1s, 2s, 3s, 4s, 5s
        log.warn({ attempt, retries, err: (err as Error).message }, `RPC call failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function getLatestBlock(): Promise<number> {
  const hex = await rpcCall('eth_blockNumber', []) as string;
  return parseInt(hex, 16);
}

// Block timestamp cache
const blockTsCache = new Map<number, number>();

async function getBlockTimestamp(blockNum: number): Promise<number> {
  const cached = blockTsCache.get(blockNum);
  if (cached !== undefined) return cached;
  const hex = '0x' + blockNum.toString(16);
  const block = await rpcCall('eth_getBlockByNumber', [hex, false]) as { timestamp: string } | null;
  const ts = block ? parseInt(block.timestamp, 16) : 0;
  blockTsCache.set(blockNum, ts);
  return ts;
}

/**
 * Batch-fetch block timestamps via JSON-RPC batch request.
 * Sends up to 100 block lookups in a single HTTP request — counts as ONE
 * RPC call against the rate limit, not N separate calls.
 */
async function batchGetBlockTimestamps(blockNums: number[]): Promise<void> {
  const uncached = blockNums.filter(b => !blockTsCache.has(b));
  if (uncached.length === 0) return;

  const BATCH_SIZE = 100;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);

    // Send as JSON-RPC batch (single HTTP request with array body)
    await rateLimitGate();
    const body = batch.map((b, idx) => ({
      jsonrpc: '2.0',
      id: idx,
      method: 'eth_getBlockByNumber',
      params: ['0x' + b.toString(16), false],
    }));

    let attempts = 0;
    const MAX_ATTEMPTS = 5;
    while (attempts < MAX_ATTEMPTS) {
      try {
        const res = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const results = await res.json() as Array<{ id: number; result?: { timestamp: string } | null; error?: { message: string } }>;

        if (!Array.isArray(results)) throw new Error('Batch response not array');

        for (const r of results) {
          const blockNum = batch[r.id];
          if (r.result && r.result.timestamp) {
            blockTsCache.set(blockNum, parseInt(r.result.timestamp, 16));
          } else {
            blockTsCache.set(blockNum, 0);
          }
        }
        break;
      } catch (err) {
        attempts++;
        if (attempts >= MAX_ATTEMPTS) throw err;
        const delay = attempts * 1000;
        log.warn({ attempt: attempts, err: (err as Error).message }, `Batch block fetch failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

interface RawLog {
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  address: string;
}

/**
 * Fetch logs from a single contract+topics with auto-split on range errors.
 */
async function fetchLogs(
  address: string | string[],
  topics: (string | string[])[],
  fromBlock: number,
  toBlock: number,
): Promise<RawLog[]> {
  try {
    const result = await rpcCall('eth_getLogs', [{
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      address,
      topics,
    }]);
    // Guard against null/undefined RPC responses
    if (!Array.isArray(result)) return [];
    return result as RawLog[];
  } catch (err) {
    const msg = (err as Error).message.toLowerCase();
    // Only split on genuine block-range errors, NOT rate-limit or timeout errors.
    // Rate-limit errors contain "limit" but should be retried by rpcCall, not split.
    const isRangeError =
      msg.includes('block range') ||
      msg.includes('too wide') ||
      msg.includes('too many results') ||
      msg.includes('query returned more than') ||
      msg.includes('response size') ||
      msg.includes('larger than') ||
      msg.includes('exceeded the maximum block range');

    if (isRangeError && toBlock - fromBlock > 1) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const [left, right] = await Promise.all([
        fetchLogs(address, topics, fromBlock, mid),
        fetchLogs(address, topics, mid + 1, toBlock),
      ]);
      return left.concat(right);  // concat avoids stack overflow on huge arrays
    }
    throw err;
  }
}

/**
 * Fetch OrderFilled events from both exchange contracts in parallel.
 */
async function fetchTradeEvents(fromBlock: number, toBlock: number): Promise<RawLog[]> {
  const [ctf, negRisk] = await Promise.all([
    fetchLogs(CTF_EXCHANGE, [ORDER_FILLED_TOPIC], fromBlock, toBlock),
    fetchLogs(NEG_RISK_CTF_EXCHANGE, [ORDER_FILLED_TOPIC], fromBlock, toBlock),
  ]);
  return ctf.concat(negRisk);
}

/**
 * Fetch PayoutRedemption + PositionSplit + PositionsMerge from CTF contract.
 * Uses OR-match on topic0 to get all three in one query.
 */
async function fetchRedemptionEvents(fromBlock: number, toBlock: number): Promise<RawLog[]> {
  return fetchLogs(
    CTF_CONTRACT,
    [[PAYOUT_REDEMPTION_TOPIC, POSITION_SPLIT_TOPIC, POSITIONS_MERGE_TOPIC]],
    fromBlock,
    toBlock,
  );
}

// ── Event parsing ──────────────────────────────────────────────

function hexToAddress(hex: string): string {
  return '0x' + hex.slice(-40).toLowerCase();
}

function formatUSDC(hex: string): number {
  return Number(BigInt(hex)) / Math.pow(10, USDC_DECIMALS);
}

// ── Token ID → Market mapping ──────────────────────────────────

interface MarketMapping {
  marketId: number;
  eventId: number;
  outcome: 'Yes' | 'No';
}

const tokenMap = new Map<string, MarketMapping>();

// conditionId → { marketId, eventId } (for redemption/split/merge mapping)
interface ConditionMapping {
  marketId: number;
  eventId: number;
}
const conditionMap = new Map<string, ConditionMapping>();

async function loadMaps() {
  const res = await query(
    `SELECT id, event_id, condition_id, outcome_yes_token, outcome_no_token
     FROM markets
     WHERE outcome_yes_token IS NOT NULL OR outcome_no_token IS NOT NULL`
  );
  for (const row of res.rows) {
    if (row.outcome_yes_token) {
      tokenMap.set(row.outcome_yes_token, { marketId: row.id, eventId: row.event_id, outcome: 'Yes' });
    }
    if (row.outcome_no_token) {
      tokenMap.set(row.outcome_no_token, { marketId: row.id, eventId: row.event_id, outcome: 'No' });
    }
    if (row.condition_id) {
      conditionMap.set(row.condition_id, { marketId: row.id, eventId: row.event_id });
    }
  }
  log.info({ tokens: tokenMap.size, conditions: conditionMap.size }, 'Maps loaded');
}

// ── Trade row building ─────────────────────────────────────────

interface TradeRow {
  traderId: number | null;
  eventId: number | null;
  marketId: number | null;
  wallet: string;
  side: string;
  outcome: string;
  price: number;
  size: number;
  timestamp: number;
  tradeDate: Date;
  tradeKey: string;
  txHash: string;
  asset: string;
  tradeType: string;
  role: string;
  feeAmount: number;
  orderHash: string;
  counterparty: string;
}

function buildTradeRows(events: RawLog[]): { rows: TradeRow[]; unmapped: number } {
  const rows: TradeRow[] = [];
  let unmapped = 0;

  for (const rawLog of events) {
    const data = rawLog.data.slice(2);
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += 64) {
      chunks.push('0x' + data.slice(i, i + 64));
    }

    const maker = hexToAddress(rawLog.topics[2]);
    const taker = hexToAddress(rawLog.topics[3]);
    const makerAssetId = BigInt(chunks[0]).toString();
    const takerAssetId = BigInt(chunks[1]).toString();
    const makerAmountFilled = formatUSDC(chunks[2]);
    const takerAmountFilled = formatUSDC(chunks[3]);
    const fee = formatUSDC(chunks[4]);
    const blockNumber = parseInt(rawLog.blockNumber, 16);
    const logIndex = parseInt(rawLog.logIndex, 16);
    const orderHash = rawLog.topics[1];

    const tokenId = makerAssetId === '0' ? takerAssetId : makerAssetId;
    const mapping = tokenMap.get(tokenId);
    const ts = blockTsCache.get(blockNumber) || 0;
    const tradeDate = ts > 0 ? new Date(ts * 1000) : new Date();
    const makerIsUSDC = makerAssetId === '0';
    const side = makerIsUSDC ? 'BUY' : 'SELL';
    // Price per share = USDC / shares. USDC is whichever side has assetId='0'.
    // BUG before 2026-05-18: formula was `taker / (maker+taker)` which is a
    // ratio, not a price. Caused PnL to be massively inflated on high-price
    // trades. Fixed to: USDC amount / shares amount.
    const usdcAmount = makerIsUSDC ? makerAmountFilled : takerAmountFilled;
    const sharesAmount = makerIsUSDC ? takerAmountFilled : makerAmountFilled;
    const price = sharesAmount > 0 ? usdcAmount / sharesAmount : 0;
    const size = sharesAmount;

    if (!mapping) unmapped++;

    // Maker row
    rows.push({
      traderId: null,
      eventId: mapping?.eventId ?? null,
      marketId: mapping?.marketId ?? null,
      wallet: maker,
      side,
      outcome: mapping?.outcome ?? 'Unknown',
      price,
      size,
      timestamp: ts,
      tradeDate,
      tradeKey: `onchain:${rawLog.transactionHash}:${logIndex}:maker`,
      txHash: rawLog.transactionHash,
      asset: tokenId,
      tradeType: 'TRADE',
      role: 'maker',
      feeAmount: fee,
      orderHash,
      counterparty: taker,
    });

    // Taker row
    rows.push({
      traderId: null,
      eventId: mapping?.eventId ?? null,
      marketId: mapping?.marketId ?? null,
      wallet: taker,
      side: side === 'BUY' ? 'SELL' : 'BUY',
      outcome: mapping?.outcome ?? 'Unknown',
      price,
      size,
      timestamp: ts,
      tradeDate,
      tradeKey: `onchain:${rawLog.transactionHash}:${logIndex}:taker`,
      txHash: rawLog.transactionHash,
      asset: tokenId,
      tradeType: 'TRADE',
      role: 'taker',
      feeAmount: 0,
      orderHash,
      counterparty: maker,
    });
  }

  return { rows, unmapped };
}

function buildRedemptionRows(events: RawLog[]): { rows: TradeRow[]; unmapped: number } {
  const rows: TradeRow[] = [];
  let unmapped = 0;

  for (const rawLog of events) {
    const topic0 = rawLog.topics[0];
    const blockNumber = parseInt(rawLog.blockNumber, 16);
    const logIndex = parseInt(rawLog.logIndex, 16);
    const ts = blockTsCache.get(blockNumber) || 0;
    const tradeDate = ts > 0 ? new Date(ts * 1000) : new Date();

    const data = rawLog.data.slice(2);
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += 64) {
      chunks.push('0x' + data.slice(i, i + 64));
    }

    if (topic0 === PAYOUT_REDEMPTION_TOPIC) {
      // PayoutRedemption
      // Indexed: redeemer (topic1), collateralToken (topic2), parentCollectionId (topic3)
      // Data: conditionId (bytes32), offset, payout (uint256), ...
      const wallet = hexToAddress(rawLog.topics[1]);
      const conditionId = chunks[0]; // bytes32
      const payout = formatUSDC(chunks[2]);

      const mapping = conditionMap.get(conditionId);
      if (!mapping) unmapped++;

      rows.push({
        traderId: null,
        eventId: mapping?.eventId ?? null,
        marketId: mapping?.marketId ?? null,
        wallet,
        side: 'REDEEM',
        outcome: 'Unknown',
        price: payout > 0 ? 1.0 : 0.0, // won (1.0) or lost (0.0)
        size: payout,
        timestamp: ts,
        tradeDate,
        tradeKey: `onchain:${rawLog.transactionHash}:${logIndex}:redeem`,
        txHash: rawLog.transactionHash,
        asset: conditionId,
        tradeType: 'REDEEM',
        role: 'redeemer',
        feeAmount: 0,
        orderHash: '',
        counterparty: '',
      });

    } else if (topic0 === POSITION_SPLIT_TOPIC || topic0 === POSITIONS_MERGE_TOPIC) {
      // PositionSplit / PositionsMerge
      // Indexed: stakeholder (topic1), parentCollectionId (topic2), conditionId (topic3)
      // Data: collateralToken (address), offset, amount (uint256), ...
      const wallet = hexToAddress(rawLog.topics[1]);

      // Skip exchange-initiated splits/merges (internal to trades, already captured by OrderFilled)
      if (EXCHANGE_ADDRESSES.has(wallet)) continue;

      const conditionId = rawLog.topics[3]; // indexed
      const amount = formatUSDC(chunks[2]);
      const isSplit = topic0 === POSITION_SPLIT_TOPIC;

      const mapping = conditionMap.get(conditionId);
      if (!mapping) unmapped++;

      rows.push({
        traderId: null,
        eventId: mapping?.eventId ?? null,
        marketId: mapping?.marketId ?? null,
        wallet,
        side: isSplit ? 'SPLIT' : 'MERGE',
        outcome: 'Unknown',
        price: 0,
        size: amount,
        timestamp: ts,
        tradeDate,
        tradeKey: `onchain:${rawLog.transactionHash}:${logIndex}:${isSplit ? 'split' : 'merge'}`,
        txHash: rawLog.transactionHash,
        asset: conditionId,
        tradeType: isSplit ? 'SPLIT' : 'MERGE',
        role: 'user',
        feeAmount: 0,
        orderHash: '',
        counterparty: '',
      });
    }
  }

  return { rows, unmapped };
}

// ── COPY-based bulk insert ─────────────────────────────────────
// Replaces multi-row INSERT with PostgreSQL COPY FROM STDIN (text format).
// COPY skips SQL parsing, parameter binding, and uses a single transaction
// per chunk — typically 5-10x faster than INSERT for bulk loads.

/**
 * Escape a value for COPY's text format.
 * Rules: NULL → \N, backslash → \\, tab → \t, newline → \n, CR → \r.
 */
function copyEscape(val: unknown): string {
  if (val === null || val === undefined) return '\\N';
  let s: string;
  if (val instanceof Date) {
    s = val.toISOString();
  } else if (typeof val === 'number') {
    if (!Number.isFinite(val)) return '\\N';
    s = String(val);
  } else {
    s = String(val);
  }
  // Hot path: most strings have no special chars
  if (!/[\\\t\n\r]/.test(s)) return s;
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function rowToCopyLine(r: TradeRow): string {
  // Column order MUST match the COPY column list below.
  return [
    copyEscape(r.traderId),
    copyEscape(r.eventId),
    copyEscape(r.marketId),
    copyEscape(r.wallet),
    copyEscape(r.side),
    copyEscape(r.outcome),
    copyEscape(r.price),
    copyEscape(r.size),
    copyEscape(r.timestamp),
    copyEscape(r.tradeDate),
    copyEscape(r.tradeKey),
    copyEscape(r.txHash),
    copyEscape(r.asset),
    copyEscape(r.tradeType),
    'on-chain',
    copyEscape(r.role),
    copyEscape(r.feeAmount),
    copyEscape(r.orderHash),
    copyEscape(r.counterparty),
  ].join('\t') + '\n';
}

const COPY_SQL = `COPY trades (
  trader_id, event_id, market_id, proxy_wallet,
  side, outcome, price, size, timestamp, trade_date,
  trade_key, transaction_hash, asset_token_id,
  trade_type, source, role, fee_amount, order_hash, counterparty
) FROM STDIN WITH (FORMAT text)`;

/**
 * Stream rows to PostgreSQL via COPY FROM STDIN.
 * Acquires a dedicated client (COPY locks the session) and releases after.
 */
async function insertBatch(rows: TradeRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const client = await getClient();
  try {
    const stream = client.query(copyFrom(COPY_SQL));

    // Build the source as an async iterable so we don't buffer all rows in memory
    // (each chunk can be 100K+ rows = 50MB+ of text).
    const source = Readable.from((async function* () {
      // Emit lines in batches to balance backpressure vs syscall overhead.
      const BATCH = 1000;
      for (let i = 0; i < rows.length; i += BATCH) {
        const end = Math.min(i + BATCH, rows.length);
        const buf: string[] = [];
        for (let j = i; j < end; j++) buf.push(rowToCopyLine(rows[j]));
        yield buf.join('');
      }
    })());

    await pipeline(source, stream);
    return rows.length;
  } finally {
    client.release();
  }
}

// ── Checkpoint ─────────────────────────────────────────────────

async function getCheckpoint(source: string): Promise<number | null> {
  const res = await query(
    `SELECT cursor_value FROM ingest_checkpoints WHERE source = $1 AND status IN ('idle', 'running')`,
    [source]
  );
  const raw = res.rows[0]?.cursor_value;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function saveCheckpoint(source: string, block: number, records: number, status: string, error?: string) {
  await query(
    `INSERT INTO ingest_checkpoints (source, cursor_value, records_ingested, last_run_at, last_error, status, updated_at)
     VALUES ($1, $2, $3, NOW(), $4, $5, NOW())
     ON CONFLICT (source) DO UPDATE SET
       cursor_value = EXCLUDED.cursor_value,
       records_ingested = ingest_checkpoints.records_ingested + EXCLUDED.records_ingested,
       last_run_at = NOW(),
       last_error = EXCLUDED.last_error,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [source, String(block), records, error || null, status]
  );
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv;
  const chunkArg = parseInt(args.find(a => a.startsWith('--chunk='))?.split('=')[1] || '0');
  const fromBlockArg = parseInt(args.find(a => a.startsWith('--from-block='))?.split('=')[1] || '0');
  const toBlockArg = parseInt(args.find(a => a.startsWith('--to-block='))?.split('=')[1] || '0');
  const redemptionsOnly = args.includes('--redemptions-only');
  // --shard=N for running multiple parallel scanners with separate checkpoints.
  // Each shard maintains its own checkpoint so they don't overwrite each other.
  const shardArg = args.find(a => a.startsWith('--shard='))?.split('=')[1] || '';
  // --follow: run forever, resuming from the checkpoint and sleeping between
  // catch-up iterations. Use this under PM2 for continuous ingestion so the
  // DB stays at most `--follow-interval` seconds behind Polygon head.
  const followMode = args.includes('--follow');
  const followIntervalSec = parseInt(
    args.find(a => a.startsWith('--follow-interval='))?.split('=')[1] || '10'
  );
  const chunkSize = chunkArg > 0 ? chunkArg : DEFAULT_CHUNK;

  const mode = redemptionsOnly ? 'redemptions' : 'trades+redemptions';
  const baseSource = redemptionsOnly ? 'redemptions-onchain' : 'trades-onchain-v2';
  const checkpointSource = shardArg ? `${baseSource}-${shardArg}` : baseSource;

  // Load token → market and conditionId → market mappings
  await loadMaps();

  // ── Outer follow loop ───────────────────────────────────────────
  // In one-shot mode this runs exactly once and exits. In --follow mode it
  // resumes from the checkpoint, scans up to head, then sleeps and loops.
  // The scanner is restart-safe: each iteration reads the latest checkpoint
  // afresh, so SIGTERM / crash / PM2 restart resumes cleanly.
  let iteration = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    iteration++;

    // Determine block range (re-fetched each iteration in follow mode)
    let startBlock: number;
    if (fromBlockArg > 0 && iteration === 1) {
      // --from-block= only honoured on the first iteration; afterwards we
      // resume from the checkpoint to avoid re-scanning ranges in a loop.
      startBlock = fromBlockArg;
    } else {
      const checkpoint = await getCheckpoint(checkpointSource);
      startBlock = checkpoint ? checkpoint + 1 : POLYMARKET_START_BLOCK;
    }

    const latestBlock = toBlockArg > 0 ? toBlockArg : await getLatestBlock();

    if (iteration === 1) {
      console.log(`\n=== On-Chain Scanner v2 (${mode}${followMode ? ', follow' : ''}) ===`);
      console.log(`  RPC:              ${RPC_URL.replace(/\/\/.*@/, '//***@').slice(0, 60)}...`);
      console.log(`  Mode:             ${mode}`);
      console.log(`  Start block:      ${startBlock}`);
      console.log(`  End block:        ${latestBlock}`);
      console.log(`  Blocks to scan:   ${latestBlock - startBlock}`);
      console.log(`  Chunk size:       ${chunkSize} blocks`);
      console.log(`  Checkpoint:       ${checkpointSource}`);
      console.log(`  Token mappings:   ${tokenMap.size}`);
      console.log(`  Condition maps:   ${conditionMap.size}`);
      console.log(`  Follow mode:      ${followMode ? `yes (sleep ${followIntervalSec}s when caught up)` : 'no (one-shot)'}`);
      console.log(`  Pipeline:         fetch N+1 while writing N`);
      console.log('');
    } else {
      console.log(`\n--- iteration ${iteration}: blocks ${startBlock} → ${latestBlock} (${latestBlock - startBlock} behind head) ---`);
    }

    if (startBlock >= latestBlock) {
      if (followMode) {
        console.log(`Caught up at block ${latestBlock}. Sleeping ${followIntervalSec}s...`);
        await new Promise(r => setTimeout(r, followIntervalSec * 1000));
        continue;
      }
      console.log('Already up to date.');
      await shutdown();
      return;
    }

  await saveCheckpoint(checkpointSource, startBlock, 0, 'running');

  let totalEvents = 0;
  let totalRows = 0;
  let totalUnmapped = 0;
  let currentBlock = startBlock;
  const scanStart = Date.now();

  // Pipeline state: hold the pending DB write while fetching next chunk
  let pendingWrite: Promise<number> | null = null;
  let pendingWriteRows = 0;

  // Sliding window of recent progress (last 60s) for accurate ETA
  const recentProgress: { t: number; block: number }[] = [];

  while (currentBlock <= latestBlock) {
    const chunkEnd = Math.min(currentBlock + chunkSize - 1, latestBlock);

    try {
      // ── Phase timing for diagnostics ──
      const tFetchStart = Date.now();

      // ── Fetch events (RPC) ──
      let events: RawLog[];
      if (redemptionsOnly) {
        events = await fetchRedemptionEvents(currentBlock, chunkEnd);
      } else {
        // Fetch trades and redemptions in parallel
        const [tradeEvents, redemptionEvents] = await Promise.all([
          fetchTradeEvents(currentBlock, chunkEnd),
          fetchRedemptionEvents(currentBlock, chunkEnd),
        ]);
        events = tradeEvents.concat(redemptionEvents);
      }
      const tFetchMs = Date.now() - tFetchStart;

      totalEvents += events.length;

      // ── Wait for previous write to finish ──
      const tWaitStart = Date.now();
      if (pendingWrite) {
        const inserted = await pendingWrite;
        totalRows += inserted;
        pendingWrite = null;
      }
      const tWaitMs = Date.now() - tWaitStart;

      let tTsMs = 0, tBuildMs = 0;

      if (events.length > 0) {
        // ── Fetch block timestamps (JSON-RPC batch: 100 per HTTP call) ──
        const tTsStart = Date.now();
        const blockNums = [...new Set(events.map(e => parseInt(e.blockNumber, 16)))];
        await batchGetBlockTimestamps(blockNums);
        tTsMs = Date.now() - tTsStart;

        // ── Build rows (CPU only, no DB) ──
        const tBuildStart = Date.now();
        let allRows: TradeRow[] = [];
        let chunkUnmapped = 0;

        if (redemptionsOnly) {
          const result = buildRedemptionRows(events);
          allRows = result.rows;
          chunkUnmapped = result.unmapped;
        } else {
          // Split events by type
          const tradeEvents = events.filter(e => e.topics[0] === ORDER_FILLED_TOPIC);
          const redeemEvents = events.filter(e => e.topics[0] !== ORDER_FILLED_TOPIC);

          if (tradeEvents.length > 0) {
            const t = buildTradeRows(tradeEvents);
            allRows = allRows.concat(t.rows);
            chunkUnmapped += t.unmapped;
          }
          if (redeemEvents.length > 0) {
            const r = buildRedemptionRows(redeemEvents);
            allRows = allRows.concat(r.rows);
            chunkUnmapped += r.unmapped;
          }
        }

        totalUnmapped += chunkUnmapped;
        tBuildMs = Date.now() - tBuildStart;

        // ── Start DB write (don't await — pipeline!) ──
        pendingWriteRows = allRows.length;
        pendingWrite = insertBatch(allRows);

        // ── Prune block timestamp cache ──
        // Timestamps only needed within a chunk. Keep 1K most recent blocks
        // as a buffer (in case of overlap), drop the rest. Prevents unbounded
        // memory growth on long-running scans (was causing slowdowns after
        // ~5M blocks as cache hit millions of entries).
        if (blockTsCache.size > 10000) {
          const keepBlocks = new Set<number>();
          for (let b = chunkEnd - 999; b <= chunkEnd; b++) keepBlocks.add(b);
          for (const k of blockTsCache.keys()) {
            if (!keepBlocks.has(k)) blockTsCache.delete(k);
          }
        }
      }

      currentBlock = chunkEnd + 1;

      // Save checkpoint every chunk (fast, single row upsert)
      await saveCheckpoint(checkpointSource, chunkEnd, totalRows, 'running');

      // ── Log progress ──
      // Track recent rate (last 60s) for accurate ETA after restarts.
      // Avg rate since start is skewed by pipelined writes of early chunks.
      recentProgress.push({ t: Date.now(), block: currentBlock });
      while (recentProgress.length > 0 && Date.now() - recentProgress[0].t > 60000) {
        recentProgress.shift();
      }

      const progress = ((currentBlock - startBlock) / (latestBlock - startBlock) * 100).toFixed(1);
      const elapsed = ((Date.now() - scanStart) / 1000).toFixed(0);
      const blocksLeft = latestBlock - currentBlock;

      // Recent rate from last 60s — more accurate than lifetime average
      let blocksPerSec: number;
      if (recentProgress.length >= 2) {
        const first = recentProgress[0];
        const last = recentProgress[recentProgress.length - 1];
        const dt = (last.t - first.t) / 1000;
        blocksPerSec = dt > 0 ? (last.block - first.block) / dt : 0;
      } else {
        blocksPerSec = (currentBlock - startBlock) / Math.max(1, (Date.now() - scanStart) / 1000);
      }
      const etaMin = blocksPerSec > 0 ? (blocksLeft / blocksPerSec / 60).toFixed(1) : '?';

      if (events.length > 0 || (currentBlock - startBlock) % (chunkSize * 20) === 0) {
        log.info({
          block: `${currentBlock}/${latestBlock}`,
          progress: `${progress}%`,
          events: events.length,
          totalEvents,
          totalRows,
          unmapped: totalUnmapped,
          elapsed: `${elapsed}s`,
          eta: `${etaMin}min`,
          // Phase timing (ms): fetch=RPC events, wait=prev DB write, ts=block timestamps, build=row construction
          timing: `fetch=${tFetchMs} wait=${tWaitMs} ts=${tTsMs} build=${tBuildMs}`,
        }, 'Chunk processed');
      }
    } catch (err) {
      // Wait for any pending write before handling error
      if (pendingWrite) {
        try { totalRows += await pendingWrite; } catch { /* ignore write error */ }
        pendingWrite = null;
      }

      const errMsg = (err as Error).message;
      log.error({ block: currentBlock, err: errMsg }, 'Chunk failed');

      // Save checkpoint so we can resume from this block
      await saveCheckpoint(checkpointSource, currentBlock - 1, totalRows, 'error', errMsg);

      // Stop process cleanly — user can resume from checkpoint
      console.error(`\n❌ Fatal error at block ${currentBlock}: ${errMsg}`);
      console.error(`Checkpoint saved at block ${currentBlock - 1}. Resume with:`);
      console.error(`  npm run scan:trades:onchain:v2 -- --from-block=${currentBlock}`);
      await shutdown();
      process.exit(1);
    }
  }

    // Flush final pending write
    if (pendingWrite) {
      totalRows += await pendingWrite;
    }

    await saveCheckpoint(checkpointSource, latestBlock, totalRows, 'idle');

    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
    console.log(`\n=== Iteration ${iteration} complete ===`);
    console.log(`  Blocks scanned:    ${latestBlock - startBlock}`);
    console.log(`  Events found:      ${totalEvents}`);
    console.log(`  Trade rows:        ${totalRows}`);
    console.log(`  Unmapped:          ${totalUnmapped}`);
    console.log(`  Elapsed:           ${elapsed}s`);

    if (!followMode) {
      console.log(`  Note:              trader_id is NULL — run backfill-traders after scan`);
      await shutdown();
      return;
    }

    // Follow mode: sleep until the chain is likely to have new blocks, then
    // loop. We don't shut down the DB pool between iterations to avoid
    // reconnect churn.
    console.log(`Sleeping ${followIntervalSec}s before next iteration...`);
    await new Promise(r => setTimeout(r, followIntervalSec * 1000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
