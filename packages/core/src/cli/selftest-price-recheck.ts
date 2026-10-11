/**
 * selftest-price-recheck — exercises the Price Re-Check Engine's decision logic
 * and state machine against an in-memory store and a fake clock.
 *
 * Touches no database, no network, places no orders:
 *
 *     npm run selftest:recheck
 *
 * Exit code 0 = all assertions passed.
 */
import assert from 'node:assert/strict';
import {
  RECHECK_SCHEDULE_SEC, RECHECK_TTL_SEC,
  decide, parseBestAsk, isPriceUnavailableReason,
  enqueueWatch, cancelWatches, processWatchlist, recoverInterrupted, PgWatchStore,
  type BuyOutcome, type FillInfo, type HistoryItem, type NewWatch, type QueryFn,
  type RecheckDeps, type WatchEntry, type WatchStatus, type WatchStore,
} from '../services/price-recheck.js';

// ─── In-memory store mirroring PgWatchStore semantics ──────────────

interface Row {
  id: number; w: NewWatch; status: WatchStatus; reason: string | null;
  checkCount: number; firstSeenAt: number; nextCheckAt: number;
  firstSeenPrice: number | null; history: HistoryItem[]; fill: FillInfo | null;
}

class MemStore implements WatchStore {
  rows: Row[] = [];
  signals = new Map<string, { acted: boolean; skip: string | null }>();
  clock = 0;
  private seq = 0;
  denyClaim = false;

  async insert(w: NewWatch): Promise<boolean> {
    const dup = this.rows.some(r =>
      (r.w.proxyWallet === w.proxyWallet && r.w.sourceTradeKey === w.sourceTradeKey) ||
      ((r.status === 'watching' || r.status === 'buying') &&
        r.w.proxyWallet === w.proxyWallet && r.w.conditionId === w.conditionId && r.w.tokenId === w.tokenId));
    if (dup) return false;
    this.rows.push({
      id: ++this.seq, w, status: 'watching', reason: null, checkCount: 0,
      firstSeenAt: this.clock, nextCheckAt: this.clock + w.firstSlotSec,
      firstSeenPrice: w.firstSeenPrice, history: [...w.history], fill: null,
    });
    return true;
  }
  async listDue(limit: number): Promise<WatchEntry[]> {
    return this.rows
      .filter(r => r.status === 'watching' && r.nextCheckAt <= this.clock)
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
      .slice(0, limit)
      .map(r => ({
        id: r.id, proxyWallet: r.w.proxyWallet, sourceTradeKey: r.w.sourceTradeKey,
        conditionId: r.w.conditionId, tokenId: r.w.tokenId, outcome: r.w.outcome,
        targetPrice: r.w.targetPrice, targetSize: r.w.targetSize, targetTs: r.w.targetTs,
        firstSeenPrice: r.firstSeenPrice, capUsd: r.w.capUsd, capKind: r.w.capKind,
        checkCount: r.checkCount, elapsedSec: this.clock - r.firstSeenAt,
      }));
  }
  async claimBuy(id: number): Promise<boolean> {
    if (this.denyClaim) return false;
    const r = this.rows.find(x => x.id === id && x.status === 'watching');
    if (!r) return false;
    r.status = 'buying';
    return true;
  }
  async reschedule(a: Parameters<WatchStore['reschedule']>[0]): Promise<boolean> {
    const r = this.rows.find(x => x.id === a.id && x.status === a.from);
    if (!r) return false;
    r.status = 'watching'; r.checkCount = a.checkCount;
    r.nextCheckAt = r.firstSeenAt + a.nextOffsetSec;
    r.firstSeenPrice = r.firstSeenPrice ?? a.firstSeenPrice;
    r.history.push(a.item);
    return true;
  }
  async finish(a: Parameters<WatchStore['finish']>[0]): Promise<HistoryItem[] | null> {
    const r = this.rows.find(x => x.id === a.id && x.status === a.from);
    if (!r) return null;
    r.status = a.status; r.reason = a.reason; r.checkCount = a.checkCount;
    r.firstSeenPrice = r.firstSeenPrice ?? a.firstSeenPrice;
    r.fill = a.fill;
    if (a.item) r.history.push(a.item);
    return r.history;
  }
  async cancelMatching(a: Parameters<WatchStore['cancelMatching']>[0]) {
    const hit = this.rows.filter(r =>
      r.status === 'watching' && r.w.proxyWallet === a.proxyWallet &&
      r.w.conditionId === a.conditionId && r.w.tokenId === a.tokenId && r.w.targetTs <= a.sellTs);
    for (const r of hit) { r.status = 'abandoned'; r.reason = a.reason; r.history.push(a.item); }
    return hit.map(r => ({ proxyWallet: r.w.proxyWallet, sourceTradeKey: r.w.sourceTradeKey }));
  }
  async failInterrupted(item: HistoryItem) {
    const hit = this.rows.filter(r => r.status === 'buying');
    for (const r of hit) { r.status = 'abandoned'; r.reason = 'interrupted_during_buy'; r.history.push(item); }
    return hit.map(r => ({ proxyWallet: r.w.proxyWallet, sourceTradeKey: r.w.sourceTradeKey }));
  }
  async finalizeSignal(proxyWallet: string, key: string, acted: boolean, skip: string | null) {
    this.signals.set(`${proxyWallet}|${key}`, { acted, skip });
  }
  sig(w: string, key: string) { return this.signals.get(`${w}|${key}`); }
}

