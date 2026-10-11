# pAlpha — Polymarket Copy-Trading Platform

pAlpha watches chosen Polymarket wallets ("targets") and mirrors their trades with your own funds.
A Next.js dashboard shows performance, skipped signals and target management.

> ⚠️ **This software can trade real money.** Run it in read-only / dashboard mode first.
> The live bot only places orders if valid `POLY_*` credentials are in your `.env` **and** the proxy wallet holds USDC.

---

## 1. Architecture at a glance

Three independent loops. They share **only the Postgres database** (no queue, no shared memory).

| Loop | Process | What it does |
|---|---|---|
| Research | CLIs (`npm run ingest:wallet`, `backtest:firstentry`, …) | Decide *who* is worth copying |
| Execution | `npm run live:simple` (`simple-copy-trader.ts`) | Polls targets every 15 s, places orders, tracks positions |
| Presentation | `npm run api:start` + `npm run dashboard` | Express REST API + Next.js UI |

```
Polymarket Data API ──► simple-copy-trader ──► Polymarket CLOB (orders)
                              │
                              ▼
                         PostgreSQL  ◄── Express API (:4001) ◄── Next.js dashboard (:3003)
```

## 2. Repository layout

```
packages/
  core/         engine: bot, ~45 CLIs, Express API, DB layer, backtest engine
  dashboard/    Next.js 14 UI (App Router, Tailwind, recharts)
  categories/   sports + weather classifier plugins
  mcp-server/   MCP wrapper (read / write / execute tiers) – not in the trading path
scripts/        deploy.sh, v3-schema.sql (authoritative schema), DB helper scripts
flow.md         deep technical handoff doc
profitability-analysis.md   30-day live P/L post-mortem
CLAUDE.md       ops notes / gotchas
```

## 3. Prerequisites

- **Node.js 20+** and npm
- **PostgreSQL 14+** (Docker is fine locally) and `psql`
- (Optional, live trading only) Polymarket proxy wallet, private key and CLOB API credentials

## 4. Local setup

### 4.1 Install
```bash
git clone <your-repo-url> p-alpha && cd p-alpha
npm install
```

### 4.2 Start Postgres
```bash
docker compose up -d postgres          # user=polymarket pass=polymarket_dev db=polymarket, port 5432
```
(Or point `DATABASE_URL` at any Postgres you already have.)

### 4.3 Create the schema

```bash
cp .env.example .env
npm run db:migrate                     # applies 001 → 008 (008 adds the columns/index the bot needs)
```

(Advanced: `scripts/v3-schema.sql` + migrations 004, 006, 007, 008 builds the same schema on a database whose name
contains `v3`. Plain `db:migrate` is enough for local use.)

### 4.4 Configure environment

Root `.env` (the API and core read `packages/core/.env` **or** repo-root `.env`):

```env
DATABASE_URL=postgresql://polymarket:polymarket_dev@localhost:5432/polymarket

# API server — dashboard expects 4001
API_PORT=4001
DASHBOARD_ORIGIN=http://localhost:3003
DEV_AUTH_OVERRIDE=true        # LOCAL ONLY – bypasses the 6116.ai SSO
LOG_LEVEL=info

# Only needed for live trading — leave blank for dashboard/research only
POLY_PRIVATE_KEY=
POLY_FUNDER=                  # proxy wallet that HOLDS the USDC
POLY_SIGNATURE_TYPE=2
POLY_API_KEY=
POLY_API_SECRET=
POLY_PASSPHRASE=

# Bot behaviour (read once at startup)
SIMPLE_POSITION_SIZE=2
SIMPLE_MAX_POSITIONS=3
SIMPLE_MIN_PRICE=0.10
SIMPLE_MAX_PRICE=0.85
SIMPLE_MAX_SLIPPAGE=0.05
SIMPLE_MIRROR_MODE=false

# Price Re-Check Engine (needs migration 007) — see section 5. OFF by default.
SIMPLE_RECHECK_ENABLED=false
SIMPLE_RECHECK_MAX_SLIP_REL=0     # 0 = derive from SIMPLE_MAX_SLIPPAGE
```

Dashboard env:
```bash
cp packages/dashboard/.env.local.example packages/dashboard/.env.local
# NEXT_PUBLIC_API_URL=http://localhost:4001   (default already correct)
```

### 4.5 Run

Open three terminals:

```bash
npm run api:start        # API on http://localhost:4001   (check /health)
npm run dashboard        # UI  on http://localhost:3003
npm run live:simple      # the bot — ONLY when you want it to trade (idles if no active targets)
```

