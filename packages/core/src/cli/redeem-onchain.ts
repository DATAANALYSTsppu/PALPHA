/**
 * redeem-onchain — Claim won positions on chain via the Polymarket proxy.
 *
 * Standalone, DB-free redemption. Reads redeemable positions for the
 * configured POLY_FUNDER from the Polymarket Data API, builds a single
 * batched `proxy(Operation[])` call that runs `redeemPositions` for each,
 * and either prints the tx or submits it.
 *
 * Works with the Polymarket 1-of-1 proxy pattern (bytecode prefix
 * `0x6080604052...530ca437...` — see PROXY_FUNCTION_ABI below). If your
 * proxy is a Gnosis Safe, the encoding differs — this script will fail.
 *
 * Usage:
 *   tsx packages/core/src/cli/redeem-onchain.ts            # dry-run, prints plan
 *   tsx packages/core/src/cli/redeem-onchain.ts --apply    # actually submit
 *
 * Env required (loaded via config.ts):
 *   POLY_PRIVATE_KEY   — EOA private key, owner of the proxy
 *   POLY_FUNDER        — proxy address (where positions live)
 *   POLYMARKET_RPC     — Polygon RPC URL (or POLYGON_RPC fallback)
 */

import { config } from '../config.js';
import { Wallet, providers, Contract, utils, BigNumber } from 'ethers';
import { request as undiciRequest } from 'undici';

// ─── Constants ───────────────────────────────────────────────────────

// USDC.e on Polygon (the collateral Polymarket uses for CTF positions).
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Gnosis Conditional Tokens framework (where shares live, where redemption fires).
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// "Root" parentCollectionId for top-level positions (no parent collateralization).
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

// Polymarket Data API base — used to query redeemable positions for our proxy.
const POLY_DATA_API = 'https://data-api.polymarket.com';
const UA = 'Mozilla/5.0 (compatible; palpha-redeem/1.0)';

// Polymarket 1-of-1 proxy ABI — exposes proxy(Operation[]).
//   Operation = { to: address, value: uint256, data: bytes, operation: uint8 }
//   operation enum: 0 = CALL, 1 = DELEGATECALL.
// Selector check: keccak256("proxy((address,uint256,bytes,uint8)[])")[:4] = 0x530ca437.
const PROXY_FUNCTION_ABI = [
  'function proxy(tuple(address to, uint256 value, bytes data, uint8 operation)[] operations) payable returns (bytes[])',
];

// ConditionalTokens — we only need the redeemPositions signature.
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

// ─── Types ───────────────────────────────────────────────────────────