// ─── Harness ───────────────────────────────────────────────────────

const W = '0xabc0000000000000000000000000000000000001';
const TARGET = 0.40;                    // target's fill
const ABS_CAP = 0.05;                   // = SIMPLE_MAX_SLIPPAGE → 12.5% of 0.40
const MIN = 0.10;
const MAX = 0.85;

interface Rig {
  store: MemStore;
  deps: RecheckDeps;
  asks: { v: number | null | ((clock: number) => number | null) };
  buys: Array<{ price: number; limit: number }>;
  nextBuy: { v: BuyOutcome | (() => BuyOutcome) | 'throw' };
  askCalls: { n: number };
}

function rig(): Rig {
  const store = new MemStore();
  const asks: Rig['asks'] = { v: 0.50 };
  const buys: Rig['buys'] = [];
  const nextBuy: Rig['nextBuy'] = { v: { kind: 'filled', fillPrice: 0.44, shares: 4.5, usdSpent: 2 } };
  const askCalls = { n: 0 };
  const deps: RecheckDeps = {
    store,
    getBestAsk: async () => {
      askCalls.n++;
      return typeof asks.v === 'function' ? asks.v(store.clock) : asks.v;
    },
    executeBuy: async (_w, price, limit) => {
      buys.push({ price, limit });
      if (nextBuy.v === 'throw') throw new Error('boom');
      return typeof nextBuy.v === 'function' ? nextBuy.v() : nextBuy.v;
    },
    maxSlippageFor: (tp) => ABS_CAP / tp,
    minPrice: MIN, maxPrice: MAX,
    log: () => {},
  };
  return { store, deps, asks, buys, nextBuy, askCalls };
}

const enq = (r: Rig, key = 'k1', over: Partial<Parameters<typeof enqueueWatch>[1]> = {}) =>
  enqueueWatch(r.deps, {
    proxyWallet: W, sourceTradeKey: key, conditionId: '0xcond', tokenId: 'tok', outcome: 'Yes',
    targetPrice: TARGET, targetSize: 10, targetTs: 1000, capUsd: 30, capKind: 'market',
    failReason: 'above_limit_0.45', ...over,
  });

