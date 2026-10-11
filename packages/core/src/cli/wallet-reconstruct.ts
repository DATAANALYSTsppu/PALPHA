/**
 * wallet-reconstruct — compute a wallet's lifetime cash flow from raw chain
 * events, working around Polymarket's quirks.
 *
 * Why this exists:
 *   The trader-scorer can't get correct PnL because Polymarket's matching
 *   engine emits PositionSplit / PositionsMerge events with the **operator
 *   contract** as `stakeholder`, not the user wallet. Standard event filters
 *   by user therefore miss most splits/merges. Our manually-confirmed
 *   evidence is a SPLIT and MERGE tx for wallet 0x6ffb4354..., where the
 *   user wallet only appears in:
 *
 *     1. USDC Transfer (in/out)
 *     2. NegRiskShares contract (0xada20056…) — emits a "Wrapped" event
 *        (split equivalent) and "Unwrapped" event (merge equivalent) with
 *        the wallet as topic1.
 *     3. Standard OrderFilled (CTF + NegRisk CTF Exchange) where wallet is
 *        maker (topic2) or taker (topic3).
 *     4. Standard PayoutRedemption where wallet is redeemer (topic1).
 *
 * This script pulls every such event for one wallet via eth_getLogs and
 * prints a cash-flow summary. The total USDC delta is the closest thing to
 * Polymarket's "Total PNL" we can compute without their internal indexing.
 *
 * Usage:
 *   tsx packages/core/src/cli/wallet-reconstruct.ts 0x6ffb4354cbe6e0f9989e3b55564ec5fb8646a834
 */

import { config } from '../config.js';
import { request as undiciRequest } from 'undici';
import * as fs from 'fs';
import * as path from 'path';
import { utils as ethersUtils } from 'ethers';

void config;

// ─── Contract addresses (Polygon) ────────────────────────────────────

const USDC = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
// NegRiskShares (NegRisk operator's wrapped-position contract). Position
// events here use the wallet as topic1, so we can attribute them cleanly.
const NEG_RISK_SHARES = '0xada2005600dec949baf300f4c6120000bdb6eaab';

// ─── Topic0 hashes ───────────────────────────────────────────────────

const ERC20_TRANSFER_TOPIC      = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ORDER_FILLED_TOPIC        = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const PAYOUT_REDEMPTION_TOPIC   = '0x2682012a4a4f1973119f1c9b90745d1bd91fa2bab387344f044cb3586864d18d';

// NegRiskAdapter event signatures.
//
// The repo (github.com/Polymarket/neg-risk-ctf-adapter) documents simpler
// signatures like `PositionSplit(address,bytes32,uint256)`, but those don't
// match the keccak256 of what's actually emitted on chain. The deployed
// contract uses different signatures than the open-source draft, so we use
// on-chain-verified hashes for the two events we've physically confirmed
// (Wrap/Unwrap, from real tx receipts) and compute the other two from
// documented signatures as best-effort. If they don't match the real on-chain
// hash, the relevant getLogs filter will silently return 0 events — and we'll
// see that in the report and need to fetch the right hash from a real receipt.

// VERIFIED on-chain (from real tx receipts).
const NEGRISK_WRAP_TOPIC       = '0xbbed930dbfb7907ae2d60ddf78345610214f26419a0128df39b6cc3d9e5df9b0';
const NEGRISK_UNWRAP_TOPIC     = '0x08c15f31e413dbd9bbd3b4c01b191db840e1657ab4f8d1d7d448a9a5083ba255';

// BEST-EFFORT — computed from the repo's documented signatures. May be wrong;
// if so, the report will show `nrRedeem`/`nrConvert` counts of zero and we
// need to find a real tx that fires these events to extract the true hash.
const NEGRISK_REDEEM_TOPIC     = ethersUtils.id('PayoutRedemption(address,bytes32,uint256[],uint256)');
const NEGRISK_CONVERT_TOPIC    = ethersUtils.id('PositionsConverted(address,bytes32,uint256,uint256)');
console.log(`  (nrRedeem  topic = ${NEGRISK_REDEEM_TOPIC} — computed from signature, unverified)`);
console.log(`  (nrConvert topic = ${NEGRISK_CONVERT_TOPIC} — computed from signature, unverified)`);

