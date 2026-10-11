# Price Re-Check Engine — implementation notes

## 1. Where each piece lives

| Spec item | File | What was added |
|---|---|---|
| Watchlist storage, 10-min TTL, full history | `packages/core/src/db/migrations/007_price_watchlist.sql` (**new**) | Table `price_watchlist` (+ unique indexes: one watch per trade, one live watch per target/market/token) |
| §6.2 schedule, §6.3 decision logic, §6.4 TTL expiry, history log | `packages/core/src/services/price-recheck.ts` (**new**) | `decide()`, `enqueueWatch()`, `processWatchlist()`, `cancelWatches()`, `recoverInterrupted()`, `PgWatchStore`. No imports — DB, order book and order placement are injected |
| Trigger (price unavailable → watchlist instead of skip) | `cli/simple-copy-trader.ts`, entry pass, `if (result.failed)` branch | Parks the signal when the failure reason means "price not available" |
| Re-check buy (guards → size → order → book the fill) | `cli/simple-copy-trader.ts`, new `executeWatchBuy()` + `applyBuyFill()` | `applyBuyFill` is the old inline "persist fill" code moved verbatim so both paths book fills identically |
| Run due re-checks | `cli/simple-copy-trader.ts`, `processCycle()` | Calls `processWatchlist()` after the target loop |
| Stop watching when the target exits | `cli/simple-copy-trader.ts`, exit pass | `cancelWatches()` on any target SELL in that market |
| Config / startup | `cli/simple-copy-trader.ts` `CONFIG.recheck`, `initRecheck()`, startup log | Flag, optional override, table check, crash recovery |
| Offline test | `cli/selftest-price-recheck.ts` (**new**) → `npm run selftest:recheck` | 32 checks (decision logic, state machine, SQL placeholder contract), no DB / network |
| Dashboard labels | `packages/dashboard/src/components/ui/stat-badge.tsx` | Plain-English labels/tooltips for `price_watch` and `recheck_abandoned:*` on the Signals / Trader-vs-Us pages |
| Env docs | `.env.example`, root `package.json` | 2 env vars, 1 script |

## 2. Apply

```bash
cd p-alpha
# (already integrated if you are using the zip)
npm run selftest:recheck                 # expect: 32 checks passed
npm run db:migrate                       # applies 007 (or: psql "$DATABASE_URL" -f packages/core/src/db/migrations/007_price_watchlist.sql)
```

Enable (restart the bot — env is read once):
```env
SIMPLE_RECHECK_ENABLED=true
# SIMPLE_RECHECK_MAX_SLIP_REL=0   # leave 0: re-checks accept exactly what the first attempt would
```
The startup log prints `Price re-check: ON (...)`. If the table is missing the bot logs `[recheck] DISABLED` and keeps trading normally.

## 3. How it behaves

1. Entry BUY is sent as before (FAK with price cap = target + `SIMPLE_MAX_SLIPPAGE`). **That is T+0.**
2. If it fails with *"price not available"* (`above_limit_*`, `no_liquidity_at_our_price`, "no orders found to match"), the signal is parked; `copy_signals.skip_reason = 'price_watch'`; best ask at that moment = `first_seen_price`.
3. Each poll cycle, rows whose slot is due are checked (30 s, 2 m, 5 m, 8 m, 10 m after first sighting):
   - `slippage = (ask − target) / target`; `max_slip = SIMPLE_MAX_SLIPPAGE / target` → **BUY** if `slippage ≤ max_slip` and the ask is inside the price band
   - else `ask > first_seen × 1.05` → **ABANDON** `price_moved_against_us`
   - else **WAIT**; on the 5th check a WAIT becomes **ABANDON** `max_time_exceeded`
4. A BUY re-runs the guards (already open, max positions, per-market/event cap), re-sizes, and sends a capped FAK at `min(maxPrice, target × (1 + max_slip))`. If it still doesn't fill, the watch continues.
5. Terminal states are mirrored to `copy_signals`: bought → `acted_on=true`; abandoned → `skip_reason='recheck_abandoned:<reason>'`. The full check history (`price_watchlist.history`) is also printed to the log.

