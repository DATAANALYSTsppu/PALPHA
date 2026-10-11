/**
 * On-chain resolution reader (Gnosis ConditionalTokens on Polygon).
 *
 * Many Polymarket sports markets — spreads, over/under, in-game props and a
 * good share of plain match markets — are settled ON CHAIN only: the CLOB's
 * /markets keeps reporting no winner with both sides at 0.5, and Gamma has
 * nothing. The payout is still recorded in the CTF contract, so we read it
 * there instead of waiting for an API that never updates.
 *
 * payoutDenominator(conditionId) == 0 means "not resolved yet"; once resolved
 * the numerators sum to the denominator, and a single slot holding the whole
 * denominator is the winner. An even split (a refund / 50-50 settlement) has
 * no winner, and we say so rather than guessing.
 */

import { Contract, constants, providers } from 'ethers';
import { config } from '../config.js';

/** Gnosis ConditionalTokens — every Polymarket outcome token lives here. */
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
/** USDC.e — the collateral every Polymarket position is denominated in. */
const USDC = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

const CTF_ABI = [
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
];

let ctf: Contract | null = null;
function getCtf(): Contract {
  if (!ctf) {
    ctf = new Contract(CTF_CONTRACT, CTF_ABI, new providers.JsonRpcProvider(config.polygon.rpcUrl));
  }
  return ctf;
}

export interface OnChainResolution {
  /** Payout numerators, one per outcome slot, as decimal strings. */
  numerators: string[];
  denominator: string;
  /** Slot that took the whole payout, or null for an even/partial split. */
  winnerIndex: number | null;
}

/** Raw payout for a condition. null = the contract has no payout yet. */
export async function fetchOnChainResolution(conditionId: string): Promise<OnChainResolution | null> {
  const c = getCtf();
  const denominator = await c.payoutDenominator(conditionId);
  if (denominator.isZero()) return null; // not resolved on chain yet

  const slots = (await c.getOutcomeSlotCount(conditionId)).toNumber();
  if (!slots) return null;

  const numerators: string[] = [];
  for (let i = 0; i < slots; i++) {
    numerators.push((await c.payoutNumerators(conditionId, i)).toString());
  }

  // A winner takes the entire denominator. Anything else (a 50-50 refund, or a
  // scalar market's partial payout) has no single winning outcome.
  const winnerIndex = numerators.findIndex(n => n === denominator.toString());
  return {
    numerators,
    denominator: denominator.toString(),
    winnerIndex: winnerIndex >= 0 ? winnerIndex : null,
  };
}

/** ERC-1155 position id for one outcome slot, as the decimal string the CLOB
 *  uses for token ids. Lets us map a payout slot to a named outcome without
 *  assuming the CLOB returns its tokens in slot order. */
export async function positionIdForSlot(conditionId: string, slotIndex: number): Promise<string> {
  const c = getCtf();
  const collectionId = await c.getCollectionId(constants.HashZero, conditionId, 1 << slotIndex);
  return (await c.getPositionId(USDC, collectionId)).toString();
}

/**
 * The winning outcome NAME for a market that resolved on chain, or null when
 * the contract has no payout yet / the payout was split.
 *
 * `outcomes` is the market's token list (id + name) in CLOB order. The slot is
 * matched by deriving each slot's position id, falling back to list order only
 * if that derivation matches nothing — neg-risk markets trade wrapped tokens
 * whose ids don't equal the raw CTF position id.
 */
export async function fetchOnChainWinner(
  conditionId: string,
  outcomes: { tokenId: string; outcome: string }[],
): Promise<string | null> {
  const res = await fetchOnChainResolution(conditionId);
  if (!res || res.winnerIndex === null) return null;

  try {
    const winnerTokenId = await positionIdForSlot(conditionId, res.winnerIndex);
    const match = outcomes.find(o => o.tokenId === winnerTokenId);
    if (match) return match.outcome;
  } catch {
    // RPC hiccup on the mapping call — fall through to order.
  }
  return outcomes[res.winnerIndex]?.outcome ?? null;
}

/**
 * What one share of `tokenId` is worth now that the condition has settled:
 * 1 for the winner, 0 for the loser, 0.5 for an even split (a voided market),
 * and null while the condition has no payout yet.
 *
 * This is the settlement path that needs no CLOB call and no outcome names —
 * exactly what a market the CLOB refuses to resolve leaves us with. The slot is
 * found by deriving each slot's position id; `fallbackSlot` covers neg-risk
 * markets, whose traded token is a wrapper whose id is not the CTF position id.
 */
export async function fetchPayoutFraction(
  conditionId: string,
  tokenId: string,
  fallbackSlot?: number | null,
): Promise<number | null> {
  const res = await fetchOnChainResolution(conditionId);
  if (!res) return null;

  let slot = -1;
  try {
    for (let i = 0; i < res.numerators.length; i++) {
      if ((await positionIdForSlot(conditionId, i)) === tokenId) {
        slot = i;
        break;
      }
    }
  } catch {
    // RPC hiccup on the mapping calls — fall back below.
  }
  if (slot < 0) slot = fallbackSlot ?? -1;
  if (slot < 0 || slot >= res.numerators.length) return null;

  const denom = Number(res.denominator);
  if (!denom) return null;
  return Number(res.numerators[slot]) / denom;
}
