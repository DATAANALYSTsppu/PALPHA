/**
 * selftest-quality-consensus — checks the trader-quality rule (who earns the
 * bigger bet size) and the consensus builder (where our traders overlap).
 *
 * No database, no network, no orders. `fetch` is replaced by a fake:
 *
 *     npm run selftest:quality
 *
 * The "real sample" rows below are verbatim from Polymarket's live Data API
 * (GET /closed-positions, newest first), so field names and types are the real ones.
 */
import assert from 'node:assert/strict';
import {
  computeStats, evaluate, fetchClosedPositions, TraderQualityCache,
  DEFAULT_QUALITY, type ClosedPosition, type QualityConfig,
} from '../services/trader-quality.js';
import {
  buildConsensus, fetchBookInfo, fetchOpenPositions, attachBooks,
  type OpenPosition,
} from '../services/consensus.js';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; });
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ─── Real sample (Polymarket Data API, /closed-positions) ──────────
const REAL_ROWS: ClosedPosition[] = [
  { avgPrice: 0.4186, totalBought: 355.0575, realizedPnl: -148.3295 },
  { avgPrice: 0.1283, totalBought: 1450, realizedPnl: -186.0727 },
  { avgPrice: 0.003, totalBought: 1889, realizedPnl: -5.667 },
  { avgPrice: 0.51, totalBought: 625.9953, realizedPnl: -318.7476 },
  { avgPrice: 0.3979, totalBought: 10699.6786, realizedPnl: 1092.0734 },
];

// ─── Helpers to fabricate histories ────────────────────────────────
/** n positions each costing $100: `wins` winners paying +winPnl, rest losing lossPnl. */
function history(n: number, wins: number, winPnl: number, lossPnl: number): ClosedPosition[] {
  return Array.from({ length: n }, (_, i) => ({
    avgPrice: 0.5, totalBought: 200,   // cost = $100
    realizedPnl: i < wins ? winPnl : -lossPnl,
  }));
}
const CFG: QualityConfig = { minRoi: 0.10, minRoiPositions: 30, minWins: 50 };
const q = (rows: ClosedPosition[]) => evaluate(computeStats(rows, false), CFG);

type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };
const okJson = (body: unknown): Resp => ({ ok: true, status: 200, json: async () => body });