interface PolymarketPosition {
  proxyWallet: string;
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  currentValue: number;
  redeemable: boolean;
  negativeRisk?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function fetchRedeemable(funder: string): Promise<PolymarketPosition[]> {
  // sizeThreshold=0 → include positions of any size; redeemable=true → only the
  // ones with resolved markets and outstanding shares to claim.
  const url = `${POLY_DATA_API}/positions?user=${funder}&limit=500&sizeThreshold=0&redeemable=true`;
  const res = await undiciRequest(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new Error(`Polymarket API HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
  }
  return (await res.body.json()) as PolymarketPosition[];
}

function buildRedeemCalldata(conditionId: string, isNegRisk: boolean): string {
  // indexSets enumerates which outcome positions to claim. For a standard
  // binary market we pass [1, 2] which covers BOTH Yes and No — the contract
  // pays out only whichever you actually hold. For negRisk multi-outcome
  // markets each outcome is its own bit; [1, 2] still covers the two-outcome
  // case but if you ever hold a slice with index > 1 you may need a wider set.
  const indexSets = isNegRisk ? [1, 2] : [1, 2];
  const ctf = new Contract(CTF, CTF_ABI);
  return ctf.interface.encodeFunctionData('redeemPositions', [USDC, ZERO_BYTES32, conditionId, indexSets]);
}

function fmtUsd(n: number): string {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const funder = process.env.POLY_FUNDER;
  const privateKey = process.env.POLY_PRIVATE_KEY;
  const rpcUrl = config.polygon.rpcUrl;

  if (!funder) throw new Error('POLY_FUNDER not set in .env');
  if (!privateKey) throw new Error('POLY_PRIVATE_KEY not set in .env');
  if (!rpcUrl) throw new Error('POLYMARKET_RPC / POLYGON_RPC not set');

  const provider = new providers.JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const eoa = wallet.address;

  console.log('=== Polymarket on-chain redemption ===');
  console.log(`  Mode:           ${apply ? 'APPLY (will submit tx)' : 'DRY-RUN (read-only)'}`);
  console.log(`  EOA signer:     ${eoa}`);
  console.log(`  Proxy (funder): ${funder}`);
  console.log(`  RPC:            ${rpcUrl.replace(/\/\/.*@/, '//***@').slice(0, 60)}...`);
  console.log('');

  // 1. Fetch redeemable positions
  console.log('Fetching redeemable positions from Polymarket Data API...');
  const positions = await fetchRedeemable(funder);
  console.log(`Found ${positions.length} redeemable positions.\n`);

  if (positions.length === 0) {
    console.log('Nothing to redeem. Done.');
    return;
  }

  // 2. Show the plan
  let totalValue = 0;
  for (const p of positions) {
    totalValue += p.currentValue ?? 0;
    console.log(`  ${(p.title ?? '').slice(0, 60).padEnd(60)} ${p.outcome?.slice(0, 12).padEnd(12)} size=${p.size?.toFixed(2)?.padStart(10)}  value=${fmtUsd(p.currentValue ?? 0).padStart(10)}`);
    console.log(`    conditionId=${p.conditionId}  negRisk=${!!p.negativeRisk}`);
  }
  console.log('');
  console.log(`Subtotal claimable: ${fmtUsd(totalValue)} (positions with currentValue=0 are losers — redeeming still cleans them up)`);
  console.log('');

  // 3. De-duplicate by conditionId (a single market might appear in multiple
  // rows if multiple outcomes were held; the redeemPositions call covers the
  // whole market in one go).
  const seen = new Set<string>();
  const ops: { to: string; value: BigNumber; data: string; operation: number }[] = [];
  for (const p of positions) {
    if (seen.has(p.conditionId)) continue;
    seen.add(p.conditionId);
    ops.push({
      to: CTF,
      value: BigNumber.from(0),
      data: buildRedeemCalldata(p.conditionId, !!p.negativeRisk),
      operation: 0, // CALL
    });
  }
  console.log(`Built ${ops.length} unique redeemPositions calls (after de-dup by conditionId).\n`);

  // 4. Prepare the batched proxy tx
  const proxy = new Contract(funder, PROXY_FUNCTION_ABI, wallet);

  // Estimate gas first — also doubles as a sanity check that the EOA is the
  // proxy's owner. If we're not the owner the proxy reverts and estimateGas
  // throws with a useful error.
  let gasEstimate: BigNumber;
  try {
    gasEstimate = await proxy.estimateGas.proxy(ops);
    console.log(`Gas estimate: ${gasEstimate.toString()}`);
  } catch (err) {
    console.error('\nestimateGas failed — common causes:');
    console.error('  - This EOA is not the proxy owner (wrong POLY_PRIVATE_KEY for POLY_FUNDER)');
    console.error('  - The proxy uses a different function signature (e.g. Gnosis Safe execTransaction)');
    console.error('  - A market is not actually redeemable yet (state mismatch with API)');
    console.error('\nRaw error:', (err as Error).message);
    throw err;
  }

  const feeData = await provider.getFeeData();
  console.log(`Max fee per gas:  ${utils.formatUnits(feeData.maxFeePerGas ?? BigNumber.from(0), 'gwei')} gwei`);
  console.log(`Estimated cost:   ~${utils.formatEther(gasEstimate.mul(feeData.maxFeePerGas ?? BigNumber.from(0)))} MATIC`);
  console.log('');

  if (!apply) {
    console.log('Dry-run complete. Re-run with --apply to submit.');
    return;
  }

  // 5. Submit
  console.log('Submitting transaction...');
  const tx = await proxy.proxy(ops, {
    gasLimit: gasEstimate.mul(120).div(100), // 20% buffer
  });
  console.log(`Tx hash: ${tx.hash}`);
  console.log(`https://polygonscan.com/tx/${tx.hash}`);
  console.log('Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}. Gas used: ${receipt.gasUsed.toString()}`);
  console.log(`Status: ${receipt.status === 1 ? '✅ success' : '❌ failed'}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