// Polygon block where Polymarket activity starts. Tighten per wallet if
// you know the wallet's creation block — saves RPC calls.
const POLYMARKET_START_BLOCK = 60_000_000;

// ─── RPC plumbing ────────────────────────────────────────────────────

const RPC_URL = config.polygon.rpcUrl;
const UA = 'palpha-wallet-reconstruct/1.0';

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  // Hard timeout so a hung RPC doesn't freeze us silently.
  const res = await undiciRequest(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    bodyTimeout: 30_000,
    headersTimeout: 30_000,
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`RPC ${method}: HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
  }
  const json = (await res.body.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`RPC ${method}: no result`);
  return json.result as T;
}

interface RawLog {
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  address: string;
  topics: string[];
  data: string;
}

/** Chunked log fetcher. Walks `fromBlock → toBlock` in fixed-size windows
 *  (default 1M blocks) and prints a progress bar after each window. If a
 *  window itself is too large for the provider, recursively halves it.
 *
 *  Why not just "ask for the full range, recursive split on error"? Some RPCs
 *  silently hang on huge ranges instead of returning an error, which we
 *  experienced. Forcing small windows up front guarantees forward progress
 *  and lets the user see life. */
async function fetchLogsChunked(
  label: string,
  address: string,
  topics: (string | null)[],
  fromBlock: number,
  toBlock: number,
  initialChunk = 10_000,   // QuickNode default cap is ~10k blocks per call
): Promise<RawLog[]> {
  const all: RawLog[] = [];
  const totalBlocks = toBlock - fromBlock + 1;
  let cursor = fromBlock;
  let windowSize = initialChunk;
  let lastPrintedPct = -1;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + windowSize - 1, toBlock);
    try {
      const logs = await rpc<RawLog[]>('eth_getLogs', [
        {
          address,
          topics,
          fromBlock: '0x' + cursor.toString(16),
          toBlock: '0x' + end.toString(16),
        },
      ]);
      all.push(...logs);
      // Throttle progress prints to once per integer % to avoid noise.
      const pct = Math.floor(((end - fromBlock + 1) / totalBlocks) * 100);
      if (pct > lastPrintedPct) {
        lastPrintedPct = pct;
        process.stdout.write(`\r    [${label}] ${pct}% — ${all.length} events    `);
      }
      cursor = end + 1;
      // DO NOT auto-grow window. Once we found a size the RPC accepts, stick
      // with it. Auto-grow caused a bouncing pattern (1M rejected → 7k
      // accepted → 1M rejected …) that wasted seconds on every iteration.
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg.includes('range') ||
        msg.includes('more than') ||
        msg.includes('limit') ||
        msg.includes('exceed') ||
        msg.includes('block range') ||
        msg.includes('timeout') ||
        msg.includes('Headers Timeout')
      ) {
        windowSize = Math.max(1, Math.floor(windowSize / 2));
        process.stdout.write(`\n    [${label}] window too large, shrinking to ${windowSize.toLocaleString()} blocks\n`);
      } else {
        throw err;
      }
    }
  }
  process.stdout.write('\n');
  return all;
}

function padTopic(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** uint256 in the `data` field, last 32 bytes. USDC has 6 decimals. */
function decodeUsdcAmount(dataHex: string): number {
  const raw = dataHex.replace(/^0x/, '');
  if (raw.length < 64) return 0;
  const lastWord = raw.slice(-64);
  return Number(BigInt('0x' + lastWord)) / 1_000_000;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const wallet = args.find(a => /^0x[a-fA-F0-9]{40}$/.test(a));
  if (!wallet) {
    console.error('Usage: wallet-reconstruct <0xWalletAddress> [--from-block=N] [--chunk=N]');
    console.error('  --from-block=N  start block (default 82000000 ≈ early Apr 2026)');
    console.error('  --chunk=N       initial block window per RPC call (default 10000)');
    process.exit(1);
  }
  const walletLc = wallet.toLowerCase();
  const walletPad = padTopic(walletLc);

  const fromBlockArg = args.find(a => a.startsWith('--from-block='));
  const chunkArg     = args.find(a => a.startsWith('--chunk='));
  const fromBlock = fromBlockArg ? parseInt(fromBlockArg.split('=')[1]) : 82_000_000;
  const initialChunk = chunkArg  ? parseInt(chunkArg.split('=')[1])     : 10_000;

  const latestBlockHex = await rpc<string>('eth_blockNumber', []);
  const latest = parseInt(latestBlockHex, 16);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  WALLET RECONSTRUCT: ${walletLc}`);
  console.log(`  Block range:        ${fromBlock} → ${latest}  (${latest - fromBlock} blocks)`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Skip USDC by default — scanning every USDC transfer across 27M blocks is
  // huge and unnecessary, because every Polymarket cash flow shows up in
  // these protocol-specific events with the USDC amount embedded in data.
  // Set INCLUDE_USDC=1 to add it back for cross-checking.
  const includeUsdc = process.env.INCLUDE_USDC === '1';
  const taskDefs: Array<[string, { address: string; topics: (string | null)[] }]> = [
    ['redemption',   { address: CTF_CONTRACT,          topics: [PAYOUT_REDEMPTION_TOPIC, walletPad] }],
    ['orderMaker',   { address: CTF_EXCHANGE,          topics: [ORDER_FILLED_TOPIC, null, walletPad] }],
    ['orderTaker',   { address: CTF_EXCHANGE,          topics: [ORDER_FILLED_TOPIC, null, null, walletPad] }],
    ['nrOrderMaker', { address: NEG_RISK_CTF_EXCHANGE, topics: [ORDER_FILLED_TOPIC, null, walletPad] }],
    ['nrOrderTaker', { address: NEG_RISK_CTF_EXCHANGE, topics: [ORDER_FILLED_TOPIC, null, null, walletPad] }],
    ['nrWrap',       { address: NEG_RISK_SHARES,       topics: [NEGRISK_WRAP_TOPIC, walletPad] }],
    ['nrUnwrap',     { address: NEG_RISK_SHARES,       topics: [NEGRISK_UNWRAP_TOPIC, walletPad] }],
    // NegRiskAdapter's own PayoutRedemption (distinct from CTF's). Most
    // modern Polymarket redemptions flow through here.
    ['nrRedeem',     { address: NEG_RISK_SHARES,       topics: [NEGRISK_REDEEM_TOPIC, walletPad] }],
    // NegRisk-only operation: convert a held position to the opposite outcome
    // + USDC. Significant cash-flow contributor for active multi-outcome traders.
    ['nrConvert',    { address: NEG_RISK_SHARES,       topics: [NEGRISK_CONVERT_TOPIC, walletPad] }],
  ];
  if (includeUsdc) {
    taskDefs.unshift(['usdcIn',  { address: USDC, topics: [ERC20_TRANSFER_TOPIC, null,      walletPad] }]);
    taskDefs.unshift(['usdcOut', { address: USDC, topics: [ERC20_TRANSFER_TOPIC, walletPad, null] }]);
  }

  // Cache fetched events to disk so we can iterate the decoder without
  // re-fetching. ~4 hours per full scan is a lot to repeat. Key the cache on
  // (wallet, fromBlock, latest) so an extended date range doesn't reuse stale.
  const cacheDir = '/tmp/wallet-reconstruct-cache';
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${walletLc}-${fromBlock}-${latest}.json`);
  const useCache = !process.argv.includes('--no-cache');

  let events: Record<string, RawLog[]>;
  if (useCache && fs.existsSync(cachePath)) {
    console.log(`Loading cached events from ${cachePath}`);
    events = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, RawLog[]>;
    console.log(`  ✓ loaded ${Object.values(events).reduce((s, a) => s + a.length, 0)} events\n`);
  } else {
    console.log(`Fetching ${taskDefs.length} event classes. Initial chunk: ${initialChunk.toLocaleString()} blocks.\n`);
    const t0 = Date.now();
    events = {};
    for (const [label, f] of taskDefs) {
      const start = Date.now();
      console.log(`  → ${label}:`);
      events[label] = await fetchLogsChunked(label, f.address, f.topics, fromBlock, latest, initialChunk);
      const ms = Date.now() - start;
      console.log(`    [${label}] ✓ ${events[label].length} events in ${(ms / 1000).toFixed(1)}s\n`);
    }
    console.log(`  ✓ all event classes fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    fs.writeFileSync(cachePath, JSON.stringify(events));
    console.log(`  ✓ cached to ${cachePath} for fast re-runs (use --no-cache to refetch)\n`);
  }

  // ─── Decoders ──────────────────────────────────────────────────────
  //
  // OrderFilled (CTF Exchange + NegRisk CTF Exchange):
  //   non-indexed data words = [makerAssetId, takerAssetId, makerAmount,
  //                             takerAmount, fee]
  //   makerAssetId == 0 means maker is paying USDC. The non-USDC side gives
  //   shares. Cash flow is therefore:
  //     wallet=maker, makerIsUsdc=true:  paid USDC      → out = makerAmount
  //     wallet=maker, makerIsUsdc=false: received USDC  → in  = takerAmount
  //     wallet=taker, makerIsUsdc=true:  received USDC  → in  = makerAmount
  //     wallet=taker, makerIsUsdc=false: paid USDC      → out = takerAmount
  //
  //   Earlier version of this function had the taker direction backwards,
  //   which produced a $6M phantom loss on real ~$8K wallets.
  function decodeOrderFilled(log: RawLog, walletRole: 'maker' | 'taker'): { usdcIn: number; usdcOut: number } {
    const raw = log.data.replace(/^0x/, '');
    if (raw.length < 64 * 5) return { usdcIn: 0, usdcOut: 0 };
    const makerAssetId = BigInt('0x' + raw.slice(0, 64));
    const makerAmount  = Number(BigInt('0x' + raw.slice(128, 192))) / 1_000_000;
    const takerAmount  = Number(BigInt('0x' + raw.slice(192, 256))) / 1_000_000;
    const makerIsUsdc = makerAssetId === 0n;
    if (walletRole === 'maker') {
      return makerIsUsdc
        ? { usdcIn: 0,           usdcOut: makerAmount } // bought shares
        : { usdcIn: takerAmount, usdcOut: 0          }; // sold shares
    } else {
      return makerIsUsdc
        ? { usdcIn: makerAmount, usdcOut: 0          } // sold shares (got USDC the maker offered)
        : { usdcIn: 0,           usdcOut: takerAmount }; // bought shares
    }
  }

  // PayoutRedemption non-indexed args (in order): conditionId, indexSets[], payout
  // ABI encoding head: [conditionId, offset_to_indexSets, payout]
  // So payout is at chunks[2] — NOT the tail word (tail is an array element).
  function decodePayoutRedemption(log: RawLog): number {
    const raw = log.data.replace(/^0x/, '');
    if (raw.length < 64 * 3) return 0;
    return Number(BigInt('0x' + raw.slice(128, 192))) / 1_000_000;
  }

  // NegRiskAdapter PositionSplit / PositionsMerge:
  //   event signature is (address stakeholder, bytes32 conditionId, uint256 amount)
  //   indexed: stakeholder (topic1), conditionId (topic2)
  //   non-indexed data: amount (single uint256 at chunks[0])
  function decodeNegRiskAmount(log: RawLog): number {
    const raw = log.data.replace(/^0x/, '');
    if (raw.length < 64) return 0;
    return Number(BigInt('0x' + raw.slice(0, 64))) / 1_000_000;
  }

  // NegRiskAdapter PayoutRedemption(address redeemer, bytes32 conditionId,
  //                                 uint256[] amounts, uint256 payout)
  // indexed: redeemer, conditionId
  // non-indexed: amounts[] (dynamic array), payout
  // ABI encoding: [offset_to_amounts, payout, length, ...elements]
  // payout is at chunks[1].
  function decodeNegRiskRedeem(log: RawLog): number {
    const raw = log.data.replace(/^0x/, '');
    if (raw.length < 64 * 2) return 0;
    return Number(BigInt('0x' + raw.slice(64, 128))) / 1_000_000;
  }

  // NegRiskAdapter PositionsConverted(address stakeholder, bytes32 marketId,
  //                                   uint256 indexSet, uint256 amount)
  // indexed: stakeholder, marketId, indexSet
  // non-indexed: amount (single uint256 at chunks[0])
  // A "convert" turns a held NO position into the opposite outcome + USDC,
  // so it's effectively a partial cash-out — the user receives USDC.
  function decodeNegRiskConvert(log: RawLog): number {
    const raw = log.data.replace(/^0x/, '');
    if (raw.length < 64) return 0;
    return Number(BigInt('0x' + raw.slice(0, 64))) / 1_000_000;
  }

  const orderMakerFlow  = events.orderMaker.reduce ((acc, l) => { const f = decodeOrderFilled(l, 'maker'); acc.in += f.usdcIn; acc.out += f.usdcOut; return acc; }, { in: 0, out: 0 });
  const orderTakerFlow  = events.orderTaker.reduce ((acc, l) => { const f = decodeOrderFilled(l, 'taker'); acc.in += f.usdcIn; acc.out += f.usdcOut; return acc; }, { in: 0, out: 0 });
  const nrMakerFlow     = events.nrOrderMaker.reduce((acc, l) => { const f = decodeOrderFilled(l, 'maker'); acc.in += f.usdcIn; acc.out += f.usdcOut; return acc; }, { in: 0, out: 0 });
  const nrTakerFlow     = events.nrOrderTaker.reduce((acc, l) => { const f = decodeOrderFilled(l, 'taker'); acc.in += f.usdcIn; acc.out += f.usdcOut; return acc; }, { in: 0, out: 0 });

  const redeemTotal      = events.redemption.reduce((s, l) => s + decodePayoutRedemption(l), 0);
  const wrapTotal        = events.nrWrap.reduce   ((s, l) => s + decodeNegRiskAmount(l), 0);
  const unwrapTotal      = events.nrUnwrap.reduce ((s, l) => s + decodeNegRiskAmount(l), 0);
  const nrRedeemTotal    = (events.nrRedeem  ?? []).reduce((s, l) => s + decodeNegRiskRedeem(l), 0);
  const nrConvertTotal   = (events.nrConvert ?? []).reduce((s, l) => s + decodeNegRiskConvert(l), 0);

  const tradeIn  = orderMakerFlow.in  + orderTakerFlow.in  + nrMakerFlow.in  + nrTakerFlow.in;
  const tradeOut = orderMakerFlow.out + orderTakerFlow.out + nrMakerFlow.out + nrTakerFlow.out;
  // Convert is a partial cash-out: user receives USDC (in) AND gets converted
  // position (still a holding). We count the USDC portion only — the position
  // value continues to live in their share balance.
  const polyIn   = tradeIn  + redeemTotal + unwrapTotal + nrRedeemTotal + nrConvertTotal;
  const polyOut  = tradeOut + wrapTotal;
  const tradingPnl = polyIn - polyOut;

  // Optional USDC cross-check
  let usdcInTotal = 0, usdcOutTotal = 0;
  if (events.usdcIn)  usdcInTotal  = events.usdcIn.reduce ((s, l) => s + decodeUsdcAmount(l.data), 0);
  if (events.usdcOut) usdcOutTotal = events.usdcOut.reduce((s, l) => s + decodeUsdcAmount(l.data), 0);

  // ─── Report ─────────────────────────────────────────────────────────

  console.log('TRADING CASH FLOW (decoded from Polymarket events)');
  console.log(`  Order trades (CTF Exchange):`);
  console.log(`    maker side  in: ${fmtUsd(orderMakerFlow.in).padStart(12)}   out: ${fmtUsd(orderMakerFlow.out).padStart(12)}   (${events.orderMaker.length} events)`);
  console.log(`    taker side  in: ${fmtUsd(orderTakerFlow.in).padStart(12)}   out: ${fmtUsd(orderTakerFlow.out).padStart(12)}   (${events.orderTaker.length} events)`);
  console.log(`  Order trades (NegRisk CTF Exchange):`);
  console.log(`    maker side  in: ${fmtUsd(nrMakerFlow.in).padStart(12)}   out: ${fmtUsd(nrMakerFlow.out).padStart(12)}   (${events.nrOrderMaker.length} events)`);
  console.log(`    taker side  in: ${fmtUsd(nrTakerFlow.in).padStart(12)}   out: ${fmtUsd(nrTakerFlow.out).padStart(12)}   (${events.nrOrderTaker.length} events)`);
  console.log(`  Redemptions (CTF):           in: ${fmtUsd(redeemTotal).padStart(12)}   (${events.redemption.length} events)`);
  console.log(`  Redemptions (NegRiskAdapter):in: ${fmtUsd(nrRedeemTotal).padStart(12)}   (${(events.nrRedeem ?? []).length} events)`);
  console.log(`  NegRisk wraps (splits):      out: ${fmtUsd(wrapTotal).padStart(12)}   (${events.nrWrap.length} events)`);
  console.log(`  NegRisk unwraps (merges):    in: ${fmtUsd(unwrapTotal).padStart(12)}   (${events.nrUnwrap.length} events)`);
  console.log(`  NegRisk converts:            in: ${fmtUsd(nrConvertTotal).padStart(12)}   (${(events.nrConvert ?? []).length} events)`);
  console.log('');
  console.log(`  TOTAL IN  (from Polymarket): ${fmtUsd(polyIn).padStart(14)}`);
  console.log(`  TOTAL OUT (to Polymarket):   ${fmtUsd(polyOut).padStart(14)}`);
  console.log(`  TRADING CASH FLOW (in - out):${fmtUsd(tradingPnl).padStart(14)}`);
  console.log('');

  if (includeUsdc) {
    console.log('USDC CROSS-CHECK (raw transfers)');
    console.log(`  Total IN:  ${fmtUsd(usdcInTotal).padStart(14)}`);
    console.log(`  Total OUT: ${fmtUsd(usdcOutTotal).padStart(14)}`);
    console.log(`  Net:       ${fmtUsd(usdcInTotal - usdcOutTotal).padStart(14)}`);
    console.log('');
  }

  console.log('INTERPRETATION');
  console.log('  TRADING CASH FLOW is computed from amounts decoded out of each Polymarket');
  console.log('  event. Closest approximation to Polymarket\'s "Total PNL" without their');
  console.log('  internal cost-basis indexing. Positions still held are not marked-to-market');
  console.log('  here. For a wallet that has closed all positions, this should match Polymarket\'s');
  console.log('  reported Total PNL within a couple percent (gas + fees account for the gap).');
  console.log('  USDC cross-check is opt-in (INCLUDE_USDC=1) — slow but useful for sanity.');
}

main().catch(err => { console.error(err); process.exit(1); });