async function main(): Promise<void> {
  console.log('Trader quality — who gets the bigger bet');

  await check('real Polymarket rows: cost = avgPrice × totalBought (shares), P/L sums correctly', () => {
    const s = computeStats(REAL_ROWS, false);
    assert.equal(s.positions, 5);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 4);
    near(s.grossWin, 1092.0734);
    near(s.grossLoss, 148.3295 + 186.0727 + 5.667 + 318.7476);
    near(s.netPnl, 1092.0734 - 658.8168, 1e-3);
    // invested ≈ 148.62 + 186.04 + 5.67 + 319.26 + 4257.4 ≈ 4917
    assert.ok(s.invested > 4900 && s.invested < 4940, `invested ${s.invested}`);
    assert.ok(s.roi !== null && s.roi > 0.08 && s.roi < 0.10, `roi ${s.roi}`);
  });

  await check('real sample is NOT qualified (only 5 positions, 1 win)', () => {
    const r = evaluate(computeStats(REAL_ROWS, false), CFG);
    assert.equal(r.qualified, false);
  });

  await check('ROI rule: 30 positions at +15% ROI → qualified', () => {
    // 30 × $100 in; 20 wins of +$60, 10 losses of −$40 → +$800 / $3000 = 26.7%
    const r = q(history(30, 20, 60, 40));
    assert.equal(r.qualified, true);
    assert.match(r.reasons[0], /ROI/);
  });

  await check('ROI rule needs the sample size: 29 positions at high ROI → not qualified', () => {
    assert.equal(q(history(29, 20, 60, 40)).qualified, false);
  });

  await check('ROI rule boundary: exactly 10.0% qualifies, just under does not', () => {
    // 30 × $100; 15 wins of +$40, 15 losses of −$20 → +$300 / $3000 = 10.0%
    assert.equal(q(history(30, 15, 40, 20)).qualified, true);
    // +$290 → 9.67%
    const under = history(30, 15, 40, 20); under[0] = { ...under[0], realizedPnl: 30 };
    assert.equal(q(under).qualified, false);
  });

  await check('ROI rule needs positive net P/L even if minRoi were 0', () => {
    const r = evaluate(computeStats(history(40, 10, 20, 30), false), { ...CFG, minRoi: -1, minWins: 999 });
    assert.equal(r.qualified, false);
  });

  await check('WIN rule: 50 wins and $ won > $ lost → qualified (even with low ROI)', () => {
    // 200 positions; 50 wins of +$10 = $500 won, 150 losses of −$3 = $450 lost → ROI 0.25% (< 10%)
    const r = q(history(200, 50, 10, 3));
    assert.equal(r.qualified, true);
    assert.match(r.reasons.join(' '), /50 wins/);
  });

  await check('WIN rule: 50 wins but more $ lost than won → NOT qualified', () => {
    // 50 wins of +$5 = $250; 150 losses of −$10 = $1,500
    assert.equal(q(history(200, 50, 5, 10)).qualified, false);
  });

  await check('WIN rule: 49 wins is not enough', () => {
    assert.equal(q(history(100, 49, 10, 1)).qualified, false);
  });

  await check('no data → not qualified, never throws', () => {
    assert.equal(evaluate(null, CFG).qualified, false);
    assert.equal(q([]).qualified, false);
  });

  await check('garbage numbers (strings / NaN) are tolerated', () => {
    const s = computeStats([{ avgPrice: '0.5', totalBought: '100', realizedPnl: '10' }, { avgPrice: 'x', totalBought: undefined, realizedPnl: 'NaN' }], false);
    assert.equal(s.wins, 1);
    near(s.invested, 50);
  });

  await check('defaults match the stated rule (10% / 30 positions / 50 wins)', () => {
    assert.deepEqual(DEFAULT_QUALITY, { minRoi: 0.10, minRoiPositions: 30, minWins: 50 });
  });

  console.log('\nHistory download (/closed-positions)');

  await check('pages newest-first (sortBy=TIMESTAMP) — the API default would return only the best trades', async () => {
    const urls: string[] = [];
    const pages = [new Array(50).fill({}), new Array(50).fill({}), new Array(7).fill({})];
    const out = await fetchClosedPositions('https://d', '0xAbC', {
      fetchImpl: async (u) => { urls.push(u); return okJson(pages[urls.length - 1] ?? []); },
    });
    assert.equal(out.rows.length, 107);
    assert.equal(out.capped, false);
    assert.equal(urls.length, 3);
    for (const u of urls) assert.match(u, /sortBy=TIMESTAMP&sortDirection=DESC/);
    assert.match(urls[0], /offset=0&/);
    assert.match(urls[1], /offset=50&/);
    assert.match(urls[2], /offset=100&/);
    assert.match(urls[0], /limit=50/);
  });

  await check('page cap → capped=true', async () => {
    const out = await fetchClosedPositions('https://d', '0x1', {
      maxPages: 2, fetchImpl: async () => okJson(new Array(50).fill({})),
    });
    assert.equal(out.rows.length, 100);
    assert.equal(out.capped, true);
  });

  await check('HTTP error / non-array payload throw', async () => {
    await assert.rejects(fetchClosedPositions('https://d', '0x1', { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }), /429/);
    await assert.rejects(fetchClosedPositions('https://d', '0x1', { fetchImpl: async () => okJson({ error: 'x' }) }), /unexpected payload/);
  });

  await check('cache: concurrent lookups share ONE download; fresh result is reused', async () => {
    let calls = 0;
    const cache = new TraderQualityCache({
      dataUrl: 'https://d', cfg: CFG,
      fetchImpl: async () => { calls++; return okJson(history(30, 20, 60, 40)); },
    });
    const [a, b] = await Promise.all([cache.get('0xA'), cache.get('0xa')]);
    assert.equal(a.qualified, true);
    assert.equal(b.qualified, true);
    await cache.get('0xA');
    assert.equal(calls, 1);
  });

  await check('cache.peek never waits: null at first, answer once the background refresh lands', async () => {
    const cache = new TraderQualityCache({
      dataUrl: 'https://d', cfg: CFG,
      fetchImpl: async () => okJson(history(30, 20, 60, 40)),
    });
    assert.equal(cache.peek('0xB'), null);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(cache.peek('0xB')?.qualified, true);
  });

  await check('cache: a failed refresh keeps the last good answer; first-ever failure = not qualified (base size)', async () => {
    let t = 0; let fail = false;
    const cache = new TraderQualityCache({
      dataUrl: 'https://d', cfg: CFG, ttlMs: 1000, retryMs: 100, now: () => t, log: () => undefined,
      fetchImpl: async () => { if (fail) throw new Error('boom'); return okJson(history(30, 20, 60, 40)); },
    });
    assert.equal((await cache.get('0xC')).qualified, true);
    t = 5000; fail = true;
    assert.equal((await cache.get('0xC')).qualified, true, 'stale-but-good result kept');
    const fresh = new TraderQualityCache({ dataUrl: 'https://d', cfg: CFG, log: () => undefined, fetchImpl: async () => { throw new Error('boom'); } });
    assert.equal((await fresh.get('0xD')).qualified, false);
  });

  console.log('\nConsensus — where our traders overlap');

  const pos = (wallet: string, cond: string, asset: string, outcome: string, usd: number, avg: number, title = cond): OpenPosition => ({
    wallet, name: wallet.toUpperCase(), conditionId: cond, asset, outcome, title, slug: '', eventSlug: '', endDate: '',
    size: usd / avg, avgPrice: avg, initialValue: usd,
  });

  await check('groups by market and side, ranks by number of traders then $', () => {
    const rows = [
      pos('a', 'M1', 'M1Y', 'Yes', 100, 0.50), pos('b', 'M1', 'M1Y', 'Yes', 300, 0.60), pos('c', 'M1', 'M1N', 'No', 50, 0.40),
      pos('a', 'M2', 'M2Y', 'Yes', 900, 0.70),                                    // 1 trader, big $
      pos('a', 'M3', 'M3Y', 'Yes', 10, 0.30), pos('b', 'M3', 'M3Y', 'Yes', 10, 0.30), // 2 traders, small $
    ];
    const m = buildConsensus(rows);
    assert.deepEqual(m.map(x => x.conditionId), ['M1', 'M3', 'M2']);   // 3 traders, 2 traders, 1 trader
    const m1 = m[0];
    assert.equal(m1.traderCount, 3);
    assert.equal(m1.topSide, 'Yes');
    assert.equal(m1.split, true);
    near(m1.agreement, 2 / 3);
    near(m1.totalUsd, 450);
    const yes = m1.sides[0];
    assert.equal(yes.traderCount, 2);
    near(yes.totalUsd, 400);
    // $-weighted entry: 400 / (200 + 500) shares
    near(yes.avgPrice, 400 / (100 / 0.5 + 300 / 0.6), 1e-9);
    assert.deepEqual(yes.traders.map(t => t.wallet), ['b', 'a']);          // biggest $ first
    assert.equal(m[1].split, false);
  });

  await check('minTraders filters single-trader markets', () => {
    const rows = [pos('a', 'M1', 'Y', 'Yes', 10, 0.5), pos('b', 'M1', 'Y', 'Yes', 10, 0.5), pos('a', 'M2', 'Z', 'Yes', 10, 0.5)];
    assert.deepEqual(buildConsensus(rows, 2).map(x => x.conditionId), ['M1']);
  });

  await check('same trader holding the same side twice counts once (merged)', () => {
    const m = buildConsensus([pos('a', 'M1', 'Y', 'Yes', 10, 0.5), pos('a', 'M1', 'Y', 'Yes', 30, 0.5)]);
    assert.equal(m[0].traderCount, 1);
    near(m[0].sides[0].totalUsd, 40);
  });

  await check('open positions: drops redeemable / settled / empty rows, keeps live ones', async () => {
    const body = [
      { conditionId: 'c1', asset: 'a1', outcome: 'Yes', title: 'T1', size: 100, avgPrice: 0.4, initialValue: 40, curPrice: 0.45, redeemable: false },
      { conditionId: 'c2', asset: 'a2', outcome: 'Yes', title: 'T2', size: 100, avgPrice: 0.4, initialValue: 40, curPrice: 1, redeemable: true },
      { conditionId: 'c3', asset: 'a3', outcome: 'No', title: 'T3', size: 100, avgPrice: 0.4, initialValue: 40, curPrice: 0, redeemable: false },
      { conditionId: 'c4', asset: 'a4', outcome: 'No', title: 'T4', size: 0, avgPrice: 0.4, initialValue: 0, curPrice: 0.5, redeemable: false },
    ];
    const urls: string[] = [];
    const rows = await fetchOpenPositions('https://d', '0xWALLET', 'Bob', { fetchImpl: async (u) => { urls.push(u); return okJson(body); } });
    assert.deepEqual(rows.map(r => r.conditionId), ['c1']);
    assert.equal(rows[0].wallet, '0xwallet');
    assert.equal(rows[0].name, 'Bob');
    assert.match(urls[0], /\/positions\?user=0xWALLET/);
  });

  // Real /book shape: levels are strings; bids come worst→best, asks are unsorted-safe.
  const REAL_BOOK = {
    market: '0x3d76', asset_id: 'tok', tick_size: '0.01', min_order_size: '5',
    bids: [{ price: '0.01', size: '100' }, { price: '0.41', size: '200' }, { price: '0.42', size: '3490.55' }],
    asks: [{ price: '0.99', size: '50' }, { price: '0.52', size: '1000' }, { price: '0.48', size: '6' }],
  };

  await check('real book: best bid/ask found regardless of order; depth counts only asks inside the slippage cap', async () => {
    const b = await fetchBookInfo('https://c', 'tok', 0.45, 0.05, { fetchImpl: async () => okJson(REAL_BOOK) });
    assert.ok(b);
    near(b!.bestBid!, 0.42);
    near(b!.bestAsk!, 0.48);
    near(b!.spread!, 0.06, 1e-9);
    // limit = 0.50 → only the 0.48 × 6 level: $2.88
    near(b!.askDepthUsdInSlip, 0.48 * 6, 1e-9);
    near(b!.slippage!, 0.03, 1e-9);
    assert.equal(b!.copyable, true);
  });

  await check('book: best ask beyond the cap → not copyable; unreadable book → null (no fabricated numbers)', async () => {
    const far = await fetchBookInfo('https://c', 'tok', 0.30, 0.05, { fetchImpl: async () => okJson(REAL_BOOK) });
    assert.equal(far!.copyable, false);
    assert.equal(await fetchBookInfo('https://c', 'tok', 0.3, 0.05, { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }), null);
    assert.equal(await fetchBookInfo('https://c', 'tok', 0.3, 0.05, { fetchImpl: async () => { throw new Error('net'); } }), null);
    const empty = await fetchBookInfo('https://c', 'tok', 0.3, 0.05, { fetchImpl: async () => okJson({ asks: [], bids: [] }) });
    assert.equal(empty!.bestAsk, null);
    assert.equal(empty!.copyable, false);
  });

  await check('attachBooks hits the book URL for every side, and caches within the window', async () => {
    const mk = () => buildConsensus([pos('a', 'M1', 'TOK_Y', 'Yes', 10, 0.45), pos('b', 'M1', 'TOK_N', 'No', 10, 0.55)]);
    const seen: string[] = [];
    const cache = new Map();
    const fetchImpl = async (u: string) => { seen.push(u); return okJson(REAL_BOOK); };
    const m1 = mk();
    await attachBooks(m1, 'https://clob.polymarket.com', { slipCap: 0.05, fetchImpl, cache, now: () => 1000 });
    assert.equal(seen.length, 2);
    assert.ok(seen.every(u => u.startsWith('https://clob.polymarket.com/book?token_id=')));
    assert.ok(m1[0].sides.every(s => s.book !== null));
    const m2 = mk();
    await attachBooks(m2, 'https://clob.polymarket.com', { slipCap: 0.05, fetchImpl, cache, now: () => 5000 });
    assert.equal(seen.length, 2, 'served from cache inside 10 s');
    await attachBooks(mk(), 'https://clob.polymarket.com', { slipCap: 0.05, fetchImpl, cache, now: () => 20000 });
    assert.equal(seen.length, 4, 'refetched after the cache window');
  });

  console.log(process.exitCode ? `\nFAILED (${passed} passed)` : `\n${passed} checks passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