Verify:
```bash
curl http://localhost:4001/health
npm run db:check
npm run db:query -- "SELECT status, count(*) FROM live_positions GROUP BY 1"
```

### 4.6 Add a target and research it
```bash
npm run copy:add -- add-wallet 0xWALLET --name=test --category=sports --paused   # stage, don't copy
npm run ingest:wallet -- 0xWALLET --apply          # pull history into `trades`
npm run screen:band -- polymarket_sports_traders_winrate_70plus.csv
npm run backtest:firstentry -- polymarket_sports_traders_winrate_70plus.csv --team-only --save
npm run copy:add -- list
```
Targets can also be added from the dashboard (Traders page). The bot picks up `status='active'` rows on its next 15 s cycle.

## 5. Price Re-Check Engine (optional)

When a copy BUY can't fill inside the price limit, the signal is parked for 10 minutes and the price is
re-checked at T+30 s / 2 m / 5 m / 8 m / 10 m; the bot buys if the price returns to the acceptable range and
abandons if it runs >5 % further away or the TTL ends. Full design, rollout and monitoring SQL: **`PRICE_RECHECK.md`**.

```bash
npm run selftest:recheck        # 32 offline checks, no DB / network
npm run db:migrate              # applies 007_price_watchlist.sql
# then set SIMPLE_RECHECK_ENABLED=true and restart the bot
```

## 5b. Shadow mode, quality sizing and the Consensus tab

- **Shadow mode** (`SIMPLE_SHADOW_MODE=true`): the bot sends **no real orders** and needs no `POLY_*` keys. Each copy
  buy/sell is simulated against Polymarket's **real** live order book; a buy only fills up to the target's price +
  `SIMPLE_MAX_SLIPPAGE` (5¢). It refuses to start if `CLOB_API_URL` is not `clob.polymarket.com`. Use a separate database.
- **Quality sizing** (`SIMPLE_QUALITY_SIZING=true`): a target whose settled history shows ROI >= 10% over >= 30 positions,
  or >= 50 wins with more $ won than lost, is copied at `SIMPLE_QUALIFIED_BUY_USD` ($10) per trade; others at the base size.
  A trader not yet measured trades at the base size until the numbers arrive (a few seconds after start).
- **Consensus tab** (`/consensus` in the dashboard, `GET /consensus` on the API): markets where your active targets overlap,
  which side, how much money, plus the live bid/ask and slippage from the real order book.
- Tests: `npm run selftest:quality` (25 offline checks).

## 6. Common commands

| Task | Command |
|---|---|
| Re-check engine selftest | `npm run selftest:recheck` |
| Typecheck core | `npm run typecheck --workspace=packages/core` |
| Build everything | `npm run build` |
| Pause / resume all targets | `npm run copy:add -- pause-all` / `resume-all` |
| Why wasn't a trade copied? | `npm run db:query -- "SELECT skip_reason,count(*) FROM copy_signals WHERE detected_at>now()-interval '24h' GROUP BY 1 ORDER BY 2 DESC"` |
| Settle resolved positions | `npm run reconcile:positions -- --apply` |
| Backfill market resolutions | `npm run backfill:resolutions -- --sports --apply` |

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard shows 401 / redirects to 6116.ai | Set `DEV_AUTH_OVERRIDE=true` on the API and restart it |
| Dashboard can't reach API | API must be on `API_PORT=4001`; code default is 3001 |
| CORS error | Add dashboard origin to `DASHBOARD_ORIGIN` |
| Every order `buy_failed:…400` | `POLY_FUNDER` (proxy wallet) has no USDC – fund it, not the EOA |
| `order_version_mismatch` | Must use `@polymarket/clob-client-v2` (already used by the bot) |
| Edited `.env`, no effect | Restart the bot – env is read once |
| Changed a target's category, no effect | Restart the bot – category is cached |
| `[recheck] DISABLED — price_watchlist is not readable` | Apply migration 007, restart the bot |
| Prod change not visible | `palpha-api` runs compiled `dist/` – run `npm run build --workspace=packages/core` |

## 8. Production deployment (summary)

pm2 processes: `palpha-api` (compiled `dist/`), `palpha-dashboard` (`next start`), `simple-copy-trader` (the bot).
`npm run deploy` = git pull → build core → build dashboard → restart API + dashboard. It does **not** restart the bot.

## 9. Security notes

- Never commit `.env`; `POLY_PRIVATE_KEY` controls real funds.
- `DEV_AUTH_OVERRIDE` must be `false` in production.
- `src/cli/db-query.ts` is read-only by design; keep analysis DB access read-only.
