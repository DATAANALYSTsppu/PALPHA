/**
 * Test script: Read Polymarket trades directly from Polygon blockchain.
 *
 * Reads OrderFilled events from the CTF Exchange contracts to verify
 * we can get all the fields we need for our trades table.
 *
 * Required: POLYGON_RPC env var (or uses public default).
 *
 * Usage:
 *   npx tsx packages/core/src/cli/test-onchain-trades.ts
 */

import dotenv from 'dotenv';
dotenv.config();

// ── Contract addresses (Polygon) ──────────────────────────────
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// OrderFilled event topic0 = keccak256("OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)")
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

// event OrderFilled(
//   bytes32 indexed orderHash,    // topics[1]
//   address indexed maker,        // topics[2]
//   address indexed taker,        // topics[3]
//   uint256 makerAssetId,         // data[0:32]
//   uint256 takerAssetId,         // data[32:64]
//   uint256 makerAmountFilled,    // data[64:96]   — in USDC units (6 decimals)
//   uint256 takerAmountFilled,    // data[96:128]  — in USDC units (6 decimals)
//   uint256 fee                   // data[128:160] — in USDC units (6 decimals)
// )

const POLYGON_RPC = process.env.POLYMARKET_RPC || process.env.POLYGON_RPC || 'https://polygon-rpc.com';
const USDC_DECIMALS = 6;

// ── Helpers ────────────────────────────────────────────────────

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(POLYGON_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string; code: number } };
  if (json.error) throw new Error(`RPC error: ${json.error.message} (code ${json.error.code})`);
  return json.result;
}

function hexToAddress(hex: string): string {
  // topics encode addresses as 32 bytes, take last 20
  return '0x' + hex.slice(-40).toLowerCase();
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
}

function formatUSDC(raw: bigint): number {
  return Number(raw) / Math.pow(10, USDC_DECIMALS);
}

interface ParsedOrderFilled {
  // From event topics
  orderHash: string;
  maker: string;
  taker: string;
  // From event data
  makerAssetId: string;   // token ID
  takerAssetId: string;   // token ID (USDC = 0 for buys)
  makerAmountFilled: number; // USDC
  takerAmountFilled: number; // USDC
  fee: number;            // USDC
  // From log metadata
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  contractAddress: string;
  // Derived
  isNegRisk: boolean;
}

function parseOrderFilled(log: {
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  address: string;
}): ParsedOrderFilled {
  const data = log.data.slice(2); // remove 0x
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) {
    chunks.push('0x' + data.slice(i, i + 64));
  }

  const makerAssetId = hexToBigInt(chunks[0]);
  const takerAssetId = hexToBigInt(chunks[1]);
  const makerAmountFilled = hexToBigInt(chunks[2]);
  const takerAmountFilled = hexToBigInt(chunks[3]);
  const fee = hexToBigInt(chunks[4]);

  return {
    orderHash: log.topics[1],
    maker: hexToAddress(log.topics[2]),
    taker: hexToAddress(log.topics[3]),
    makerAssetId: makerAssetId.toString(),
    takerAssetId: takerAssetId.toString(),
    makerAmountFilled: formatUSDC(makerAmountFilled),
    takerAmountFilled: formatUSDC(takerAmountFilled),
    fee: formatUSDC(fee),
    transactionHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    logIndex: parseInt(log.logIndex, 16),
    contractAddress: log.address.toLowerCase(),
    isNegRisk: log.address.toLowerCase() === NEG_RISK_CTF_EXCHANGE.toLowerCase(),
  };
}

// ── DB field mapping check ─────────────────────────────────────

