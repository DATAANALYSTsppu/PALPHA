# pAlpha — Polymarket Copy-Trading Bot

Auto-copies the trades of chosen Polymarket wallets. A bot detects a target's
trades live and mirrors them via the CLOB; a Next.js dashboard shows performance.

## Monorepo layout (npm workspaces, ESM TypeScript)
- `packages/core` — the engine: the live bot, all CLIs, the Express API server, DB layer, backtest engine.
- `packages/dashboard` — Next.js 14 dashboard (served at palpha.6116.ai).
- `packages/categories`, `packages/mcp-server` — supporting.
- Source runs under **`tsx`** in dev, but **prod runs a compiled `dist/`** (see Deployment).

## ⚠️ Deployment (read this first — it has bitten us)
Prod = `ubuntu@ip-172-31-43-130:~/Polymarket-Bot`, branch `wip/vikash`, managed by **pm2**.

Live processes: **`palpha-api`** (runs COMPILED `packages/core/dist/cli/api-server.js` via node — NOT tsx) and **`palpha-dashboard`** (`next start -p 4000`). `simple-copy-trader` is the bot. `api-server`/`dashboard` (pm2) are stale duplicates.

**Because `palpha-api` runs compiled `dist/`, editing `packages/core/src/*.ts` does nothing until you rebuild core.** `packages/core` build = `tsc` (src → dist). Note `src/api-server.ts` → `dist/api-server.js` (real code); `src/cli/api-server.ts` is just `import '../api-server.js'`. Verify a change landed with `grep -c <symbol> packages/core/dist/api-server.js`.

**Deploy = `npm run deploy`** (`scripts/deploy.sh`): git pull → build core (`tsc`) → build dashboard (`next build`) → `pm2 restart palpha-api palpha-dashboard`. It intentionally does NOT restart the bot. Restarting `palpha-api` WITHOUT a core rebuild serves stale code.

## Key CLIs (all `npm run …`)
- `copy:add` — manage copy targets (`add-wallet <addr> --name= --category=sports[,weather] [--paused]`, `remove`, `list`, `pause-all`, `resume-all`). Category is comma-split; multiple allowed.
- `ingest:wallet -- <addrs> --apply` — fetch a wallet's trades from Polymarket Data API into `trades` (creates markets/events on demand, resolved_to from CLOB).
- `backtest:firstentry -- <csv> [--team-only] [--save]` — copy backtest over a wallet list (first in-band buy/market, hold to resolution, scored over resolved markets, coverage %). `--save` writes to `backtest_runs` for the dashboard.
- `screen:band -- <csv>` — price-band copyability screen (% of buys in $0.05–0.70, avg price, fills/market).
- `backfill:resolutions [--sports] [--apply]` — fill `markets.resolved_to` from CLOB (NOTE: fails for prop markets — see Data notes).
- `reconcile:positions [--apply]` — settle resolved open `live_positions` via Polymarket /positions + CLOB.
- `db:query -- "SELECT …"` — read-only ad-hoc SQL (refuses non-SELECT).
- Bot: `live:simple` (the live copy-trader). Env: `SIMPLE_POSITION_SIZE`, `SIMPLE_MIN_PRICE` (0.05), `SIMPLE_MAX_PRICE` (0.70), `SIMPLE_MAX_POSITIONS`. **Env is read once at startup — edit `.env` then `pm2 restart simple-copy-trader`.**

## How we evaluate traders (the copy model)
Backtest = "copy each trader's FIRST in-band ($0.05–0.70) BUY per market, hold to resolution; win iff bought outcome == `markets.resolved_to`." Trust it only when resolution **coverage** is high AND the trader has low buys/market (heavy scale-in makes first-entry unrepresentative).

**Hard-won findings:** a high public win-rate ≠ a copyable edge. It usually comes from (a) buying expensive favorites (avg 0.9+, uncopyable — you risk 90¢ to make 10¢), (b) HFT/market-making (thousands of trades/day, unfillable), or (c) active position-management (selling winners) that the hold-to-resolution copy model can't replicate. Of ~103 "good" traders screened, only **quickql** (`0x6401f2b177063ae608457ec82773758e8ee9f240`) showed a positive copyable edge (+8%, marginal). swisstony/RN1(=T1)/T2/T3/restart77 all failed (favorites, HFT, or negative first-entry edge).

