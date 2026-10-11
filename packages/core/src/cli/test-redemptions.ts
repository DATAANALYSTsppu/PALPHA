/**
 * Test script: Verify we can read PayoutRedemption, PositionSplit, PositionsMerge
 * events from the Conditional Tokens Framework contract on Polygon.
 *
 * Usage:
 *   npx tsx packages/core/src/cli/test-redemptions.ts
 */

import { config } from '../config.js';

const RPC_URL = config.polygon.rpcUrl;

// Conditional Tokens Framework contract (redemptions, splits, merges)
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Event topic0 hashes
const PAYOUT_REDEMPTION_TOPIC = '0x2682012a4a4f1973119f1c9b90745d1bd91fa2bab387344f044cb3586864d18d';
const POSITION_SPLIT_TOPIC = '0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298';
const POSITIONS_MERGE_TOPIC = '0x6f13ca62553fcc2bcd2372180a43949c1e4cebba603901ede2f4e14f36b282ca';

const USDC_DECIMALS = 6;

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

function hexToAddress(hex: string): string {
  return '0x' + hex.slice(-40).toLowerCase();
}

function formatUSDC(hex: string): number {
  return Number(BigInt(hex)) / Math.pow(10, USDC_DECIMALS);
}

interface RawLog {
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  address: string;
}

function getEventType(topic0: string): string {
  if (topic0 === PAYOUT_REDEMPTION_TOPIC) return 'PayoutRedemption';
  if (topic0 === POSITION_SPLIT_TOPIC) return 'PositionSplit';
  if (topic0 === POSITIONS_MERGE_TOPIC) return 'PositionsMerge';
  return 'Unknown';
}

function parseRedemption(log: RawLog) {
  // Indexed: redeemer (topic1), collateralToken (topic2), parentCollectionId (topic3)
  // Data: conditionId (bytes32), offset to indexSets, payout (uint256), indexSets length, indexSets elements
  const data = log.data.slice(2);
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 64) {
    chunks.push('0x' + data.slice(i, i + 64));
  }

  return {
    type: 'REDEEM',
    redeemer: hexToAddress(log.topics[1]),
    collateralToken: hexToAddress(log.topics[2]),
    conditionId: chunks[0],
    payout: formatUSDC(chunks[2]),
    txHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    dataChunks: chunks.length,
    rawChunks: chunks,
  };
}

function parseSplitOrMerge(log: RawLog, type: 'SPLIT' | 'MERGE') {
  // Indexed: stakeholder (topic1), parentCollectionId (topic2), conditionId (topic3)
  // Data: collateralToken (address), offset to partition, amount (uint256), partition length, partition elements
  const data = log.data.slice(2);
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 64) {
    chunks.push('0x' + data.slice(i, i + 64));
  }

  return {
    type,
    stakeholder: hexToAddress(log.topics[1]),
    conditionId: log.topics[3],
    collateralToken: hexToAddress(chunks[0]),
    amount: formatUSDC(chunks[2]),
    txHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    dataChunks: chunks.length,
    rawChunks: chunks,
  };
}

async function main() {
  console.log('=== Polymarket Redemption Events Test ===');
  console.log(`RPC: ${RPC_URL.slice(0, 40)}...`);
  console.log(`CTF Contract: ${CTF_CONTRACT}`);

  // Get latest block
  const latestHex = await rpcCall('eth_blockNumber', []) as string;
  const latestBlock = parseInt(latestHex, 16);
  console.log(`Latest block: ${latestBlock}`);

  // Fetch last ~1000 blocks for each event type
  const fromBlock = latestBlock - 1000;
  console.log(`Scanning blocks ${fromBlock} → ${latestBlock} (~30 min)\n`);

  for (const [name, topic] of [
    ['PayoutRedemption', PAYOUT_REDEMPTION_TOPIC],
    ['PositionSplit', POSITION_SPLIT_TOPIC],
    ['PositionsMerge', POSITIONS_MERGE_TOPIC],
  ] as const) {
    console.log(`--- ${name} ---`);
    try {
      const logs = await rpcCall('eth_getLogs', [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + latestBlock.toString(16),
        address: CTF_CONTRACT,
        topics: [topic],
      }]) as RawLog[];

      console.log(`  Events found: ${logs.length}`);

      if (logs.length > 0) {
        const sample = logs[0];
        console.log(`  Sample event:`);
        console.log(`    tx: ${sample.transactionHash}`);
        console.log(`    topics: ${sample.topics.length}`);
        console.log(`    data length: ${(sample.data.length - 2) / 64} words`);

        if (name === 'PayoutRedemption') {
          const parsed = parseRedemption(sample);
          console.log(`    Parsed:`);
          console.log(`      redeemer: ${parsed.redeemer}`);
          console.log(`      collateralToken: ${parsed.collateralToken}`);
          console.log(`      conditionId: ${parsed.conditionId?.slice(0, 20)}...`);
          console.log(`      payout: ${parsed.payout} USDC`);
        } else {
          const type = name === 'PositionSplit' ? 'SPLIT' : 'MERGE';
          const parsed = parseSplitOrMerge(sample, type as 'SPLIT' | 'MERGE');
          console.log(`    Parsed:`);
          console.log(`      stakeholder: ${parsed.stakeholder}`);
          console.log(`      conditionId: ${parsed.conditionId?.slice(0, 20)}...`);
          console.log(`      collateralToken: ${parsed.collateralToken}`);
          console.log(`      amount: ${parsed.amount} USDC`);
        }
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`);
    }
    console.log('');
  }

  // Combined: fetch all three event types in one query
  console.log('--- Combined query (all 3 types) ---');
  try {
    const logs = await rpcCall('eth_getLogs', [{
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + latestBlock.toString(16),
      address: CTF_CONTRACT,
      topics: [[PAYOUT_REDEMPTION_TOPIC, POSITION_SPLIT_TOPIC, POSITIONS_MERGE_TOPIC]],
    }]) as RawLog[];

    const counts = { PayoutRedemption: 0, PositionSplit: 0, PositionsMerge: 0, Unknown: 0 };
    for (const log of logs) {
      const type = getEventType(log.topics[0]);
      counts[type as keyof typeof counts]++;
    }

    console.log(`  Total events: ${logs.length}`);
    console.log(`  PayoutRedemption: ${counts.PayoutRedemption}`);
    console.log(`  PositionSplit: ${counts.PositionSplit}`);
    console.log(`  PositionsMerge: ${counts.PositionsMerge}`);
    console.log(`  Unknown: ${counts.Unknown}`);
  } catch (err) {
    console.error(`  Error: ${(err as Error).message}`);
  }

  console.log('\n=== Field Mapping to trades table ===');
  console.log('  PayoutRedemption:');
  console.log('    proxy_wallet  ← redeemer (topic1)');
  console.log('    trade_type    ← REDEEM');
  console.log('    size/price    ← payout (data)');
  console.log('    condition_id  ← conditionId (data) → JOIN markets');
  console.log('    trade_key     ← onchain:{txHash}:{logIndex}:redeem');
  console.log('  PositionSplit:');
  console.log('    proxy_wallet  ← stakeholder (topic1)');
  console.log('    trade_type    ← SPLIT');
  console.log('    size          ← amount (data)');
  console.log('    condition_id  ← conditionId (topic3) → JOIN markets');
  console.log('  PositionsMerge:');
  console.log('    proxy_wallet  ← stakeholder (topic1)');
  console.log('    trade_type    ← MERGE');
  console.log('    size          ← amount (data)');
  console.log('    condition_id  ← conditionId (topic3) → JOIN markets');
}

main().catch(err => { console.error(err); process.exit(1); });
