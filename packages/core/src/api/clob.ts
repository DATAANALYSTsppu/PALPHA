import { createHmac } from 'crypto';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchJsonWithRetry } from './http.js';

const log = createLogger('clob-api');
const BASE = config.api.clobUrl;
const DELAY = config.api.requestDelayMs;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────────────────────
// L2 HMAC auth for CLOB API
//
// Matches the @polymarket/clob-client SDK's createL2Headers exactly:
//  1. requestPath is just the endpoint (e.g. "/trades"), NO query params
//  2. Signature is URL-safe base64 (+ → -, / → _)
//  3. POLY_ADDRESS header derived from wallet
//  4. timestamp in seconds
// ──────────────────────────────────────────────────────────────

const API_KEY = config.liveTrade.apiKey;
const API_SECRET = config.liveTrade.apiSecret;
const PASSPHRASE = config.liveTrade.passphrase;
const HAS_CREDS = Boolean(API_KEY && API_SECRET && PASSPHRASE);

/** Wallet address derived lazily from POLY_PRIVATE_KEY */
let _walletAddress: string | null = null;
async function getWalletAddress(): Promise<string> {
  if (_walletAddress) return _walletAddress;
  const { Wallet } = await import('ethers');
  const wallet = new Wallet(config.liveTrade.privateKey);
  _walletAddress = wallet.address;
  log.info({ address: _walletAddress }, 'Wallet address derived for CLOB auth');
  return _walletAddress;
}

/**
 * Build L2 HMAC-SHA256 headers for Polymarket CLOB API.
 *
 * The signed message is: timestamp + method + endpointPath
 * (endpointPath is e.g. "/trades" — NO query params, matching SDK behavior)
 *
 * Signature output is URL-safe base64: replace + with - and / with _
 */
async function buildL2Headers(method: string, endpointPath: string): Promise<Record<string, string>> {
  if (!HAS_CREDS) return {};

  const address = await getWalletAddress();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + endpointPath;

  // Decode secret from base64 (handles both standard and url-safe base64 input)
  const secretBuffer = Buffer.from(
    API_SECRET.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  const hmac = createHmac('sha256', secretBuffer);
  hmac.update(message);
  const sig = hmac.digest('base64');

  // Convert to URL-safe base64 (keep = padding)
  const sigUrlSafe = sig.replace(/\+/g, '-').replace(/\//g, '_');

  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: sigUrlSafe,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: API_KEY,
    POLY_PASSPHRASE: PASSPHRASE,
  };
}

/**
 * Fetch JSON from a CLOB endpoint with L2 auth headers.
 * endpointPath is the path portion only (e.g. "/trades"), used for HMAC signing.
 * fullUrl is the complete URL including query params, used for the actual fetch.
 */
async function fetchJsonAuthed<T>(endpointPath: string, fullUrl: string): Promise<T> {
  const headers = await buildL2Headers('GET', endpointPath);
  return fetchJsonWithRetry<T>(fullUrl, 'CLOB API', {}, HAS_CREDS ? headers : undefined);
}

/**
 * Fetch JSON from a public CLOB endpoint (no auth required).
 */
async function fetchJsonPublic<T>(url: string): Promise<T> {
  return fetchJsonWithRetry<T>(url, 'CLOB API');
}

// ──────────────────────────────────────────────────────────────
// Public CLOB endpoints (no auth required)
// ──────────────────────────────────────────────────────────────

export interface OrderBookEntry {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  hash: string;
  timestamp: string;
}

export async function getMidpoint(tokenId: string): Promise<{ mid: string }> {
  return fetchJsonPublic(`${BASE}/midpoint?token_id=${tokenId}`);
}

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  return fetchJsonPublic(`${BASE}/book?token_id=${tokenId}`);
}

export async function getPriceHistory(
  tokenId: string,
  params?: { startTs?: number; endTs?: number; fidelity?: number }
): Promise<{ history: Array<{ t: number; p: number }> }> {
  const qs = new URLSearchParams({ market: tokenId });
  if (params?.startTs) qs.set('startTs', String(params.startTs));
  if (params?.endTs) qs.set('endTs', String(params.endTs));
  if (params?.fidelity) qs.set('fidelity', String(params.fidelity));
  return fetchJsonPublic(`${BASE}/prices-history?${qs.toString()}`);
}

// ──────────────────────────────────────────────────────────────
// V2: CLOB trades with maker/taker classification (authenticated)
//
// Uses /trades (all market trades), NOT /data/trades (user-scoped).
// The /trades endpoint now requires L2 HMAC auth but returns trades
// for all participants, which is what the scan needs.
// ──────────────────────────────────────────────────────────────

/**
 * Raw CLOB trade structure. Key fields:
 *  - maker_orders: array of orders that provided liquidity
 *  - taker_order_id: the order that took liquidity
 *  - fee_rate_bps, match_time, side, size, price, status
 */
export interface ClobTrade {
  id: string;
  taker_order_id: string;
  market: string;                   // condition ID
  asset_id: string;                 // token ID
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  status: string;                   // 'MATCHED', 'MINED', 'CONFIRMED', etc.
  match_time: string;               // unix seconds
  last_update: string;
  outcome: string;
  maker_address?: string;
  owner?: string;
  transaction_hash?: string;
  bucket_index?: number;
  maker_orders?: Array<{
    order_id: string;
    owner: string;
    maker_address: string;
    matched_amount: string;
    price: string;
    fee_rate_bps: string;
    asset_id: string;
    outcome: string;
    side: 'BUY' | 'SELL';
  }>;
  trader_side?: 'MAKER' | 'TAKER'; // present if query was scoped to a user
  fee_rate_bps?: string;
}

/**
 * Fetch CLOB trades with full detail including maker/taker classification.
 * Uses /trades (all-market trades) with L2 HMAC auth.
 * Filters supported: market (conditionId), maker_address, taker, before, after.
 */
export async function fetchClobTrades(
  params: Record<string, string | number | boolean>
): Promise<ClobTrade[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }
  // Sign "/trades" (path only), fetch with full query string.
  // Response may be a bare array OR a wrapper like { data: [...], next_cursor }
  const raw = await fetchJsonAuthed<ClobTrade[] | { data?: ClobTrade[]; next_cursor?: string }>('/trades', `${BASE}/trades?${qs.toString()}`);

  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).data)) return (raw as any).data;
  // Unknown shape — log once for debugging and return empty
  log.warn({ responseKeys: Object.keys(raw || {}) }, '/trades returned unexpected shape');
  return [];
}

/**
 * Paginate CLOB trades by offset. Terminates when a short page is returned,
 * which matches the CLOB `/trades` server's contract for the last page.
 *
 * Note: some CLOB endpoints impose a max offset (~10k). If we hit that for
 * a very high-volume market, we'd miss older trades. No mitigation yet —
 * observed only for the most active markets; track and add `before=` filter
 * cursoring if it bites.
 */
export async function* paginateClobTrades(
  filters: Record<string, string | number | boolean>,
  pageSize = 500
): AsyncGenerator<ClobTrade[], void, unknown> {
  let offset = 0;
  while (true) {
    const trades = await fetchClobTrades({ ...filters, limit: pageSize, offset });
    if (trades.length === 0) break;
    yield trades;
    if (trades.length < pageSize) break;
    offset += trades.length;
    await sleep(DELAY);
  }
}