Abandon reasons you will see: `price_moved_against_us`, `max_time_exceeded`, `target_sold`, `target_inactive`, `already_open_for_target`, `at_max_positions`, `at_max_per_market`, `at_max_per_event`, `buy_failed:<…>`, `interrupted_during_buy`.

## 4. Decisions I made where the spec was open

- **`first_seen_price`** = best ask when the price was first found unavailable (T+0), not the target's price. If that read fails, the first good re-check sets it and cannot itself abandon.
- **`max_slippage_for(target)`** = `SIMPLE_MAX_SLIPPAGE / target_price` (relative), so a re-check accepts exactly what the original limit would. Override with `SIMPLE_RECHECK_MAX_SLIP_REL`.
- **`get_price`** = lowest ask from `GET /book?token_id=…` (does not rely on `/price`'s side semantics or on book sort order).
- **Not retried (by design):** `delayed_no_fill_*` (the order may still match later → would double-buy), balance/allowance errors, 4xx.
- **At-most-once buy:** a row goes `watching → buying` with a guarded UPDATE before any order. A row left in `buying` by a crash is **abandoned on restart, never retried** (it may have filled — check the wallet).
- **Scheduling granularity:** checks run inside the 15 s poll cycle, so each fires up to ~15 s late. Slots slept through are skipped (no catch-up burst). A row found > TTL + 60 s old is abandoned without a check.
- **Extra safety rules beyond the spec:** do not park a signal if the target already SOLD that market in the same poll batch (the cancel hook would never fire); abandon when the target SELLs that market later; abandon when the target is paused/removed; abandon when a guard (position cap etc.) now blocks the buy; the fill must stay inside `[SIMPLE_MIN_PRICE, SIMPLE_MAX_PRICE]`.
- **Mirror mode:** at most one live watch per {target, market, token}; sizing is recomputed at buy time against the current caps.

## 5. One existing bug fixed on the way (separate, easy to revert)

`toTick()` used a bare `Math.floor(price / tick)`. In binary floating point `0.29/0.01 = 28.999…`, so limits of 0.29, 0.57, 0.58 … were rounded **one tick low** (28 instead of 29). Added a `1e-9` guard. This also affects first-attempt buys: a few limits now sit one tick higher than before — exactly what `SIMPLE_MAX_SLIPPAGE` always intended.

## 6. Monitor it

```sql
-- outcomes
SELECT status, COALESCE(reason,'-') AS reason, count(*) FROM price_watchlist GROUP BY 1,2 ORDER BY 3 DESC;

-- re-check fills vs the target's price, and how they turned out
SELECT w.id, w.target_price, w.fill_price,
       round((w.fill_price - w.target_price)::numeric, 4) AS slip, lp.status, lp.pnl
  FROM price_watchlist w
  LEFT JOIN live_positions lp ON lp.source_trade_key = w.source_trade_key
 WHERE w.status = 'bought' ORDER BY w.closed_at DESC;

-- one watch's full history
SELECT jsonb_pretty(history) FROM price_watchlist WHERE id = 1;
```

## 7. Caveats — read before enabling on real money

- **Not run against a live Postgres or Polymarket** (none available here). Verified: strict `tsc` (real `@types/node`, stubs only for `ethers`/`clob-client`/`pg` pool) reports **0 errors**, the 32-check selftest passes, and every SQL statement was hand-checked (placeholder counts/order, partial-index `ON CONFLICT`). Do the first run with `SIMPLE_POSITION_SIZE=1` and watch the `[recheck]` log lines.
- **It can lower quality as well as raise fill rate.** Your own analysis shows ~20 pts of ROI lost to execution. A price that ran away from the target and later comes back may be telling you the target's edge was already priced in. Treat the re-check fills as a separate cohort (query above) and compare their ROI to first-attempt fills before keeping it on. The 5% "moved against us" rule and the price band are the only brakes.
- A target BUY that is parked while the same target keeps buying that market (mirror mode) records only the first sighting.
