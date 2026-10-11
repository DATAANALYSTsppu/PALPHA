/**
 * scan-trades-onchain — Complete trade ingestion from Polygon blockchain.
 *
 * Reads OrderFilled events from Polymarket's CTF Exchange contracts on Polygon.
 * No API pagination limits — gets EVERY trade ever made.
 *
 * For each event:
 *  - Parses maker, taker, amounts, fee from event logs
 *  - Maps token IDs to markets via DB lookup
 *  - Derives side (BUY/SELL), outcome (Yes/No), price
 *  - Batch-inserts into trades table
 *
 * Incremental: resumes from last processed block via ingest_checkpoints.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/scan-trades-onchain.ts [--from-block=N] [--chunk=N]
 *
 *   --from-block=N   Start from specific block (default: resume from checkpoint or deployment block)
 *   --chunk=N        Blocks per RPC query (default: from config, typically 200)
 *   --backfill       Run full backfill from Polymarket deployment block
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:scan-trades-onchain');

// ── Constants ──────────────────────────────────────────────────
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const POLYMARKET_START_BLOCK = 33605403;
const USDC_DECIMALS = 6;
const CHECKPOINT_SOURCE = 'trades-onchain';

const RPC_URL = config.polygon.rpcUrl;
const DEFAULT_CHUNK = config.polygon.chunkSize;

// ── RPC helpers ────────────────────────────────────────────────

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string; code: number } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function getLatestBlock(): Promise<number> {
  const hex = await rpcCall('eth_blockNumber', []) as string;
  return parseInt(hex, 16);
}

// Block timestamp cache — same block always has same timestamp
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

interface RawLog {
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  address: string;
}

/**
 * Fetch OrderFilled events from both contracts in a block range.
 * If range is too large for RPC, splits in half and retries.
 */
async function fetchEvents(fromBlock: number, toBlock: number): Promise<RawLog[]> {
  const allLogs: RawLog[] = [];

  for (const contract of [CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE]) {
    try {
      const logs = await rpcCall('eth_getLogs', [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        address: contract,
        topics: [ORDER_FILLED_TOPIC],
      }]) as RawLog[];
      allLogs.push(...logs);
    } catch (err) {
      const msg = (err as Error).message;
      // RPC range too large — split in half
      if (msg.includes('range') || msg.includes('limit') || msg.includes('too many') || msg.includes('exceed')) {
        if (toBlock - fromBlock <= 1) throw err; // can't split further
        const mid = Math.floor((fromBlock + toBlock) / 2);
        const left = await fetchEvents(fromBlock, mid);
        const right = await fetchEvents(mid + 1, toBlock);
        allLogs.push(...left, ...right);
      } else {
        throw err;
      }
    }
  }

  return allLogs;
}

// ── Event parsing ──────────────────────────────────────────────

function hexToAddress(hex: string): string {
  return '0x' + hex.slice(-40).toLowerCase();
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
}

function formatUSDC(raw: bigint): number {
  return Number(raw) / Math.pow(10, USDC_DECIMALS);
}

interface ParsedTrade {
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: number;
  takerAmountFilled: number;
  fee: number;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  isNegRisk: boolean;
}

function parseEvent(log: RawLog): ParsedTrade {
  const data = log.data.slice(2);
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 64) {
    chunks.push('0x' + data.slice(i, i + 64));
  }

  return {
    orderHash: log.topics[1],
    maker: hexToAddress(log.topics[2]),
    taker: hexToAddress(log.topics[3]),
    makerAssetId: hexToBigInt(chunks[0]).toString(),
    takerAssetId: hexToBigInt(chunks[1]).toString(),
    makerAmountFilled: formatUSDC(hexToBigInt(chunks[2])),
    takerAmountFilled: formatUSDC(hexToBigInt(chunks[3])),
    fee: formatUSDC(hexToBigInt(chunks[4])),
    transactionHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    logIndex: parseInt(log.logIndex, 16),
    isNegRisk: log.address.toLowerCase() === NEG_RISK_CTF_EXCHANGE.toLowerCase(),
  };
}

// ── Token ID → Market mapping ──────────────────────────────────

