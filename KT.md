# pAlpha — Knowledge Transfer (KT)

Audience: engineer taking ownership of the project, goal = **make the copy-trading bot profitable**.
Based on a read of the repo (code + `flow.md`, `CLAUDE.md`, `profitability-analysis.md`).

---

## 1. What the product is

A bot that detects trades of chosen Polymarket wallets by **HTTP polling** (no websocket), and mirrors them via the Polymarket CLOB. A dashboard shows results. Postgres is the only link between research, execution and UI.

**Stack:** TypeScript (ESM) monorepo · Node + `tsx` · Express · PostgreSQL · Next.js 14 · `@polymarket/clob-client-v2` · `ethers` v5 · pm2 in prod.

## 2. File map — what does what

### 2.1 Core runtime (this is where the money is made or lost)

| File | Role |
|---|---|
| `packages/core/src/cli/simple-copy-trader.ts` (~1,980 lines) | **THE production bot.** Poll targets → filter → order → persist → reconcile |
| `packages/core/src/api-server.ts` (~970 lines) | The real Express API (the `cli/api-server.ts` is a 1-line shim) |
| `packages/core/src/services/ctf-resolution.ts` | Reads `payoutNumerators` on-chain (Gnosis CTF) → fixes the "prop markets never resolve" gap |
| `packages/core/src/services/price-recheck.ts` | **Price Re-Check Engine** — parks unfillable buys for 10 min, re-checks at 30s/2m/5m/8m/10m (see `PRICE_RECHECK.md`) |
| `packages/core/src/db/migrations/007_price_watchlist.sql` | `price_watchlist` table used by the engine |
| `packages/core/src/cli/selftest-price-recheck.ts` | Offline tests for the engine (`npm run selftest:recheck`) |
| `packages/core/src/db/pool.ts` | Single `pg` pool (max 10), SSL auto for non-localhost |
| `packages/core/src/config.ts` | `.env` loading + defaults for non-bot code |

### 2.2 Research CLIs (`packages/core/src/cli/`)

| Group | Files |
|---|---|
| Trader ingest | `ingest-wallet-trades.ts` (wallet-first, use this), `scan-trades-v2.ts` (market-first), `scan-trades-onchain*.ts`, `scan-events-v2.ts`, `scan-markets.ts`, `scan-prices-v2.ts`, `wallet-reconstruct.ts` |
| Screening & backtest | `screen-price-band.ts`, `backtest-firstentry-all.ts`, `run-backtest.ts`, `find-targets.ts`, `validate-targets.ts`, `probe-wallet.ts` |
| Scoring (legacy) | `score-traders.ts`, `score-alpha.ts`, `show-leaderboard.ts`, `show-alpha-leaderboard.ts` |
| Target management | `manage-targets.ts` (`npm run copy:add`) |
| Reconcile / maintenance | `reconcile-positions.ts`, `reconcile-fills.ts`, `audit-inflated-fills.ts`, `backfill-*.ts`, `resolve-onchain.ts`, `redeem-*.ts`, `snapshot-positions.ts` |
| Ops | `check-db.ts`, `db-query.ts` (SELECT-only), `monitor.ts`, `dump-*-30d.ts`, `migrate.ts` |

### 2.3 Legacy / not in production path — don't "fix" bugs here

`trading/live.ts`, `trading/paper.ts`, `services/copy-trader.ts`, `services/signal-detector.ts`, `cli/paper-trader.ts`, `cli/live-trader.ts`, `services/alpha-scorer.ts`, `trader-scorer.ts`. Superseded by `simple-copy-trader.ts`.

### 2.4 Other packages

- `packages/dashboard` — pages: Overview, Positions, Traders, Signals, Backtests, Trader-vs-Us; `lib/api.ts` (fetch w/ cookies), `lib/useApi.ts` (30 s polling), `lib/route-guard.tsx`.
- `packages/categories/{sports,weather}` — keyword/tag classifiers (`classifier.ts`, `config.ts`).
- `packages/mcp-server` — MCP tools in read/write/execute tiers (`get_status`, `add_target`, `kill_switch`, …). Optional.
- `scripts/` — `deploy.sh`, `v3-schema.sql`, DB setup shell scripts (need `~/.pg-creds*`).
- `polymarket_sports_traders_winrate_70plus.csv` — 99 traders scraped from a leaderboard (win-rate ≥70%).
- `Code_Hardening_PPM.docx` — a PPM-style description of hardening measures. **Partly describes the old paper engine** (60 s poll, ±1 s dedup) and does not reflect the current bot.