const tick = async (r: Rig, clock: number, active: string[] = [W]) => {
  r.store.clock = clock;
  await processWatchlist(r.deps, new Set(active));
};

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack}`); process.exitCode = 1; }
}

// ─── Tests ─────────────────────────────────────────────────────────

async function main() {
  console.log('Price Re-Check Engine selftest\n');
  assert.deepEqual([...RECHECK_SCHEDULE_SEC], [30, 120, 300, 480, 600]);
  assert.equal(RECHECK_TTL_SEC, 600);

  console.log('decide() — §6.3');
  const base = { targetPrice: TARGET, maxSlip: ABS_CAP / TARGET, minPrice: MIN, maxPrice: MAX };
  await test('BUY when slippage == max (boundary, float-safe)', () => {
    assert.equal(decide({ ...base, currentPrice: 0.45, firstSeenPrice: 0.50 }).action, 'BUY');
  });
  await test('BUY when price fell below target', () => {
    assert.equal(decide({ ...base, currentPrice: 0.30, firstSeenPrice: 0.50 }).action, 'BUY');
  });
  await test('WAIT when slippage above max but within +5% of first seen', () => {
    assert.equal(decide({ ...base, currentPrice: 0.46, firstSeenPrice: 0.46 }).action, 'WAIT');
    assert.equal(decide({ ...base, currentPrice: 0.52, firstSeenPrice: 0.50 }).action, 'WAIT');
  });
  await test('ABANDON when ask > first_seen × 1.05', () => {
    const d = decide({ ...base, currentPrice: 0.53, firstSeenPrice: 0.50 });
    assert.equal(d.action, 'ABANDON'); assert.equal(d.reason, 'price_moved_against_us');
  });
  await test('exactly +5% is not "against us" (strict >)', () => {
    assert.equal(decide({ ...base, currentPrice: 0.525, firstSeenPrice: 0.50 }).action, 'WAIT');
  });
  await test('no price → WAIT; no reference → never ABANDON', () => {
    assert.equal(decide({ ...base, currentPrice: null, firstSeenPrice: 0.5 }).action, 'WAIT');
    assert.equal(decide({ ...base, currentPrice: 0.9, firstSeenPrice: null }).action, 'WAIT');
  });
  await test('price band is enforced on the fill price', () => {
    assert.equal(decide({ ...base, currentPrice: 0.09, firstSeenPrice: 0.5 }).action, 'WAIT');   // < min
    assert.equal(decide({ ...base, targetPrice: 0.84, maxSlip: 0.2, currentPrice: 0.90, firstSeenPrice: 0.9 }).action, 'WAIT'); // > max
  });

  console.log('\nhelpers');
  await test('isPriceUnavailableReason', () => {
    assert.ok(isPriceUnavailableReason('above_limit_0.45'));
    assert.ok(isPriceUnavailableReason('no_liquidity_at_our_price'));
    assert.ok(isPriceUnavailableReason('no orders found to match with FAK order. FAK orders are partially filled…'));
    assert.ok(!isPriceUnavailableReason('delayed_no_fill_0'));       // may still fill → never retry
    assert.ok(!isPriceUnavailableReason('not enough balance / allowance'));
    assert.ok(!isPriceUnavailableReason('zero_fill'));
    assert.ok(!isPriceUnavailableReason(undefined));
  });
  await test('parseBestAsk ignores sort order, zero-size and junk', () => {
    assert.equal(parseBestAsk({ asks: [{ price: '0.9', size: '5' }, { price: '0.42', size: '3' }, { price: '0.41', size: '0' }, { price: 'x', size: '1' }] }), 0.42);
    assert.equal(parseBestAsk({ asks: [] }), null);
    assert.equal(parseBestAsk(null), null);
    assert.equal(parseBestAsk({}), null);
  });

  console.log('\nengine flows (fake clock)');
  await test('enqueue: records first-seen ask, marks signal price_watch, dedupes', async () => {
    const r = rig();
    assert.equal(await enq(r), true);
    assert.equal(r.store.rows[0].firstSeenPrice, 0.50);
    assert.deepEqual(r.store.sig(W, 'k1'), { acted: false, skip: 'price_watch' });
    assert.equal(await enq(r), false);                           // same trade
    assert.equal(await enq(r, 'k2'), false);                     // same market already parked
  });

  await test('nothing happens before T+30s', async () => {
    const r = rig(); await enq(r);
    await tick(r, 29);
    assert.equal(r.askCalls.n, 1);                               // only the enqueue read
  });

  await test('recovers at T+2m → BUY at limit = target+cap, books fill', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.47; await tick(r, 30);                          // still too dear → wait
    assert.equal(r.store.rows[0].status, 'watching');
    assert.equal(r.store.rows[0].nextCheckAt, 120);
    r.asks.v = 0.44; await tick(r, 120);                         // back in range
    assert.equal(r.buys.length, 1);
    assert.equal(r.buys[0].limit, 0.45);
    const row = r.store.rows[0];
    assert.equal(row.status, 'bought'); assert.equal(row.fill?.price, 0.44);
    assert.equal(row.history.length, 3);
    assert.deepEqual(r.store.sig(W, 'k1'), { acted: true, skip: null });
  });

  await test('price runs away (>+5% of first seen) → ABANDON, never buys', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.53; await tick(r, 30);
    assert.equal(r.store.rows[0].status, 'abandoned');
    assert.equal(r.store.rows[0].reason, 'price_moved_against_us');
    assert.equal(r.buys.length, 0);
    assert.equal(r.store.sig(W, 'k1')?.skip, 'recheck_abandoned:price_moved_against_us');
  });

  await test('TTL: 5 re-checks then max_time_exceeded, full history kept', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.48;
    for (const t of [30, 120, 300, 480]) { await tick(r, t); assert.equal(r.store.rows[0].status, 'watching', `t=${t}`); }
    await tick(r, 600);
    const row = r.store.rows[0];
    assert.equal(row.status, 'abandoned'); assert.equal(row.reason, 'max_time_exceeded');
    assert.equal(row.history.length, 6);                         // initial + 5 re-checks
    assert.deepEqual(row.history.map(h => h.n), [0, 1, 2, 3, 4, 5]);
    assert.equal(r.askCalls.n, 6);
    assert.equal(r.buys.length, 0);
  });

  await test('final check (T+10m) still buys if price is acceptable', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.48;
    for (const t of [30, 120, 300, 480]) await tick(r, t);
    r.asks.v = 0.43; await tick(r, 600);
    assert.equal(r.store.rows[0].status, 'bought');
  });

  await test('late cycle skips slots already passed (no catch-up burst)', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.48; await tick(r, 125);                         // slept through the 120s slot
    assert.equal(r.store.rows[0].checkCount, 2);
    assert.equal(r.store.rows[0].nextCheckAt, 300);
    assert.equal(r.askCalls.n, 2);                               // one check, not two
  });

  await test('processed beyond TTL+grace → abandoned WITHOUT a check or buy', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.43; await tick(r, 700);
    assert.equal(r.store.rows[0].reason, 'max_time_exceeded');
    assert.equal(r.buys.length, 0); assert.equal(r.askCalls.n, 1);
  });

  await test('buy no_fill keeps watching; later re-check buys', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.44; r.nextBuy.v = { kind: 'no_fill', reason: 'above_limit_0.45' };
    await tick(r, 30);
    assert.equal(r.store.rows[0].status, 'watching'); assert.equal(r.store.rows[0].nextCheckAt, 120);
    r.nextBuy.v = { kind: 'filled', fillPrice: 0.45, shares: 4, usdSpent: 1.8 };
    await tick(r, 120);
    assert.equal(r.store.rows[0].status, 'bought'); assert.equal(r.buys.length, 2);
  });

  await test('buy no_fill on the final slot → abandoned', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.48;
    for (const t of [30, 120, 300, 480]) await tick(r, t);
    r.asks.v = 0.44; r.nextBuy.v = { kind: 'no_fill', reason: 'no_liquidity_at_our_price' };
    await tick(r, 600);
    assert.equal(r.store.rows[0].reason, 'max_time_exceeded');
  });

  await test('blocked (guard now fails) → abandoned with that reason', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.44; r.nextBuy.v = { kind: 'blocked', reason: 'already_open_for_target' };
    await tick(r, 30);
    assert.equal(r.store.rows[0].reason, 'already_open_for_target');
    assert.equal(r.store.sig(W, 'k1')?.skip, 'recheck_abandoned:already_open_for_target');
  });

  await test('hard error or thrown exception → abandoned, never retried', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.44; r.nextBuy.v = { kind: 'error', reason: 'not enough balance' };
    await tick(r, 30);
    assert.equal(r.store.rows[0].status, 'abandoned');
    await tick(r, 120); assert.equal(r.buys.length, 1);

    const r2 = rig(); await enq(r2);
    r2.asks.v = 0.44; r2.nextBuy.v = 'throw';
    await tick(r2, 30);
    assert.equal(r2.store.rows[0].status, 'abandoned');
    assert.match(r2.store.rows[0].reason ?? '', /^buy_failed:boom/);
  });

  await test('at-most-once: losing the watching→buying claim means NO order', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.44; r.store.denyClaim = true;
    await tick(r, 30);
    assert.equal(r.buys.length, 0);
  });

  await test('target paused/removed → abandoned, no book read, no buy', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.44; await tick(r, 30, []);
    assert.equal(r.store.rows[0].reason, 'target_inactive');
    assert.equal(r.buys.length, 0); assert.equal(r.askCalls.n, 1);
  });

  await test('book unreadable at T+0: first good read becomes the reference and cannot abandon', async () => {
    const r = rig(); r.asks.v = null; await enq(r);
    assert.equal(r.store.rows[0].firstSeenPrice, null);
    r.asks.v = 0.60; await tick(r, 30);                          // baseline set here
    assert.equal(r.store.rows[0].status, 'watching');
    assert.equal(r.store.rows[0].firstSeenPrice, 0.60);
    r.asks.v = 0.66; await tick(r, 120);                         // > 0.60 × 1.05
    assert.equal(r.store.rows[0].reason, 'price_moved_against_us');
  });

  await test('empty book on a re-check → WAIT (not abandon, not buy)', async () => {
    const r = rig(); await enq(r);
    r.asks.v = null; await tick(r, 30);
    assert.equal(r.store.rows[0].status, 'watching'); assert.equal(r.buys.length, 0);
  });

  await test('target SELL cancels the watch (only trades not newer than the sell)', async () => {
    const r = rig(); await enq(r);                               // targetTs = 1000
    assert.equal(await cancelWatches(r.deps, { proxyWallet: W, conditionId: '0xcond', tokenId: 'tok', sellTs: 999, reason: 'target_sold' }), 0);
    assert.equal(await cancelWatches(r.deps, { proxyWallet: W, conditionId: '0xcond', tokenId: 'tok', sellTs: 1005, reason: 'target_sold' }), 1);
    assert.equal(r.store.rows[0].reason, 'target_sold');
    assert.equal(r.store.sig(W, 'k1')?.skip, 'recheck_abandoned:target_sold');
    r.asks.v = 0.44; await tick(r, 30); assert.equal(r.buys.length, 0);
  });

  await test('crash recovery: rows stuck in buying are abandoned, never re-bought', async () => {
    const r = rig(); await enq(r);
    await r.store.claimBuy(1);                                   // simulate crash after claim
    assert.equal(await recoverInterrupted(r.deps), 1);
    assert.equal(r.store.rows[0].reason, 'interrupted_during_buy');
    r.asks.v = 0.44; await tick(r, 30); assert.equal(r.buys.length, 0);
  });

  await test('a market can be parked again once the previous watch has ended', async () => {
    const r = rig(); await enq(r);
    r.asks.v = 0.53; await tick(r, 30);                          // abandoned
    assert.equal(await enq(r, 'k2'), true);
  });

  console.log('\nPgWatchStore (SQL contract — no database needed)');
  const item: HistoryItem = { n: 1, at: 'x', elapsed_s: 30, price: 0.4, slippage: 0, max_slip: 0.125, decision: 'WAIT' };
  const nw: NewWatch = {
    proxyWallet: W, sourceTradeKey: 'k', conditionId: 'c', tokenId: 't', outcome: 'Yes', targetPrice: 0.4,
    targetSize: 10, targetTs: 1000, firstSeenPrice: null, capUsd: 30, capKind: 'market',
    firstSlotSec: 30, ttlSec: 600, history: [item],
  };
  await test('every statement binds exactly the placeholders it uses', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const q: QueryFn = async (sql, params = []) => { calls.push({ sql, params }); return { rows: [] }; };
    const st = new PgWatchStore(q);
    await st.insert(nw);
    await st.listDue(5);
    await st.claimBuy(1);
    await st.reschedule({ id: 1, from: 'watching', checkCount: 1, nextOffsetSec: 120, firstSeenPrice: 0.5, item });
    await st.finish({ id: 1, from: 'buying', status: 'bought', reason: 'filled', checkCount: 2, firstSeenPrice: 0.5, fill: { price: 0.44, shares: 4, usd: 2 }, item });
    await st.finish({ id: 1, from: 'watching', status: 'abandoned', reason: 'x', checkCount: 2, firstSeenPrice: null, fill: null, item: null });
    await st.cancelMatching({ proxyWallet: W, conditionId: 'c', tokenId: 't', sellTs: 5, reason: 'target_sold', item });
    await st.failInterrupted(item);
    await st.finalizeSignal(W, 'k', false, 'price_watch');
    assert.equal(calls.length, 9);
    for (const c of calls) {
      const nums = [...c.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
      const max = Math.max(0, ...nums);
      assert.equal(max, c.params.length, `param count mismatch in: ${c.sql.slice(0, 60)}`);
      for (let i = 1; i <= max; i++) assert.ok(nums.includes(i), `$${i} unused in: ${c.sql.slice(0, 60)}`);
      for (const p of c.params) assert.notEqual(p, undefined, 'undefined param (pg would send NULL silently)');
    }
  });
  await test('listDue maps pg-style rows (strings for ids) to numbers', async () => {
    const q: QueryFn = async () => ({ rows: [{
      id: '7', proxy_wallet: W, source_trade_key: 'k', condition_id: 'c', token_id: 't', outcome: 'Yes',
      target_price: 0.4, target_size: 10, target_ts: 1000, first_seen_price: null, cap_usd: 3, cap_kind: 'event',
      check_count: 1, elapsed_s: 31.2,
    }] });
    const [w] = await new PgWatchStore(q).listDue(1);
    assert.deepEqual(w, {
      id: 7, proxyWallet: W, sourceTradeKey: 'k', conditionId: 'c', tokenId: 't', outcome: 'Yes',
      targetPrice: 0.4, targetSize: 10, targetTs: 1000, firstSeenPrice: null, capUsd: 3, capKind: 'event',
      checkCount: 1, elapsedSec: 31.2,
    });
  });
  await test('insert/claim/finish report "no row" correctly', async () => {
    const empty = new PgWatchStore(async () => ({ rows: [] }));
    assert.equal(await empty.insert(nw), false);
    assert.equal(await empty.claimBuy(1), false);
    assert.equal(await empty.finish({ id: 1, from: 'watching', status: 'abandoned', reason: 'x', checkCount: 1, firstSeenPrice: null, fill: null, item: null }), null);
    const one = new PgWatchStore(async () => ({ rows: [{ id: 1, history: [item] }] }));
    assert.equal(await one.insert(nw), true);
    assert.equal(await one.claimBuy(1), true);
    assert.deepEqual(await one.finish({ id: 1, from: 'watching', status: 'abandoned', reason: 'x', checkCount: 1, firstSeenPrice: null, fill: null, item: null }), [item]);
  });
  await test('wallets are lower-cased before they hit the DB', async () => {
    const seen: unknown[][] = [];
    const st = new PgWatchStore(async (_s, p = []) => { seen.push(p); return { rows: [] }; });
    await st.finalizeSignal('0xABCDEF', 'k', true, null);
    assert.equal(seen[0][0], '0xabcdef');
    const r = rig(); r.deps.store = new PgWatchStore(async (_s, p = []) => { seen.push(p); return { rows: [] }; });
    await cancelWatches(r.deps, { proxyWallet: '0xABC', conditionId: 'c', tokenId: 't', sellTs: 1, reason: 'target_sold' });
    assert.equal(seen[seen.length - 1][0], '0xabc');
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
