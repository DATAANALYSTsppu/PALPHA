/**
 * Consensus — where do the traders we follow overlap?
 *
 * Takes the OPEN positions of every active copy target (Data API /positions),
 * groups them by market, and answers: which markets do the most of our traders
 * hold, on which side, and with how much money? Each side is then checked
 * against the REAL live Polymarket order book (CLOB GET /book), so you can see
 * the price you could still get in at right now.
 *
 * Read-only. No imports: fetch is injectable for offline tests.
 */

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>;
}>;
const realFetch: FetchLike = (u, i) => fetch(u, i) as never;

export interface OpenPosition {
  wallet: string;
  name: string;
  conditionId: string;
  asset: string;          // outcome token id
  outcome: string;        // "Yes" / "No" / team name …
  title: string;
  slug: string;
  eventSlug: string;
  endDate: string;
  size: number;           // shares
  avgPrice: number;       // trader's average entry
  initialValue: number;   // $ the trader put in (cost basis)
}

export interface BookInfo {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  /** $ available on the ask side at or below (consensus avg entry + slipCap). */
  askDepthUsdInSlip: number;
  /** bestAsk − consensus avg entry (cents of slippage if we bought now). */
  slippage: number | null;
  /** true when the best ask is within slipCap of the consensus avg entry. */
  copyable: boolean;
  fetchedAt: number;
}

export interface ConsensusTrader {
  wallet: string;
  name: string;
  usd: number;
  shares: number;
  avgPrice: number;
}

export interface ConsensusSide {
  outcome: string;
  asset: string;
  traderCount: number;
  totalUsd: number;
  shares: number;
  avgPrice: number;          // $-weighted average entry across traders
  traders: ConsensusTrader[];
  book: BookInfo | null;
}