## 3. Database (key tables)

| Table | Purpose |
|---|---|
| `copy_targets` | Control surface: wallets + `status` (active/paused/stopped) + comma-separated `category`. Bot re-reads every cycle |
| `copy_signals` | Audit log **and** dedup lock (`UNIQUE(proxy_wallet, source_trade_key)`) — every target trade seen + `skip_reason` |
| `live_positions` | Our real positions; bot state lives here (`metadata.token_id` is required by the API) |
| `accounts` | `mode='live'` row: `balance` + `updated_at` (= bot heartbeat) |
| `markets`/`events` | `resolved_to`, `events.category` drives category filter |
| `trades`, `traders`, `trader_category_stats`, `backtest_runs` | Research only |

Schema authority: `scripts/v3-schema.sql` **plus** `migrations/006_mirror_mode.sql` (adds `proceeds_usd`, `exit_count`; not in v3-schema.sql) **plus** `007_price_watchlist.sql` if the re-check engine is used. Note there's no `005`.

## 4. How the bot works (verified against current code)

Every `SIMPLE_POLL_INTERVAL` (15 s) per active target:

1. `GET data-api /trades?user=<wallet>` (retry/backoff), keep last `SIMPLE_TRADE_WINDOW` (600 s), drop seen keys.
2. **Exit pass (SELLs first):** match to our open position by `{target, conditionId, token}` → sell. Mirror mode: sell the same *fraction* the target sold.
3. **Entry pass (BUYs):** `claimTrade()` inserts into `copy_signals` (unique key) = at-most-once. Filters in order: category → already open → max positions → min price → max price → (mirror) per-market/per-event USD caps.
4. **Order:** `getTickSize` + `getNegRisk`, then `createAndPostMarketOrder(..., 'FAK')` **with a price cap** `target price + SIMPLE_MAX_SLIPPAGE` (default 5¢, rounded to tick).
5. `delayed` status ≠ failure → `resolveDelayedFill()` polls Data API + `getOrder` up to ~20 s.
5b. *(if `SIMPLE_RECHECK_ENABLED=true`)* a buy that failed because the price ran away is parked in `price_watchlist`; each cycle `processWatchlist()` re-checks due rows and may buy later. A target SELL on that market cancels the watch.
6. Persist to `live_positions`; finalize `copy_signals.acted_on`.
7. Every 60 s sync USDC balance; every 30 min `reconcileResolvedPositions()` (Data API positions → CTF on-chain → CLOB fallback).

**Sizing:** flat `SIMPLE_POSITION_SIZE` normally; with `SIMPLE_MIRROR_MODE=true` a tier ladder maps the target's stake → our stake (default $1…$10), capped by `SIMPLE_MAX_PER_MARKET_USD` (30) and `SIMPLE_MAX_PER_EVENT_USD_SPORTS` (3).

### ⚠️ Docs vs code — what changed since `flow.md`

`flow.md` / `profitability-analysis.md` are partly **stale**. The code already contains:
- A **fill-price limit** (`SIMPLE_MAX_SLIPPAGE`, default 0.05) — the "#1 recommendation" in the profitability analysis is *partly* implemented, but as a **price-capped FAK**, not a resting limit order.
- **Mirror mode**, tier sizing, per-market / per-event caps, esports detection, partial-exit proportional selling.
- **On-chain resolution** (`ctf-resolution.ts`) — the "resolution gap" is addressed in the bot's reconcile; confirm it's also wired into the *backtest* path.
- File is ~2,200 lines, not 1,281.
- **Price Re-Check Engine** (new, off by default) — see `PRICE_RECHECK.md`.

Verify these in prod before drawing conclusions from the 30-day post-mortem: that data may predate the slippage cap.

## 5. Profitability — what the evidence says

From `profitability-analysis.md` (3,210 trades, $1 size, 30 days):

- Actual **−3.95% ROI**; same trades at the *target's* price **+16%** → **~20 pts lost to execution** (mean +5.1¢ over target price, ≈12.6% of cost).
- Slippage is **flat across latency buckets** → it's the **spread we cross as taker**, not delay. Don't invest in speed.
- Results **not statistically significant** (CI straddles 0). Need ≥1,000 settled trades per change.
- **Backtest mis-ranked traders**: quickql approved (live −17.7%), RN1 rejected (live significant edge at target price).
- 134 trades where our fill was out of band lost $53 of the $127 total loss — now addressed by the slippage cap.