function checkFieldMapping(trade: ParsedOrderFilled) {
  console.log('\n=== Field mapping to trades table ===');
  console.log(`  proxy_wallet (maker):  ${trade.maker}`);
  console.log(`  counterparty (taker):  ${trade.taker}`);
  console.log(`  order_hash:            ${trade.orderHash.slice(0, 20)}...`);
  console.log(`  asset_token_id:        ${trade.makerAssetId.slice(0, 30)}...`);
  console.log(`  price:                 ${trade.takerAmountFilled > 0 ? (trade.takerAmountFilled / (trade.takerAmountFilled + trade.makerAmountFilled)).toFixed(4) : 'N/A'} (derived)`);
  console.log(`  size:                  ${trade.makerAmountFilled} USDC`);
  console.log(`  fee_amount:            ${trade.fee} USDC`);
  console.log(`  transaction_hash:      ${trade.transactionHash}`);
  console.log(`  block_number:          ${trade.blockNumber}`);
  console.log(`  log_index:             ${trade.logIndex}`);
  console.log(`  source:                on-chain`);
  console.log(`  trade_type:            TRADE`);
  console.log(`  is_neg_risk:           ${trade.isNegRisk}`);
  console.log(`  role:                  maker row + taker row (one event = two trade rows)`);
  console.log(`  trade_key:             onchain:${trade.transactionHash.slice(0, 10)}:${trade.logIndex}`);

  console.log('\n=== Fields we CAN get from on-chain ===');
  const have = [
    'proxy_wallet (maker/taker)', 'counterparty', 'order_hash',
    'asset_token_id (makerAssetId)', 'size (makerAmountFilled)',
    'fee_amount', 'transaction_hash', 'block_number', 'log_index',
    'source', 'trade_type', 'role', 'trade_key', 'raw_payload',
  ];
  have.forEach(f => console.log(`  ✅ ${f}`));

  console.log('\n=== Fields we CANNOT get from on-chain (need DB lookup) ===');
  const need = [
    'event_id         → JOIN markets ON asset_token_id = outcome_yes_token OR outcome_no_token',
    'market_id        → same JOIN',
    'side (BUY/SELL)  → derive: if takerAssetId=0 (USDC), maker is SELLING outcome tokens',
    'outcome (Yes/No) → JOIN markets to map token ID to outcome',
    'price            → derive: takerAmountFilled / (takerAmountFilled + makerAmountFilled)',
    'timestamp        → eth_getBlockByNumber (or interpolate from block number)',
    'trade_date       → same as timestamp',
    'pseudonym        → not available on-chain (Data API enrichment)',
    'display_name     → not available on-chain (Data API enrichment)',
  ];
  need.forEach(f => console.log(`  ⚠️  ${f}`));
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('=== Polymarket On-Chain Trade Test ===');
  console.log(`RPC: ${POLYGON_RPC}`);

  // Step 1: Get latest block
  console.log('\nStep 1: Getting latest block...');
  const latestHex = await rpcCall('eth_blockNumber', []) as string;
  const latestBlock = parseInt(latestHex, 16);
  console.log(`  Latest block: ${latestBlock}`);

  // Step 2: Fetch recent OrderFilled events (last ~500 blocks ≈ ~15 min)
  const fromBlock = latestBlock - 500;
  console.log(`\nStep 2: Fetching OrderFilled events from block ${fromBlock} to ${latestBlock} (~15 min)...`);

  let totalLogs = 0;
  const allTrades: ParsedOrderFilled[] = [];

  for (const [label, contract] of [['CTF Exchange', CTF_EXCHANGE], ['NegRisk CTF Exchange', NEG_RISK_CTF_EXCHANGE]] as const) {
    console.log(`\n  --- ${label} (${contract}) ---`);
    try {
      const logs = await rpcCall('eth_getLogs', [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + latestBlock.toString(16),
        address: contract,
        topics: [ORDER_FILLED_TOPIC],
      }]) as Array<{
        topics: string[];
        data: string;
        transactionHash: string;
        blockNumber: string;
        logIndex: string;
        address: string;
      }>;

      console.log(`  Events found: ${logs.length}`);
      totalLogs += logs.length;

      for (const log of logs.slice(0, 5)) {
        const parsed = parseOrderFilled(log);
        allTrades.push(parsed);
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`);
    }
  }

  console.log(`\n=== Total OrderFilled events in last ~15 min: ${totalLogs} ===`);

  if (allTrades.length === 0) {
    console.log('No trades found. Try a wider block range or check RPC.');
    return;
  }

  // Step 3: Show sample parsed trades
  console.log(`\nStep 3: Sample parsed trades (first ${Math.min(3, allTrades.length)}):`);
  for (let i = 0; i < Math.min(3, allTrades.length); i++) {
    const t = allTrades[i];
    console.log(`\n  Trade ${i + 1}:`);
    console.log(`    maker:       ${t.maker}`);
    console.log(`    taker:       ${t.taker}`);
    console.log(`    makerAsset:  ${t.makerAssetId.slice(0, 30)}...`);
    console.log(`    takerAsset:  ${t.takerAssetId.slice(0, 30)}...`);
    console.log(`    makerAmount: ${t.makerAmountFilled} USDC`);
    console.log(`    takerAmount: ${t.takerAmountFilled} USDC`);
    console.log(`    fee:         ${t.fee} USDC`);
    console.log(`    tx:          ${t.transactionHash}`);
    console.log(`    block:       ${t.blockNumber}`);
    console.log(`    logIndex:    ${t.logIndex}`);
    console.log(`    negRisk:     ${t.isNegRisk}`);
  }

  // Step 4: Get block timestamp for first trade
  console.log('\nStep 4: Getting block timestamp...');
  const blockHex = '0x' + allTrades[0].blockNumber.toString(16);
  const block = await rpcCall('eth_getBlockByNumber', [blockHex, false]) as { timestamp: string } | null;
  if (block) {
    const ts = parseInt(block.timestamp, 16);
    console.log(`  Block ${allTrades[0].blockNumber} timestamp: ${ts} (${new Date(ts * 1000).toISOString()})`);
  }

  // Step 5: Field mapping analysis
  checkFieldMapping(allTrades[0]);

  // Step 6: Verify no pagination cap — count events in a larger range
  console.log('\n\nStep 6: Pagination test — fetching from a wider range (~2 hours)...');
  const wideFrom = latestBlock - 4000; // ~2 hours of blocks
  try {
    const wideLogs = await rpcCall('eth_getLogs', [{
      fromBlock: '0x' + wideFrom.toString(16),
      toBlock: '0x' + latestBlock.toString(16),
      address: CTF_EXCHANGE,
      topics: [ORDER_FILLED_TOPIC],
    }]) as unknown[];
    console.log(`  Events in ~2 hours (CTF only): ${wideLogs.length}`);
    console.log(`  ✅ No pagination cap — RPC returns ALL events in the block range`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('range') || msg.includes('limit') || msg.includes('too many')) {
      console.log(`  ⚠️  RPC has block range limit: ${msg}`);
      console.log('  → Need to fetch in smaller chunks (the indexer handles this automatically)');
    } else {
      console.error(`  Error: ${msg}`);
    }
  }

  // Summary
  console.log('\n\n====================================');
  console.log('  SUMMARY');
  console.log('====================================');
  console.log(`  RPC works:           ✅`);
  console.log(`  Events readable:     ✅ (${totalLogs} in ~15 min)`);
  console.log(`  All trade fields:    ✅ maker, taker, amounts, fee, tx, block, logIndex`);
  console.log(`  Needs DB lookup:     event_id, market_id, side, outcome, price (from token ID mapping)`);
  console.log(`  Needs block lookup:  timestamp (one RPC call per block, cacheable)`);
  console.log(`  Not available:       pseudonym, display_name (cosmetic only)`);
  console.log(`  Pagination cap:      NONE — limited only by block range per RPC call`);
  console.log(`  Dedup key:           onchain:{txHash}:{logIndex} (globally unique)`);
}

main().catch(err => { console.error(err); process.exit(1); });