interface MarketMapping {
  marketId: number;
  eventId: number;
  outcome: 'Yes' | 'No';
}

// Pre-loaded map: tokenId → { marketId, eventId, outcome }
const tokenMap = new Map<string, MarketMapping>();

async function loadTokenMap() {
  const res = await query(
    `SELECT id, event_id, outcome_yes_token, outcome_no_token
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
  }
  log.info({ tokens: tokenMap.size }, 'Token map loaded');
}

// ── Trade derivation ───────────────────────────────────────────

function deriveSide(trade: ParsedTrade): 'BUY' | 'SELL' {
  // If takerAssetId is 0 (or very small = USDC), taker is buying outcome tokens
  // with USDC, so maker is SELLING outcome tokens.
  // If makerAssetId is 0, maker is paying USDC, so maker is BUYING outcome tokens.
  const makerAssetIsUSDC = trade.makerAssetId === '0';
  return makerAssetIsUSDC ? 'BUY' : 'SELL';
}

function derivePrice(trade: ParsedTrade): number {
  // Price = USDC amount / (USDC amount + token amount)
  // For a BUY (maker pays USDC): price = makerAmount / (makerAmount + takerAmount)
  // For a SELL (maker receives USDC): price = takerAmount / (takerAmount + makerAmount)
  const total = trade.makerAmountFilled + trade.takerAmountFilled;
  if (total === 0) return 0;
  return trade.takerAmountFilled / total;
}

function getTokenId(trade: ParsedTrade): string {
  // The outcome token is whichever asset is NOT USDC (not 0)
  return trade.makerAssetId === '0' ? trade.takerAssetId : trade.makerAssetId;
}

// ── Trader upsert (batch + cached) ────────────────────────────

const traderIdCache = new Map<string, number>();

/**
 * Batch-upsert all unique wallets in one multi-row INSERT.
 * Replaces 32K individual queries per chunk with 1 query.
 */
async function batchUpsertTraders(wallets: string[], seenAt: Date): Promise<void> {
  // Filter to only uncached wallets
  const uncached = [...new Set(wallets)].filter(w => w && !traderIdCache.has(w));
  if (uncached.length === 0) return;

  // Batch in groups of 5000 (PG param limit / 2 cols per row)
  const TRADER_BATCH = 5000;
  for (let i = 0; i < uncached.length; i += TRADER_BATCH) {
    const batch = uncached.slice(i, i + TRADER_BATCH);
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (let j = 0; j < batch.length; j++) {
      const off = j * 2;
      placeholders.push(`($${off + 1}, $${off + 2}, $${off + 2})`);
      values.push(batch[j], seenAt);
    }

    const res = await query(
      `INSERT INTO traders (proxy_wallet, first_seen_at, last_seen_at)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (proxy_wallet) DO UPDATE SET
         last_seen_at = GREATEST(traders.last_seen_at, EXCLUDED.last_seen_at),
         updated_at = NOW()
       RETURNING id, proxy_wallet`,
      values
    );

    for (const row of res.rows) {
      traderIdCache.set(row.proxy_wallet, row.id);
    }
  }
}

// ── Batch insert ───────────────────────────────────────────────

const COLS_PER_ROW = 19;
const MAX_PG_PARAMS = 65535;
const BATCH_SIZE = Math.floor(MAX_PG_PARAMS / COLS_PER_ROW);

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

async function insertBatch(rows: TradeRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  // Split into chunks if needed
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let j = 0; j < chunk.length; j++) {
      const r = chunk[j];
      const off = j * COLS_PER_ROW;
      placeholders.push(
        `($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11},$${off+12},$${off+13},$${off+14},$${off+15},$${off+16},$${off+17},$${off+18},$${off+19})`
      );
      values.push(
        r.traderId, r.eventId, r.marketId, r.wallet,
        r.side, r.outcome, r.price, r.size, r.timestamp, r.tradeDate,
        r.tradeKey, r.txHash, r.asset,
        r.tradeType, 'on-chain', r.role, r.feeAmount, r.orderHash, r.counterparty,
      );
    }

    const res = await query(
      `INSERT INTO trades (
         trader_id, event_id, market_id, proxy_wallet,
         side, outcome, price, size, timestamp, trade_date,
         trade_key, transaction_hash, asset_token_id,
         trade_type, source, role, fee_amount, order_hash, counterparty
       ) VALUES ${placeholders.join(',')}
       ON CONFLICT (trade_key) DO NOTHING`,
      values
    );
    total += res.rowCount ?? 0;
  }
  return total;
}

// ── Checkpoint ─────────────────────────────────────────────────

async function getCheckpoint(): Promise<number | null> {
  const res = await query(
    `SELECT cursor_value FROM ingest_checkpoints WHERE source = $1 AND status IN ('idle', 'running')`,
    [CHECKPOINT_SOURCE]
  );
  const raw = res.rows[0]?.cursor_value;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function saveCheckpoint(block: number, records: number, status: string, error?: string) {
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
    [CHECKPOINT_SOURCE, String(block), records, error || null, status]
  );
}

// ── Process a chunk of events ──────────────────────────────────

async function processChunk(
  events: RawLog[],
): Promise<{ rows: TradeRow[]; unmapped: number }> {
  const rows: TradeRow[] = [];
  let unmapped = 0;

  // Phase 1: Parse all events (CPU only, no DB)
  const parsed = events.map(e => parseEvent(e));

  // Phase 2: Batch fetch block timestamps (parallel RPC, 20 at a time)
  const blockNums = [...new Set(parsed.map(t => t.blockNumber))];
  for (let i = 0; i < blockNums.length; i += 20) {
    await Promise.all(blockNums.slice(i, i + 20).map(b => getBlockTimestamp(b)));
  }

  // Phase 3: Batch upsert ALL unique wallets in one query (was 32K individual queries)
  const allWallets = parsed.flatMap(t => [t.maker, t.taker]);
  const earliestTs = Math.min(...blockNums.map(b => blockTsCache.get(b) || 0).filter(t => t > 0));
  const seenAt = earliestTs > 0 ? new Date(earliestTs * 1000) : new Date();
  await batchUpsertTraders(allWallets, seenAt);

  // Phase 4: Build trade rows (all lookups from cache, zero DB queries)
  for (const trade of parsed) {
    const tokenId = getTokenId(trade);
    const mapping = tokenMap.get(tokenId);
    const ts = blockTsCache.get(trade.blockNumber) || 0;
    const tradeDate = ts > 0 ? new Date(ts * 1000) : new Date();
    const side = deriveSide(trade);
    const price = derivePrice(trade);
    const size = Math.max(trade.makerAmountFilled, trade.takerAmountFilled);

    if (!mapping) unmapped++;

    const makerId = traderIdCache.get(trade.maker) ?? null;
    const takerId = traderIdCache.get(trade.taker) ?? null;

    // Maker row
    rows.push({
      traderId: makerId,
      eventId: mapping?.eventId ?? null,
      marketId: mapping?.marketId ?? null,
      wallet: trade.maker,
      side,
      outcome: mapping?.outcome ?? 'Unknown',
      price,
      size,
      timestamp: ts,
      tradeDate,
      tradeKey: `onchain:${trade.transactionHash}:${trade.logIndex}:maker`,
      txHash: trade.transactionHash,
      asset: tokenId,
      tradeType: 'TRADE',
      role: 'maker',
      feeAmount: trade.fee,
      orderHash: trade.orderHash,
      counterparty: trade.taker,
    });

    // Taker row
    rows.push({
      traderId: takerId,
      eventId: mapping?.eventId ?? null,
      marketId: mapping?.marketId ?? null,
      wallet: trade.taker,
      side: side === 'BUY' ? 'SELL' : 'BUY',
      outcome: mapping?.outcome ?? 'Unknown',
      price,
      size,
      timestamp: ts,
      tradeDate,
      tradeKey: `onchain:${trade.transactionHash}:${trade.logIndex}:taker`,
      txHash: trade.transactionHash,
      asset: tokenId,
      tradeType: 'TRADE',
      role: 'taker',
      feeAmount: 0,
      orderHash: trade.orderHash,
      counterparty: trade.maker,
    });
  }

  return { rows, unmapped };
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const chunkArg = parseInt(process.argv.find(a => a.startsWith('--chunk='))?.split('=')[1] || '0');
  const fromBlockArg = parseInt(process.argv.find(a => a.startsWith('--from-block='))?.split('=')[1] || '0');
  const backfill = process.argv.includes('--backfill');
  const chunkSize = chunkArg > 0 ? chunkArg : DEFAULT_CHUNK;

  // Load token → market mapping
  await loadTokenMap();

  // Determine start block
  let startBlock: number;
  if (fromBlockArg > 0) {
    startBlock = fromBlockArg;
  } else if (backfill) {
    startBlock = POLYMARKET_START_BLOCK;
  } else {
    const checkpoint = await getCheckpoint();
    startBlock = checkpoint ? checkpoint + 1 : POLYMARKET_START_BLOCK;
  }

  const latestBlock = await getLatestBlock();

  console.log(`\n=== Polymarket On-Chain Trade Scanner ===`);
  console.log(`  RPC:              ${RPC_URL.replace(/\/\/.*@/, '//***@').slice(0, 60)}...`);
  console.log(`  Contracts:        CTF Exchange + NegRisk CTF Exchange`);
  console.log(`  Start block:      ${startBlock}`);
  console.log(`  Latest block:     ${latestBlock}`);
  console.log(`  Blocks to scan:   ${latestBlock - startBlock}`);
  console.log(`  Chunk size:       ${chunkSize} blocks`);
  console.log(`  Token mappings:   ${tokenMap.size}`);
  console.log('');

  if (startBlock >= latestBlock) {
    console.log('Already up to date.');
    await shutdown();
    return;
  }

  await saveCheckpoint(startBlock, 0, 'running');

  let totalEvents = 0;
  let totalRows = 0;
  let totalUnmapped = 0;
  let currentBlock = startBlock;
  const scanStart = Date.now();

  while (currentBlock < latestBlock) {
    const chunkEnd = Math.min(currentBlock + chunkSize - 1, latestBlock);

    try {
      const events = await fetchEvents(currentBlock, chunkEnd);
      totalEvents += events.length;

      if (events.length > 0) {
        const { rows, unmapped } = await processChunk(events);
        const inserted = await insertBatch(rows);
        totalRows += inserted;
        totalUnmapped += unmapped;
      }

      currentBlock = chunkEnd + 1;

      // Save checkpoint every chunk
      await saveCheckpoint(chunkEnd, totalRows, 'running');

      // Log progress
      const progress = ((currentBlock - startBlock) / (latestBlock - startBlock) * 100).toFixed(1);
      const elapsed = ((Date.now() - scanStart) / 1000).toFixed(0);
      const blocksLeft = latestBlock - currentBlock;
      const blocksPerSec = (currentBlock - startBlock) / Math.max(1, (Date.now() - scanStart) / 1000);
      const etaMin = blocksPerSec > 0 ? (blocksLeft / blocksPerSec / 60).toFixed(1) : '?';

      if (events.length > 0 || (currentBlock - startBlock) % (chunkSize * 10) === 0) {
        log.info({
          block: `${currentBlock}/${latestBlock}`,
          progress: `${progress}%`,
          events: events.length,
          totalEvents,
          totalRows,
          unmapped: totalUnmapped,
          elapsed: `${elapsed}s`,
          eta: `${etaMin}min`,
        }, 'Chunk processed');
      }
    } catch (err) {
      log.error({ block: currentBlock, err: (err as Error).message }, 'Chunk failed');
      await saveCheckpoint(currentBlock - 1, totalRows, 'error', (err as Error).message);
      // Wait and retry
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  await saveCheckpoint(latestBlock, totalRows, 'idle');

  const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
  console.log(`\n=== On-Chain Trade Scan Complete ===`);
  console.log(`  Blocks scanned:    ${latestBlock - startBlock}`);
  console.log(`  Events found:      ${totalEvents}`);
  console.log(`  Trade rows:        ${totalRows}`);
  console.log(`  Unmapped tokens:   ${totalUnmapped} (will be linked after next events scan)`);
  console.log(`  Elapsed:           ${elapsed}s`);

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
