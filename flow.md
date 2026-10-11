# pAlpha — End-to-End Flow (Developer Handoff)

**What this product does:** it watches chosen Polymarket wallets and automatically
mirrors their trades with our own money, then shows the results on a dashboard.

This document is meant to be read top to bottom by someone who has never seen the
repo. It covers the architecture, the exact data path of a single trade, every
table and env var that matters, the deployment topology, a runbook, and the
non-obvious behaviours that have already cost us money or debugging time.

---

## Table of contents

1. [System shape](#1-system-shape)
2. [Repository layout](#2-repository-layout)
3. [External services we depend on](#3-external-services-we-depend-on)
4. [Database schema](#4-database-schema-the-only-thing-connecting-the-three-loops)
5. [Loop 1 — Research: choosing who to copy](#5-loop-1--research-choosing-who-to-copy)
6. [Loop 2 — Execution: the bot](#6-loop-2--execution-the-bot)
7. [Loop 3 — Presentation: API + dashboard](#7-loop-3--presentation-api--dashboard)
8. [Life of a single trade](#8-life-of-a-single-trade-end-to-end)
9. [Configuration reference](#9-configuration-reference-env)
10. [Deployment](#10-deployment)
11. [Runbook](#11-runbook--common-operations)
12. [Known issues, gotchas and hard-won lessons](#12-known-issues-gotchas-and-hard-won-lessons)
13. [Glossary](#13-glossary)

---

## 1. System shape

There are **three independent loops**. They share no process, no queue and no
in-memory state — the **only** thing joining them is the Postgres database.

| Loop | Process | Cadence | Responsibility |
|---|---|---|---|
| **Research** | CLIs, run manually | ad-hoc | Decide *who* is worth copying |
| **Execution** | `simple-copy-trader` (pm2) | every 15 s | Copy the active targets with real money |
| **Presentation** | `palpha-api` + `palpha-dashboard` (pm2) | on request | Show results; add/pause/remove targets |

```
        Polymarket public APIs                       Polymarket CLOB
   (Gamma / Data API / CLOB read)                    (authenticated write)
             │        │                                      ▲
             │        │                                      │ orders
             ▼        ▼                                      │
   ┌──────────────┐  ┌────────────────────────────────────────────┐
   │ research CLIs│  │        simple-copy-trader (the bot)        │
   │ ingest/screen│  │  poll → filter → order → persist → settle  │
   │  /backtest   │  └────────────────────────────────────────────┘
   └──────┬───────┘                    │  ▲
          │ writes trades/             │  │ reads copy_targets
          │ markets/backtest_runs      ▼  │ writes live_positions, copy_signals
          │        ┌───────────────────────────────────┐
          └───────▶│   Postgres  (polymarket_v3)       │◀──────┐
                   └───────────────────────────────────┘       │
                                     ▲                          │ writes copy_targets
                                     │ reads                    │ (add / pause / stop)
                          ┌──────────┴───────────┐              │
                          │  palpha-api (Express)│──────────────┘
                          └──────────┬───────────┘
                                     │ HTTPS + SSO cookie
                          ┌──────────┴───────────┐
                          │ palpha-dashboard     │
                          │ (Next.js 14)         │
                          └──────────────────────┘
```

**The critical implication of this design:** the bot never calls the API, and the
API never calls the bot. To change what the bot does at runtime you change a row
in `copy_targets`; the bot re-reads that table on every cycle. Everything else
about the bot's behaviour (position size, price band, poll interval) is `.env` and
requires a restart.

---

## 2. Repository layout

npm workspaces, ESM TypeScript throughout.

```
packages/
  core/            ← the engine. Everything that matters lives here.
    src/
      api-server.ts        ← the Express REST API (the REAL code)
      config.ts            ← env loading + defaults for the non-bot code
      logger.ts            ← pino
      registry.ts          ← category plugin loader
      types.ts
      api/                 ← Polymarket API clients
        clob.ts  data.ts  gamma.ts  http.ts (retry/backoff)
      db/
        pool.ts            ← the single pg Pool (max 10) + query() helper
        migrate.ts
        migrations/        ← 001..004 .sql
      services/            ← legacy/alternate engine pieces
        copy-trader.ts  signal-detector.ts  trader-discovery.ts
        trader-scorer.ts  alpha-scorer.ts
      trading/
        live.ts  paper.ts  ← the OLD live/paper engines (not what runs today)
      backtest/engine.ts   ← the generic backtest engine
      cli/                 ← ~45 CLIs; see §5 and §11
        simple-copy-trader.ts  ← ★ THE BOT THAT RUNS IN PRODUCTION
        api-server.ts          ← 1-line shim: import '../api-server.js'
  dashboard/       ← Next.js 14 App Router
    src/app/(app)/  page.tsx (Overview) traders/ positions/ signals/
                    backtests/ trader-vs-us/
    src/lib/        api.ts (fetch client) useApi.ts (polling hook)
                    route-guard.tsx  db.ts  utils.ts
  categories/      ← per-category plugins (sports, weather)
  mcp-server/      ← MCP wrapper, not part of the trading path
scripts/
  deploy.sh        ← npm run deploy
  v3-schema.sql    ← the authoritative full schema
  setup-v3-db.sh  v3-run.sh  v3-reset.sh  ingest-winrate-batch.sh
```

**Two files do 90% of the work:**
[simple-copy-trader.ts](packages/core/src/cli/simple-copy-trader.ts) (1281 lines,
the entire bot) and [api-server.ts](packages/core/src/api-server.ts) (780 lines,
the entire API).

> ⚠️ `packages/core/src/cli/api-server.ts` is a one-line re-export. The real
> server is `packages/core/src/api-server.ts`. Edit the latter.

> ⚠️ `trading/live.ts`, `trading/paper.ts`, `services/copy-trader.ts` and
> `services/signal-detector.ts` are the **older** engine. They are not what runs
> in production today. `simple-copy-trader.ts` is self-contained and superseded
> them. Don't "fix" a bug by editing those.

---

## 3. External services we depend on

| Service | Base URL | Used for | Auth |
|---|---|---|---|
| **Data API** | `https://data-api.polymarket.com` | `/trades?user=` (detect target trades, confirm our fills), `/positions?user=` (reconcile) | none |
| **CLOB** | `https://clob.polymarket.com` | placing orders, `/markets/<conditionId>` (category + resolution), `/midpoint?token_id=` (unrealized P/L), `getTickSize`, `getNegRisk`, `getBalanceAllowance` | API key/secret/passphrase + EIP-712 signature for writes |
| **Gamma API** | `https://gamma-api.polymarket.com` | event/market metadata during scans | none |
| **Polygon RPC** | `https://polygon-rpc.com` (override via `POLYMARKET_RPC`) | on-chain reads (mostly unused today; needed for the resolution gap fix) | none |
| **SSO verify** | `AUTH_VERIFY_URL` (6116.ai) | dashboard login | platform name + API key |

**Data API limits that shape the design:** max `limit=1000` per request, `offset`
capped at ~3000 (so ~4000 most-recent fills per wallet, no deep history), and
`before`/`after` params are **ignored**. This is why ingestion is "recent history
only" and why the bot filters by timestamp client-side.

---

## 4. Database schema (the only thing connecting the three loops)

Managed Postgres, database `polymarket_v3`, reached via `DATABASE_URL`.
Single `pg.Pool` with `max: 10`, SSL on unless the host is localhost
([db/pool.ts](packages/core/src/db/pool.ts)).
Authoritative DDL: [scripts/v3-schema.sql](scripts/v3-schema.sql); incremental
changes in [db/migrations/](packages/core/src/db/migrations/).

### Tables the bot depends on (do not drop these)

**`copy_targets`** — the control surface. One row per wallet we may copy.
```
id, trader_id → traders.id, proxy_wallet, display_name,
category    -- comma-separated, e.g. 'sports,weather'
status      -- 'active' | 'paused' | 'stopped'   ← the bot reads ONLY 'active'
added_by, added_at, updated_at
```
A wallet can legitimately have **multiple rows** (added under different
categories); the bot unions their `category` values.

**`live_positions`** — our real positions. This *is* the bot's persistent state.
```
id, copy_target_id, market_id, event_id,   -- FKs are best-effort, may be NULL
condition_id, side, outcome,
entry_price, size_usd, shares,
status,      -- 'open' | 'closed' | 'closing' | 'expired' | 'redeem_pending'
opened_at, closed_at, exit_price, pnl,
order_id, tx_hash, source_trade_key,
metadata JSONB  -- { token_id, target_wallet, position_key, close_reason, close_order_id }
```
`token_id` lives **only in metadata**, and the API needs it to price open
positions. Don't drop it.

**`copy_signals`** — the audit log *and* the dedup lock. One row per target trade
the bot saw.
```
id, copy_target_id, trader_id, proxy_wallet, condition_id,
market_id, event_id, side, outcome, price, size,
signal_type ('copy_target'), detected_at,
acted_on BOOLEAN, skip_reason TEXT, source_trade_key TEXT
```
Two unique indexes matter enormously:
- `uq_copy_signals_wallet_trade_key (proxy_wallet, source_trade_key)` — added in
  [004](packages/core/src/db/migrations/004_copy_signals_source_trade_key.sql).
  **This is the "buy at most once, ever" lock.** NULLs are distinct in Postgres,
  so legacy rows and the old engine's rows never collide.
- `idx_copy_signals_dedup (wallet, condition, side, outcome, detected_at, price, size)`
  — a legacy index. Sibling fills in different transactions collide on it; the
  code deliberately swallows SQLSTATE 23505 rather than aborting the cycle.

**`accounts`** — `mode IN ('live','paper')`. The bot writes `balance` (real
on-chain USDC) and `updated_at` here. `updated_at` doubles as the **bot
heartbeat** shown on the dashboard.

**`markets` / `events`** — market dimension. `markets.condition_id` is unique and
is the join key everywhere. `markets.resolved_to` holds the winning **outcome
string** (`'Yes'`/`'No'` for binaries, a team/competitor name for multi-outcome).
`events.category` drives the bot's category filter.

### Tables used only for research/dashboard

- **`trades`** — historical fills for backtesting, partitioned by `trade_date`,
  deduped on `trade_key`. **Was 477M rows / 662 GB and has been TRUNCATED** (DB
  is now ~4 GB). The bot does **not** read it. Re-run `ingest:wallet` before
  backtesting any wallet.
- **`traders`**, **`trader_category_stats`** — scored trader universe
  (`composite_score` is the live column; `alpha_score` is legacy).
- **`backtest_runs`** — what `backtest:firstentry --save` writes; the Backtests page.
- **`paper_positions`**, plus `market_price_history`, `orderbook_snapshots`,
  `position_snapshots`, `execution_log`, `ingest_checkpoints`,
  `trader_alias_history`, `scan_progress` — legacy / scan-support.

---

## 5. Loop 1 — Research: choosing who to copy

No money moves here. It answers exactly one question: *had we blindly copied this
wallet under our own mechanical rules, would we have made money?*

### Step 1 — Ingest the wallet's history
```bash
npm run ingest:wallet -- 0x6401f2b1…  --apply     # dry-run without --apply
npm run ingest:wallet -- --targets --apply        # all active copy_targets
```
[ingest-wallet-trades.ts](packages/core/src/cli/ingest-wallet-trades.ts) pulls
`/trades?user=<wallet>` and writes to `trades`, creating `events`/`markets` rows
on demand from CLOB (including `resolved_to`). Deduped via
`ON CONFLICT (trade_key) DO NOTHING`, so re-runs are safe.

*Why this exists:* the other scanner (`scan:trades:v2`) is **market-first** — it
only fetches trades for markets already in our DB. A newly added target's trades
in any other market would never land. This one is **wallet-first**.

### Step 2 — Screen for copyability
```bash
npm run screen:band -- polymarket_sports_traders_winrate_70plus.csv
```
[screen-price-band.ts](packages/core/src/cli/screen-price-band.ts) reports, over
the trader's sports buys, what fraction land in the copyable **$0.05–0.70** band,
their average price, and fills/market.

*Why:* a wallet that only buys $0.90 favorites has a beautiful win-rate and zero
copyable edge — you risk 90¢ to make 10¢ and slippage eats the rest.

### Step 3 — Backtest the actual copy model
```bash
npm run backtest:firstentry -- <csv> [--team-only] [--save]
```
[backtest-firstentry-all.ts](packages/core/src/cli/backtest-firstentry-all.ts)

The model is deliberately **identical to what the bot can physically do**:

> Copy each trader's **first in-band ($0.05–0.70) BUY per market**, hold to
> resolution. Win iff the bought outcome == `markets.resolved_to`.
> Flat $10 stake: win → `$10/price − $10`, loss → `−$10`.

Two design decisions worth understanding:
- Markets with **no** `resolved_to` are **excluded**, not scored as $0 (which is
  what the generic engine does, and why low-coverage traders looked fake-terrible).
  The CLI therefore reports **coverage %** = resolved / in-band markets.
- `--team-only` keeps just multi-outcome (team-name) markets. For binary Yes/No
  markets the stored price is the *primary token's* price, not the cost of the
  side actually bought — proven by a trader whose Yes *and* No buys both averaged
  ~$0.10 — so Yes/No P&L is unreliable.

**Only trust the ROI when coverage is high AND the trader has low buys/market**
(heavy scale-in makes "first entry" unrepresentative of their real cost basis).

`--save` writes one row per trader into `backtest_runs` → the Backtests page.

### Step 4 — Promote to a copy target
Either CLI or dashboard; both end at the same row.
```bash
npm run copy:add -- add-wallet 0x… --name=quickql --category=sports [--paused]
npm run copy:add -- list | pause-all | resume-all | remove <addr>
```
or the dashboard's Add-target form → `POST /targets`.

The bot picks it up on its **next 15-second cycle**. No restart.

### What research has already told us

Of ~103 screened "high win-rate" traders, exactly **one** — `quickql`
(`0x6401f2b177063ae608457ec82773758e8ee9f240`) — showed a positive copyable edge,
and only **+8% (marginal)**.

A high public win-rate is usually **not** an edge you can copy. The three failure
modes we keep hitting:
1. **Expensive favorites** — avg entry 0.9+; uncopyable economics.
2. **HFT / market-making** — thousands of trades/day (swisstony ≈12k/day); we
   can't fill them and they'd flood the price band.
3. **Active position management** — they sell winners early; our hold-to-
   resolution model structurally cannot replicate that.

swisstony, RN1(=T1), T2, T3 and restart77 all failed on one of these.

---

## 6. Loop 2 — Execution: the bot

One self-contained file:
[simple-copy-trader.ts](packages/core/src/cli/simple-copy-trader.ts), run as
`npm run live:simple` (pm2 process name `simple-copy-trader`).

### 6.1 Where trades are detected

**There is no websocket or stream anywhere in this system.** Detection is HTTP
polling:

```
GET https://data-api.polymarket.com/trades?user=<targetWallet>&limit=1000&offset=0
```

- `fetchUserTrades()` — [line 531](packages/core/src/cli/simple-copy-trader.ts#L531)
- 10 s timeout, **3 attempts**, exponential backoff + jitter, retrying only
  `408 / 429 / 5xx` and network drops (the Data API drops connections often
  enough — `terminated` — that a single attempt silently missed trades).
- Response is newest-first; we client-side filter to
  `timestamp >= now − SIMPLE_TRADE_WINDOW` (default **600 s**).
- The window is **40× the poll interval** on purpose: heavy overlap means a few
  failed polls in a row lose nothing.

**Latency budget for a copy:** up to 15 s of poll delay + ~1–3 s CLOB matching
hold. That is the structural reason the strategy is "first entry, hold to
resolution" and not anything latency-sensitive.

### 6.2 The cycle

`main()` → `while(running) { processCycle(state); state = loadState(); sleep }`

#### (a) Refresh the target list — every cycle
`getActiveTargetWallets()` — [line 1191](packages/core/src/cli/simple-copy-trader.ts#L1191)
```sql
SELECT DISTINCT lower(proxy_wallet) FROM copy_targets
 WHERE status='active' AND proxy_wallet IS NOT NULL
```
**The DB is authoritative including when it returns zero rows** — pause-all really
means copy nothing. The `.env` `SIMPLE_TARGET_WALLETS` list is used **only** when
the query itself *throws*, so a transient DB blip doesn't blank a running copier,
but an empty table never silently resurrects old wallets.

If there are no targets at startup the bot **idles and re-checks** rather than
exiting — exiting would make pm2 crash-loop.

#### (b) Fetch + pre-filter
Fetch the target's window, drop keys already in the in-memory
`processedTradeKeys` set, sort **oldest-first**.

`tradeKey(t)` = `` `${txHash||'no_tx'}:${asset}:${price}:${size}:${timestamp}` ``
— stable per fill; txHash+asset+price+size discriminates partial fills in one tx.

#### (c) EXIT pass — target SELLs, processed first
For each new SELL, find one of *our* open positions matching
**`{targetWallet, conditionId, tokenId}`**.

> Positions are keyed per **`{target, market}` pair**. If two different targets
> bought the same market, target A selling does **not** close target B's copy.

- **No match** → record `skip_reason='not_my_position'` and move on.
- **Match** → `placeMarketSell(tokenId, shares, conditionId)` as **FOK**, then
  `UPDATE live_positions SET status='closed', exit_price, pnl,
   metadata.close_reason='target_sold'`.
- **Sell failed** → position **stays open**, `skip_reason='sell_failed:<reason>'`,
  and the trade is deliberately **left unclaimed** so the next cycle retries.

#### (d) ENTRY pass — target BUYs
First, reduce to the **earliest BUY per `{conditionId, outcome}`** in this window.
Then, for each candidate, in this exact order:

**1. Claim it atomically** — `claimTrade()` — [line 309](packages/core/src/cli/simple-copy-trader.ts#L309)
```sql
INSERT INTO copy_signals (…, source_trade_key)
VALUES (…) ON CONFLICT (proxy_wallet, source_trade_key) DO NOTHING RETURNING id
```
Zero rows returned ⇒ another cycle/process/crash-retry already took this trade ⇒
**skip**. This — not the in-memory set — is the real guarantee a BUY fires at most
once. (History: the old in-memory dedup was broken because `loadState()` rebuilt
keys in a *different format* than `tradeKey()`, so it never matched, and the same
BUY could re-fire once a position closed mid-window.)

**2. Filters**, each written to `copy_signals.skip_reason`:

| Order | Check | `skip_reason` |
|---|---|---|
| 1 | Market category ∈ target's `copy_targets.category` set | `category_mismatch` / `category_unknown` |
| 2 | Already open on this market **from this target** | `already_open_for_target` |
| 3 | Global open count < `SIMPLE_MAX_POSITIONS` | `at_max_positions` |
| 4 | `price ≥ SIMPLE_MIN_PRICE` | `below_min_price` |
| 5 | `price ≤ SIMPLE_MAX_PRICE` | `above_max_price` |

Category resolution (`fetchMarketCategory`) tries local `events.category` via
`markets.event_id` first; on a miss it fetches `CLOB /markets/<conditionId>`,
takes `tags[0]` as the category, and **upserts a minimal `events` + `markets`
pair** (with a synthetic negative `poly_event_id`) so the next lookup is local.
Allowed categories per target are cached in-process for the lifetime of the
process (`targetCategoryCache`) — **changing a target's category needs a bot
restart**, unlike changing its status.

**3. Place the order** — `placeMarketBuy()`
```ts
const [tickSize, negRisk] = await Promise.all([getTickSize(tokenId), getNegRisk(tokenId)]);
client.createAndPostMarketOrder({ tokenID, side:'BUY', amount: sizeUsd }, { tickSize, negRisk }, 'FAK');
```
- Uses **`@polymarket/clob-client-v2`**. The legacy `@polymarket/clob-client` 5.8.x
  signs with the V1 EIP-712 schema and returns `order_version_mismatch` on negRisk
  markets since Polymarket's **28 Apr 2026 CLOB v2 migration**.
- Pre-fetching `tickSize`/`negRisk` is required, else HTTP 400
  `order_version_mismatch` on non-default-tick-size and neg-risk markets.
- **FAK (fill-and-kill / IOC), not FOK, on entries.** FOK was being killed
  wholesale by the ~3 s sports matching hold — if the book moved during the hold,
  the all-or-nothing order matched nothing. FAK takes the partial fill.
  (Exits still use FOK: we want the whole position out or nothing.)

**4. Resolve a `delayed` status** — `resolveDelayedFill()` — [line 629](packages/core/src/cli/simple-copy-trader.ts#L629)

Polymarket briefly *holds* marketable orders before matching (~1 s normally, ~3 s
on sports) and returns status **`delayed`**. That order is **ACCEPTED, not
failed**, and cannot be cancelled while delayed. We poll every 2 s for up to 20 s
using two sources:
- `GET /trades?user=<POLY_FUNDER>` filtered to `{conditionId, tokenId, side,
  timestamp ≥ placedAt−10}` → sum shares, compute VWAP.
- `getOrder(orderID)` → `size_matched` + `price`; explicit
  `UNMATCHED/CANCELED/KILLED/EXPIRED/REJECTED` means a real no-fill.

*Why this matters:* before this existed the bot logged
`buy_failed:unexpected_status_delayed` on orders that **had really filled**,
leaving untracked live positions — real money in a position the system didn't
know about.

**5. Persist** — `insertOpenPosition()` writes `live_positions` (`status='open'`,
`metadata = {token_id, target_wallet, position_key}`), FKs
(`copy_target_id`/`market_id`/`event_id`) filled opportunistically via subselects
and left NULL if the dimension rows don't exist yet — the bot must never block on
missing metadata. Then `recordSignal(acted_on=true)` finalizes the claimed
`copy_signals` row via `ON CONFLICT … DO UPDATE`.

#### (e) Balance sync — throttled to once/60 s
`getBalanceAllowance({asset_type:'COLLATERAL'})` → `/1e6` (USDC is 6 decimals) →
`UPDATE accounts SET balance, updated_at WHERE mode='live'`.
This is also the **heartbeat** the dashboard reads (`lastSync`).

#### (f) Reconcile resolved positions — throttled to once/30 min
`reconcileResolvedPositions()` — [line 1108](packages/core/src/cli/simple-copy-trader.ts#L1108)

The bot only closes on `target_sold`, so a market the target **holds to
resolution** would sit `status='open'` forever. This settles them:

- `GET /positions?user=<POLY_FUNDER>&sizeThreshold=0`, keyed by
  `conditionId:outcome`.
- **Position found & `redeemable`** → `exit = currentValue/size`,
  `pnl = cashPnl`, reason `redeemed_win` / `redeemed_loss`.
- **Position found & not redeemable** → market still open, leave it.
- **Not found** (likely already auto-redeemed) → fall back to
  `markets.resolved_to`, then to CLOB `/markets/<id>` (`closed` + `tokens[].winner`).
  Win → `exit=1, pnl=shares−size_usd`; loss → `exit=0, pnl=−size_usd`;
  reason `redeemed_win_inferred` / `redeemed_loss_inferred`.
- Still unknown → leave open.

#### (g) Reload state, trim, sleep
`processedTradeKeys` is trimmed to the last 5000; `loadState()` rebuilds from the
DB; sleep `pollInterval − elapsed`.

### 6.3 State model — there is no state file

Despite `SIMPLE_STATE_FILE` still being printed at startup, **nothing is written
to disk**. `saveState()` is an intentional no-op; every mutation writes to
Postgres at the point of change. The in-memory `State` is a cache rebuilt each
cycle:

| In-memory | Source of truth |
|---|---|
| `state.open` | `live_positions WHERE status='open'` |
| `state.closed` | `live_positions WHERE status IN ('closed','redeem_pending')` |
| `state.processedTradeKeys` | last 5000 `copy_signals.source_trade_key` |
| `state.stats` | aggregate `SELECT` over `live_positions` |

Consequence: **the bot is crash-safe and restart-safe.** At worst the DB holds a
row memory doesn't; the next `loadState()` picks it up.

### 6.4 Asymmetry worth remembering

| | Entry (BUY) | Exit (SELL) |
|---|---|---|
| Order type | FAK | FOK |
| Claimed before acting | **Yes** (`claimTrade`) | **No** (deliberately) |
| On failure | never retried | **retried next cycle** |
| Guard against duplicates | unique index on `source_trade_key` | the open-position check |

Rationale: a duplicate BUY costs real money; a retried SELL is harmless because
once the position is closed there's nothing left to match.

---

## 7. Loop 3 — Presentation: API + dashboard

### 7.1 `palpha-api` — [api-server.ts](packages/core/src/api-server.ts)

Express, default port `API_PORT` (3001 in code, **4001** locally per the dashboard
default, and served in prod at `https://api.palpha.6116.ai` — a dedicated
subdomain, so there is **no `/api/` prefix**).

**Auth model:**
1. Frontend sends every request with `credentials:'include'`.
2. Middleware reads the `AUTH_COOKIE_NAME` cookie (default `auth_session`).
3. POSTs it to `AUTH_VERIFY_URL` with `{platformName, platformApiKey}`.
4. SSO replies `{userId, email, name, roles}`; everyone is mapped to role `admin`.
5. Cached in-memory for `AUTH_CACHE_TTL_MS` (5 min), swept every 5 min.
6. On 401 the frontend redirects to `NEXT_PUBLIC_AUTH_REDIRECT_URL`.

`/health` is the only public route (`app.use(authMiddleware)` comes after it).
Dev bypass: `DEV_AUTH_OVERRIDE=true` + `X-Dev-User-Id` / `X-Dev-Role` headers —
**never enable in production.**

CORS reflects `DASHBOARD_ORIGIN` (comma-separated) with `credentials: true`.

**Endpoints:**

| Method + route | Reads / does |
|---|---|
| `GET /health` | liveness, public |
| `GET /auth/me` | the resolved SSO user |
| `GET /overview` | `accounts.balance` + `live_positions` aggregates, category counts, scored-trader count, active targets, and `lastSync` (bot heartbeat). Filters: `?mode=paper`, `?days=N`, `?from=&to=` |
| `GET /positions` | **paper** positions (legacy) |
| `GET /positions/live` | open (`open`,`closing`) + last 50 closed `live_positions`, joined to `events`/`markets`/`copy_targets`, open rows augmented with live P/L |
| `GET /traders?category=&limit=&min_markets=` | `traders` + `trader_category_stats`, plus current targets |
| `GET /signals?hours=24&limit=100` | `copy_signals` + acted/skipped stats — **this is where you see why a trade wasn't copied** |
| `GET /backtests` | last 300 `backtest_runs` |
| `GET /trader-compare?wallet=0x…&days= \| from=&to=` | per-trade *their trade vs our copy*: `copy_signals LEFT JOIN live_positions ON source_trade_key`, plus a summary (copy rate, avg slippage, win %, realized P/L, ROI) |
| `POST /targets` | **write** — validates `0x`+40 hex, finds/creates the `traders` row, then reactivates or inserts `copy_targets` (`status='active'`, `added_by=user email`) |
| `PATCH /targets/:id` | **write** — `status` ∈ active/paused/stopped |
| `DELETE /targets/:id` | **write** — soft delete: sets `status='stopped'` |

Those four target routes are the **only** writes the API performs. Everything
else is read-only.

**Unrealized P/L** (`augmentWithUnrealizedPnl`): pulls `metadata.token_id` off
each open position, fetches `clob.polymarket.com/midpoint?token_id=` with
concurrency 10 and a **15 s in-memory cache** (CLOB is rate-limited), then
`unrealized_pnl = shares × mid − size_usd`. Failures degrade to `null`, not an
error.

**Note on SQL style:** date filters are string-interpolated after a strict
`/^\d{4}-\d{2}-\d{2}$/` / integer-range validation; everything user-supplied that
isn't a validated date/int is parameterized.

### 7.2 `palpha-dashboard` — Next.js 14 App Router

Pages under [src/app/(app)/](packages/dashboard/src/app/(app)/):

| Page | Endpoint | Shows |
|---|---|---|
| Overview (`/`) | `/overview` | balance, realized/total P/L, ROI, open count, win rate, active targets, bot heartbeat; preset windows + custom From/To |
| Positions | `/positions/live` | open positions with live midpoint P/L; closed with `close_reason` |
| Traders | `/traders` | scored trader universe + add/pause targets |
| Signals | `/signals` | every detected trade and its `skip_reason` |
| Backtests | `/backtests` | `backtest_runs` rows |
| Trader vs Us | `/trader-compare` | per-trade actual-vs-ours, slippage, copy rate |

All fetching goes through [lib/api.ts](packages/dashboard/src/lib/api.ts)
(`credentials:'include'`, 401 → SSO redirect) and the
[useApi](packages/dashboard/src/lib/useApi.ts) hook, which **polls every 30 s** by
default. There is no server-side data fetching in the trading pages.

---

## 8. Life of a single trade (end to end)

```
 T+0s     quickql buys "Lakers ML" @ $0.42 on Polymarket
             │
 T+≤15s   bot poll: GET data-api /trades?user=quickql (600s window)
             │
          claimTrade() → INSERT copy_signals (unique on source_trade_key)
             │   └─ lost the race? → skip forever
             ▼
          ┌─ category ∈ copy_targets.category?      no → skip: category_mismatch
          ├─ already open on this market?           yes → skip: already_open_for_target
          ├─ open count < SIMPLE_MAX_POSITIONS?     no  → skip: at_max_positions
          ├─ 0.10 ≤ 0.42 ≤ 0.85?                    no  → skip: above/below_*_price
          ▼
          getTickSize + getNegRisk
          createAndPostMarketOrder(BUY, $SIMPLE_POSITION_SIZE, FAK)
             │
             ├─ status 'matched'  → takingAmount = shares, makingAmount = USDC
             ├─ status 'delayed'  → resolveDelayedFill(): poll Data API + getOrder, ≤20s
             └─ status 'unmatched'/error → copy_signals.skip_reason='buy_failed:…'
             ▼
          INSERT live_positions (status='open', metadata.token_id/target_wallet)
          UPDATE copy_signals SET acted_on=true
             │
             ├─ quickql SELLs      → FOK SELL → status='closed', close_reason='target_sold'
             └─ market resolves    → reconcile (≤30 min) → status='closed',
                                     close_reason='redeemed_win|loss[_inferred]'
             ▼
          palpha-api /overview + /positions/live  (+ midpoint for open P/L)
             ▼
          dashboard, refreshed every 30s
```

---

## 9. Configuration reference (`.env`)

Loaded from `packages/core/.env` **or** repo-root `.env` (first one that exists),
resolved relative to the module's own directory so cwd/pm2/tsx/node all work
([config.ts](packages/core/src/config.ts) and the same logic inlined at the top of
`api-server.ts`).

### Database
| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | localhost dev URL | managed Postgres; SSL auto-enabled for non-localhost |

### Bot — wallet & CLOB credentials (required for any real order)
| Var | Notes |
|---|---|
| `POLY_PRIVATE_KEY` | EOA private key that **signs** orders |
| **`POLY_FUNDER`** | **Proxy wallet that HOLDS the USDC.** Fund this one. |
| `POLY_SIGNATURE_TYPE` | default `2` = POLY_GNOSIS_SAFE |
| `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` | CLOB API creds (derive with `tsx packages/core/src/cli/test-clob.ts`) |

### Bot — behaviour
| Var | Default | Notes |
|---|---|---|
| `SIMPLE_TARGET_WALLETS` (or `SIMPLE_TARGET_WALLET`) | — | **fallback only**, used when the `copy_targets` query throws |
| `SIMPLE_POSITION_SIZE` | `2` | USD per copied position |
| `SIMPLE_MAX_POSITIONS` | `3` | global cap across all targets |
| `SIMPLE_MIN_PRICE` | `0.10` | below = longshot/dust |
| `SIMPLE_MAX_PRICE` | `0.85` | above = lock-ins, 1% upside |
| `SIMPLE_POLL_INTERVAL` | `15000` ms | |
| `SIMPLE_TRADE_WINDOW` | `600` s | overlap window |
| `SIMPLE_RECONCILE_INTERVAL_MS` | `1800000` (30 min) | |
| `SIMPLE_STATE_FILE` | `./simple-state.json` | **vestigial — nothing is written** |

> **Env is read once at startup.** Edit `.env`, then
> `pm2 restart simple-copy-trader`.

### API endpoints
| Var | Default |
|---|---|
| `DATA_API_URL` | `https://data-api.polymarket.com` |
| `CLOB_API_URL` | `https://clob.polymarket.com` |
| `GAMMA_API_URL` | `https://gamma-api.polymarket.com` |
| `API_DELAY_MS` / `API_PAGE_SIZE` | `200` / `100` |
| `POLYMARKET_RPC` / `POLYGON_RPC` | `https://polygon-rpc.com` |

### API server
| Var | Default | Notes |
|---|---|---|
| `API_PORT` | `3001` | prod behind `api.palpha.6116.ai` |
| `DASHBOARD_ORIGIN` | `http://localhost:3000,http://localhost:3003` | CORS allowlist, comma-separated |
| `AUTH_VERIFY_URL` | — | SSO verify endpoint |
| `AUTH_PLATFORM_NAME` | `palpha` | |
| `AUTH_PLATFORM_API_KEY` | — | |
| `AUTH_COOKIE_NAME` | `auth_session` | |
| `AUTH_CACHE_TTL_MS` | `300000` | |
| `DEV_AUTH_OVERRIDE` | `false` | **never true in prod** |
| `LOG_LEVEL` | `info` | pino |

### Dashboard (`NEXT_PUBLIC_*`, baked in at build time)
| Var | Default |
|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4001` |
| `NEXT_PUBLIC_AUTH_REDIRECT_URL` | — (SSO login page) |
| `NEXT_PUBLIC_DEV_USER_ID` / `_DEV_ROLE` / `_DEV_USER_EMAIL` / `_DEV_USER_NAME` | dev bypass, pairs with `DEV_AUTH_OVERRIDE` |

> `NEXT_PUBLIC_*` are inlined at **build** time — changing them requires a
> `next build`, not just a restart.

---

## 10. Deployment

**Host:** `ubuntu@ip-172-31-43-130:~/Polymarket-Bot`, branch **`wip/vikash`**,
process manager **pm2**.

| pm2 process | What it runs | Notes |
|---|---|---|
| `palpha-api` | `node packages/core/dist/cli/api-server.js` | **compiled `dist/`, NOT tsx** |
| `palpha-dashboard` | `next start -p 4000` | |
| `simple-copy-trader` | the bot | **not restarted by `npm run deploy`** |
| `api-server`, `dashboard` | — | **stale duplicates; ignore** |

### ⚠️ The thing that has bitten us repeatedly

`palpha-api` runs **compiled JavaScript**. Editing `packages/core/src/*.ts` and
restarting pm2 changes **nothing** — you get stale code, silently.

- `packages/core` build = `tsc` (`src` → `dist`).
- `src/api-server.ts` → `dist/api-server.js` is the real code.
  `src/cli/api-server.ts` → `dist/cli/api-server.js` is just
  `import '../api-server.js'`.
- **Verify a change actually landed:**
  ```bash
  grep -c <symbol> packages/core/dist/api-server.js
  ```

### `npm run deploy` — [scripts/deploy.sh](scripts/deploy.sh)
```
git pull
npm run build --workspace=packages/core        # tsc: src → dist
npm run build --workspace=packages/dashboard   # next build
pm2 restart palpha-api --update-env
pm2 restart palpha-dashboard --update-env
pm2 ls
```
Override names with `API_PROC=… DASH_PROC=… npm run deploy`.
It **deliberately does not touch the bot** — restarting the trader is a separate,
conscious act.

### Branch / merge rules
- **Never push, commit or merge to `main`.** Merging `main` = a manual production
  deploy performed by the user.
- Work on `wip/vikash`; PR into `dev` by default.
- No `Co-Authored-By: Claude` / "Generated with Claude" trailers.
- Postgres/Mongo/Redis are **managed services** — never containerized, no Docker
  for data services.

---

## 11. Runbook — common operations

```bash
# ── Local dev ─────────────────────────────────────────────
npm install
npm run api:start          # API under tsx on API_PORT
npm run dashboard          # Next dev server
npm run live:simple        # the bot (WILL TRADE REAL MONEY if funded)

# ── Inspect ───────────────────────────────────────────────
npm run db:query -- "SELECT status, count(*) FROM live_positions GROUP BY 1"
npm run db:check
npm run monitor
npm run copy:add -- list
pm2 logs simple-copy-trader --lines 200

# ── Target management ─────────────────────────────────────
npm run copy:add -- add-wallet 0x… --name=quickql --category=sports
npm run copy:add -- add-wallet 0x… --category=sports --paused   # stage without copying
npm run copy:add -- pause-all | resume-all | remove <addr>

# ── Research a candidate ──────────────────────────────────
npm run ingest:wallet -- 0x… --apply
npm run screen:band -- wallets.csv
npm run backtest:firstentry -- wallets.csv --team-only --save

# ── Maintenance ───────────────────────────────────────────
npm run backfill:resolutions -- --sports --apply   # fill markets.resolved_to
npm run reconcile:positions -- --apply             # settle resolved open positions
npm run db:migrate

# ── Deploy (prod) ─────────────────────────────────────────
npm run deploy                     # API + dashboard only
pm2 restart simple-copy-trader     # ONLY after an .env or bot-code change
```

`npm run db:query` is **read-only** — it refuses anything that isn't a `SELECT`.

### Diagnosing "the bot isn't copying anything"

Work down this list in order:

1. **Is it alive?** Dashboard Overview `lastSync` (= `accounts.updated_at`) should
   be < 1 min old. Otherwise `pm2 logs simple-copy-trader`.
2. **Are there active targets?**
   `SELECT proxy_wallet,status,category FROM copy_targets;` — all paused means
   copy nothing, by design.
3. **What is it skipping and why?** The Signals page, or:
   ```sql
   SELECT skip_reason, count(*) FROM copy_signals
    WHERE detected_at > NOW() - INTERVAL '24 hours'
    GROUP BY 1 ORDER BY 2 DESC;
   ```
4. **Read the reason:**
   - `above_max_price` / `below_min_price` — working as designed (price band).
   - `category_mismatch` — the target's `copy_targets.category` doesn't include
     the market's category. Note the in-process cache: **restart the bot after
     changing a category**.
   - `at_max_positions` — raise `SIMPLE_MAX_POSITIONS` (needs restart).
   - `buy_failed:unexpected_status_400` — historically **almost always "not enough
     balance"**: fund **`POLY_FUNDER`** (it was once sitting at $0.33 and every
     single order failed).
   - `buy_failed:delayed_no_fill_*` — the order really didn't fill in 20 s;
     usually thin liquidity.
5. **Check the balance actually on the proxy**, not the EOA.

---

## 12. Known issues, gotchas and hard-won lessons

**Deployment**
- `palpha-api` serves compiled `dist/` — a restart without `tsc` serves stale code.
- `NEXT_PUBLIC_*` is build-time, not runtime.
- Two stale pm2 processes (`api-server`, `dashboard`) exist; don't be misled by
  their logs.

**The bot**
- **Fund `POLY_FUNDER`, not the signing EOA.** This has cost us an entire day of
  "every order fails."
- Env is read once at startup — `.env` edits need `pm2 restart simple-copy-trader`.
- `targetCategoryCache` is never invalidated → **category changes need a restart**
  (status changes do not).
- A `delayed` order status is **not** a failure. Any future refactor of the order
  path must keep `resolveDelayedFill()`, or we'll silently create untracked
  positions again.
- Entries must stay FAK; the ~3 s sports hold kills FOK entries.
- Must use `@polymarket/clob-client-v2` — V1 signing fails on negRisk markets
  post-Apr-2026.
- `SIMPLE_STATE_FILE` is dead config; state is 100% in Postgres.
- `copy_signals` has a *second*, legacy unique index
  (`idx_copy_signals_dedup`) that our `ON CONFLICT` clause doesn't name. Sibling
  fills in different txs violate it; the code swallows 23505 on purpose. If you
  add columns/inserts there, preserve that handling or a single duplicate will
  abort an entire cycle.
- The bot has **no stop-loss, no take-profit and no time-based exit.** Positions
  leave only when the target sells or the market resolves.
- **No partial-exit handling:** if the target sells only *part* of their position,
  we close *all* of ours.
- Only the **first** BUY per market per window is considered — deliberate (the
  backtest models exactly this), but it means we never scale in with the target.

**Data**
- **Resolution gap:** sports prop markets (spreads, over/under, in-game
  odd/even) resolve **on-chain only**. CLOB `/markets` returns 0.5/0.5 with no
  winner and Gamma is empty, so `backfill:resolutions` **cannot** fix them. The
  proper fix is a CTF `payoutNumerators` reader — `ethers` is installed and
  `config.polygon.rpcUrl` is already configured. This is the single biggest gap in
  backtest coverage.
- `trades` was truncated (477M rows → gone). Re-`ingest:wallet` before any
  backtest. The bot doesn't care — it never reads `trades`.
- Prices **are** stored correctly per side (verified: Yes+No sum to 1). A trader
  buying both sides cheap is a longshot style, not a data bug.
- But for **binary** markets the stored price is the primary token's price, so
  per-side P&L on Yes/No is unreliable → prefer `--team-only` for honest numbers.
- **Analysis against the DB is read-only by policy.** Never run writes/deletes as
  part of analysis; the user runs any write CLI or SQL. Never touch a production
  database without explicit approval.

**Strategy**
- A high public win-rate ≠ a copyable edge. See §5.
- Of ~103 screened traders only **quickql** cleared the bar, at **+8%** — thin.
  Treat live results with the same skepticism.

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **conditionId** | Polymarket's unique id for a market. Primary join key across all tables. |
| **asset / tokenId** | The ERC-1155 outcome token being traded. One market has one token per outcome. |
| **outcome** | The side bought as a string — `'Yes'`/`'No'` for binaries, a team/competitor name for multi-outcome markets. Compared against `markets.resolved_to`. |
| **proxy wallet** | The Polymarket smart-contract wallet that holds funds and appears in trade feeds. Ours is `POLY_FUNDER`; targets are identified by theirs. |
| **negRisk** | Polymarket's mutually-exclusive multi-outcome market type. Needs the V2 order schema. |
| **tick size** | Minimum price increment for a market; must be passed to the order builder. |
| **FAK** | Fill-and-kill (IOC) — take available liquidity now, cancel the rest. Used on entries. |
| **FOK** | Fill-or-kill — all or nothing. Used on exits. |
| **delayed** | CLOB status meaning the order is accepted and in the pre-match hold (~1 s, ~3 s on sports). Not a failure; not cancellable. |
| **in-band** | A price inside the copyable band ($0.05–0.70 in research, `SIMPLE_MIN/MAX_PRICE` live). |
| **coverage %** | Fraction of a trader's in-band markets that have a known resolution, i.e. how much of their record we could actually score. |
| **first-entry model** | Copy the first in-band buy per market and hold to resolution — the only thing the bot can physically do, so the only honest backtest. |
| **trade key** | `txHash:asset:price:size:timestamp` — stable id for one fill; the dedup lock in `copy_signals.source_trade_key`. |
| **heartbeat** | `accounts.updated_at`, refreshed by the bot's ≤1/min balance sync; surfaced as `lastSync` on Overview. |