My additional observations from the code:
- The bot has **no stop-loss, take-profit, time exit, daily loss limit or kill switch** (the hardening doc's "daily loss limit"/"time buffer" belong to the old paper engine). Add a portfolio-level circuit breaker before scaling.
- `maxPositions=3`, `$2` size → capital-starved and very high variance; statistical conclusions will take a long time.
- Event cap `$3` for sports with `$1` tiers means most "mirror" signals are tiny; fees/minimum-order effects matter at this size.
- `.env` price band discrepancy noted in the analysis (0.60–0.98 locally) — check prod `.env` before restart.
- Binary Yes/No stored price ambiguity (18.5% of trades) makes backtests unreliable for those; prefer `--team-only` until fixed.

## 6. Recommended plan (ordered)

**Phase 0 — Measure (1–2 days, no code risk)**
1. Pull skip-reason distribution and fill-vs-target slippage *since the slippage cap deployed* (`copy_signals` ⟕ `live_positions`). Establish the new baseline.
2. Compute fill rate under the 5¢ cap (`buy_failed:above_limit_*`) — that is the cost of the guard.

**Phase 1 — Execution edge**
3. Replace/augment FAK-with-cap by a **resting limit at target price (+1–2 ticks)**, TTL 60–120 s, then cancel; log `limit_no_fill`. Maker orders also avoid taker fees where applicable.
4. **Liquidity gate:** read `/book` before ordering; skip if spread > N¢ or depth < order size.
5. Add **adverse-selection tracking**: price at +1/5/30 min after our fill vs target fill.

**Phase 2 — Trader selection**
6. Wire CTF on-chain resolution into the backtest; re-run `backtest:firstentry` for all 99 CSV wallets with coverage ≥80%.
7. Rebuild the backtest to include **execution cost** (target price + observed spread) and a **bootstrap CI**; select traders with lower-bound > 0.
8. Re-validate against the live 30-day results (RN1 vs quickql should reconcile).
9. Add trader-quality filters: buys/market, avg price, trades/day (reject HFT), % exits (reject active managers).

**Phase 3 — New strategies**
10. **Consensus signals:** only copy when ≥2 independent good wallets enter the same outcome within a window.
11. **Category specialization:** per-trader/category ROI from `trader_category_stats`; copy only categories with proven edge.
12. **Size by edge/confidence** (fractional Kelly with a cap) instead of target-stake ladders.
13. **Fade/avoid:** use `copy_signals` history to blacklist markets/traders where our realized result < target's.
14. Paper-trade each new strategy in parallel (`paper_positions`) before enabling live.

**Phase 4 — Risk & ops**
15. Daily loss limit + kill switch (DB flag read each cycle), per-target exposure caps, alerting on stale heartbeat.
16. Unit tests for `tierBuyUsd`, `toTick`, `buyLimitPrice`, fill-resolution parsing (there's a `selfTestSizing()` only).
17. Fix the stale-docs problem: update `flow.md`, remove dead engines or move to `/legacy`.

**Rule:** change one variable at a time; judge on ≥1,000 settled trades; don't raise size until a positive edge is shown.

## 7. Risks & gotchas

- Fund **`POLY_FUNDER`**, not the EOA.
- Env read once; category cache never invalidated → restart bot.
- Keep `resolveDelayedFill()` in any refactor (otherwise untracked live positions).
- Entries FAK; exits FOK (sell unfilled isn't retried when slippage-sell is set).
- Two unique indexes on `copy_signals`; code swallows SQLSTATE 23505 deliberately.
- `trades` table was truncated in prod; re-ingest a wallet before backtests.
- Data API: `limit=1000`, offset ≤ ~3000, `before/after` ignored → only recent history.
- Prod runs compiled `dist/`; `src` edits do nothing until `tsc`.
- `package.json` root lists legacy `@polymarket/clob-client` while core uses `-v2`; `express` v5 at root vs v4 in core — dependency drift worth cleaning.
- Hardcoded `trades_2026_*` partitions end at 2027-03 (default partition exists).
- Repo contains `scripts/import-data.sh` reference (`import:data`) that doesn't exist.
- `Code_Hardening_PPM.docx` describes controls that no longer exist in the live bot — don't present it externally as current.

## 8. Quick KT checklist for a new engineer

1. Read `flow.md` §1–8, then `simple-copy-trader.ts` top to bottom (`CONFIG`, `processTarget`, `placeMarketBuy`, `resolveDelayedFill`, `reconcileResolvedPositions`).
2. Run local per README, add a target with `--paused`, watch `copy_signals`.
3. Run the research chain on one wallet.
4. Read `profitability-analysis.md`, then re-measure with current code (Phase 0).