## Database notes
- Managed Postgres (`polymarket_v3`), consumed via `DATABASE_URL`. **Analysis is READ-ONLY** — never run writes/deletes as part of analysis; the user runs any write CLI / SQL.
- The `trades` table (was 477M rows / 662GB, partitioned by trade_date) was **TRUNCATED** — DB is now ~4GB. The live bot does NOT read `trades` (it fetches targets' trades live from the Data API); `trades` exists only for backtesting/scoring/discovery. Re-`ingest:wallet` a wallet before backtesting it.
- Keep for the bot: `copy_targets`, `copy_signals`, `live_positions`, `markets`, `events`, `accounts`. Dashboard also reads `traders`, `trader_category_stats`, `backtest_runs`.
- **Resolution gap:** sports prop markets (spreads, O/U, in-game odd/even) resolve **on-chain only** — CLOB `/markets` returns 0.5/0.5 no-winner, Gamma is empty. `backfill:resolutions` can't fix them; would need a CTF `payoutNumerators` reader (ethers is installed, `config.polygon.rpcUrl` set).
- Prices are stored correctly per-side (verified — Yes+No sum to 1); a trader buying both sides cheap is a longshot style, not a bug.

## Live operational state / gotchas
- **quickql** is the chosen copy target. For copies to actually land: fund **`POLY_FUNDER`** (holds USDC on Polygon — it was empty at $0.33, so every order failed "not enough balance"), keep only quickql active, and pause noisy favorite/HFT targets (e.g. swisstony ~12k trades/day).
- Signal skip reasons live in `copy_signals.skip_reason`: `above_max_price`/`below_min_price` (price band, by design), `category_mismatch`, `buy_failed:unexpected_status_400` (was ~all "not enough balance").

## Git & database rules (apply to every repo under 6116)

- **GitHub account:** always `mukeshsonarji` for commit and push (`gh auth switch --user mukeshsonarji`; `.envrc` at the 6116 root exports its token). Never use another account here.
- **Branch:** all changes go on `wip/mukesh`. If it does not exist, create it from `main` (`git checkout -b wip/mukesh origin/main`). Commit and push to `wip/mukesh` only.
- **PR target is `main`.** Open the PR from `wip/mukesh` into `main` with `gh pr create --base main`. Never merge it — merging `main` is a production deploy done manually by the user.
- **Never commit or push directly to `main`.**
- **No co-author or AI attribution** in commits or PR bodies (no `Co-Authored-By`, no "Generated with Claude").
- **Databases are read-only.** `SELECT`/`EXPLAIN` only, against any environment. No writes, DDL, or migrations; hand the user the statement instead.

## Rules
- **Never push/commit/merge to `main`** — merging main = manual PROD deploy by the user. Agent work goes on `wip/mukesh`; PR into `main`. (Prod server still tracks `wip/vikash` — see Deployment.)
- Managed Postgres/Mongo/Redis — never containerize; no Docker for data services.
- No `Co-Authored-By: Claude` / "Generated with Claude" in commits or PRs.

## Price Re-Check Engine (SIMPLE_RECHECK_ENABLED)

- Off by default. Needs migration `007_price_watchlist.sql`; if the table is missing the bot logs `[recheck] DISABLED` and trades normally.
- Trigger: a copy BUY that fails with `above_limit_*` / `no_liquidity_at_our_price` / "no orders found to match" is parked (`copy_signals.skip_reason='price_watch'`) instead of dropped. `delayed_no_fill_*` is deliberately NOT retried (the order may still fill).
- Re-checks at T+30s/2m/5m/8m/10m inside the normal poll cycle (so up to ~15s late). BUY if `(ask-target)/target <= SIMPLE_MAX_SLIPPAGE/target`; abandon if ask > first-seen × 1.05 or after 10 min.
- At-most-once: `watching→buying` is a guarded UPDATE before any order. Rows left in `buying` by a crash are abandoned on restart (never retried) — check the wallet for an untracked fill.
- Terminal state is mirrored to `copy_signals` (`acted_on=true`, or `skip_reason='recheck_abandoned:<reason>'`). Full history: `price_watchlist.history`.
- Test offline: `npm run selftest:recheck`.