export interface ConsensusMarket {
  conditionId: string;
  title: string;
  slug: string;
  eventSlug: string;
  endDate: string;
  traderCount: number;       // distinct traders in this market (any side)
  totalUsd: number;
  topSide: string;           // outcome with the most traders (ties → most $)
  agreement: number;         // topSide traders / all traders (1 = everyone on one side)
  split: boolean;            // traders are on opposing sides
  sides: ConsensusSide[];
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Open (unresolved) positions of one wallet. */
export async function fetchOpenPositions(
  dataUrl: string,
  wallet: string,
  name: string,
  opts: { fetchImpl?: FetchLike; maxPages?: number } = {},
): Promise<OpenPosition[]> {
  const f = opts.fetchImpl ?? realFetch;
  const out: OpenPosition[] = [];
  const PAGE = 500;
  for (let page = 0; page < (opts.maxPages ?? 4); page++) {
    const url =
      `${dataUrl}/positions?user=${encodeURIComponent(wallet)}` +
      `&limit=${PAGE}&offset=${page * PAGE}&sizeThreshold=1`;
    const res = await f(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('positions: unexpected payload');
    for (const p of body as Record<string, unknown>[]) {
      const cur = num(p.curPrice);
      // Drop settled / redeemable rows: nothing left to "take" there.
      if (p.redeemable === true || !(cur > 0 && cur < 1)) continue;
      const size = num(p.size);
      const avg = num(p.avgPrice);
      const iv = num(p.initialValue) || size * avg;
      if (!(size > 0) || !(iv > 0) || !p.conditionId || !p.asset) continue;
      out.push({
        wallet: wallet.toLowerCase(), name,
        conditionId: str(p.conditionId), asset: str(p.asset), outcome: str(p.outcome),
        title: str(p.title), slug: str(p.slug), eventSlug: str(p.eventSlug),
        endDate: str(p.endDate), size, avgPrice: avg, initialValue: iv,
      });
    }
    if (body.length < PAGE) break;
  }
  return out;
}

/** Group positions by market → side. Ranked by number of traders, then $. */
export function buildConsensus(positions: OpenPosition[], minTraders = 1): ConsensusMarket[] {
  const markets = new Map<string, OpenPosition[]>();
  for (const p of positions) {
    const arr = markets.get(p.conditionId);
    if (arr) arr.push(p); else markets.set(p.conditionId, [p]);
  }

  const result: ConsensusMarket[] = [];
  for (const [conditionId, rows] of markets) {
    const bySide = new Map<string, OpenPosition[]>();
    for (const r of rows) {
      const arr = bySide.get(r.asset);
      if (arr) arr.push(r); else bySide.set(r.asset, [r]);
    }

    const sides: ConsensusSide[] = [];
    for (const [asset, sideRows] of bySide) {
      // One trader can hold several rows of the same token (rare); merge them.
      const perTrader = new Map<string, ConsensusTrader>();
      for (const r of sideRows) {
        const t = perTrader.get(r.wallet);
        if (t) {
          const usd = t.usd + r.initialValue;
          const shares = t.shares + r.size;
          perTrader.set(r.wallet, { ...t, usd, shares, avgPrice: shares > 0 ? usd / shares : t.avgPrice });
        } else {
          perTrader.set(r.wallet, { wallet: r.wallet, name: r.name, usd: r.initialValue, shares: r.size, avgPrice: r.avgPrice });
        }
      }
      const traders = [...perTrader.values()].sort((a, b) => b.usd - a.usd);
      const totalUsd = traders.reduce((s, t) => s + t.usd, 0);
      const shares = traders.reduce((s, t) => s + t.shares, 0);
      sides.push({
        outcome: sideRows[0].outcome, asset,
        traderCount: traders.length, totalUsd, shares,
        avgPrice: shares > 0 ? totalUsd / shares : 0,   // $-weighted entry
        traders, book: null,
      });
    }
    sides.sort((a, b) => b.traderCount - a.traderCount || b.totalUsd - a.totalUsd);

    const wallets = new Set(rows.map(r => r.wallet));
    if (wallets.size < minTraders) continue;
    const first = rows[0];
    result.push({
      conditionId, title: first.title, slug: first.slug, eventSlug: first.eventSlug, endDate: first.endDate,
      traderCount: wallets.size,
      totalUsd: sides.reduce((s, x) => s + x.totalUsd, 0),
      topSide: sides[0].outcome,
      agreement: wallets.size > 0 ? sides[0].traderCount / wallets.size : 0,
      split: sides.length > 1,
      sides,
    });
  }
  result.sort((a, b) => b.traderCount - a.traderCount || b.totalUsd - a.totalUsd);
  return result;
}

/** Real order book for one outcome token. Null when the book can't be read. */
export async function fetchBookInfo(
  clobUrl: string,
  tokenId: string,
  refPrice: number,
  slipCap: number,
  opts: { fetchImpl?: FetchLike; now?: () => number } = {},
): Promise<BookInfo | null> {
  const f = opts.fetchImpl ?? realFetch;
  try {
    const res = await f(`${clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const b = (await res.json()) as { asks?: unknown[]; bids?: unknown[] };
    const lvls = (a: unknown[] | undefined) =>
      (Array.isArray(a) ? a : [])
        .map(x => ({ price: num((x as { price?: unknown }).price), size: num((x as { size?: unknown }).size) }))
        .filter(x => x.price > 0 && x.price <= 1 && x.size > 0);
    const asks = lvls(b.asks).sort((x, y) => x.price - y.price);
    const bids = lvls(b.bids).sort((x, y) => y.price - x.price);
    const bestAsk = asks[0]?.price ?? null;
    const bestBid = bids[0]?.price ?? null;
    const limit = refPrice + slipCap;
    let depth = 0;
    for (const a of asks) { if (a.price > limit + 1e-9) break; depth += a.price * a.size; }
    return {
      bestBid, bestAsk,
      spread: bestAsk !== null && bestBid !== null ? bestAsk - bestBid : null,
      askDepthUsdInSlip: depth,
      slippage: bestAsk !== null ? bestAsk - refPrice : null,
      copyable: bestAsk !== null && bestAsk <= limit + 1e-9,
      fetchedAt: (opts.now ?? Date.now)(),
    };
  } catch {
    return null;
  }
}

/** Attach live books to every side of the given markets (bounded concurrency, cached briefly). */
export async function attachBooks(
  markets: ConsensusMarket[],
  clobUrl: string,
  o: { slipCap: number; concurrency?: number; fetchImpl?: FetchLike; cache?: Map<string, BookInfo | null>; cacheMs?: number; now?: () => number },
): Promise<void> {
  const now = o.now ?? Date.now;
  const cache = o.cache;
  const cacheMs = o.cacheMs ?? 10_000;
  const jobs: ConsensusSide[] = markets.flatMap(m => m.sides);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const side = jobs[next++];
      // Cache key includes the reference price: the copyable flag depends on it.
      const key = `${side.asset}:${side.avgPrice.toFixed(4)}:${o.slipCap}`;
      const hit = cache?.get(key);
      if (hit && now() - hit.fetchedAt < cacheMs) { side.book = hit; continue; }
      const info = await fetchBookInfo(clobUrl, side.asset, side.avgPrice, o.slipCap, { fetchImpl: o.fetchImpl, now });
      if (info) cache?.set(key, info);
      side.book = info;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 5) }, worker));
}
