-- ============================================================
-- Polymarket Bot: Clean Schema v2 (Enrichment)
--
-- Adds rich metadata fields to events/markets/trades for:
--   - UMA resolution tracking
--   - Maker/taker classification
--   - Historical price series
--   - Orderbook snapshots
--   - Daily position snapshots
--   - Raw payload preservation
--
-- Safe to apply to existing DB: only adds columns and tables.
-- Designed to be run on a fresh DB pointed at by DATABASE_URL.
-- ============================================================

-- ============================================================
-- Events: enrichment columns
-- ============================================================
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS start_date         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at_poly    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_time        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived           BOOLEAN,
  ADD COLUMN IF NOT EXISTS restricted         BOOLEAN,
  ADD COLUMN IF NOT EXISTS featured           BOOLEAN,
  ADD COLUMN IF NOT EXISTS volume             NUMERIC,
  ADD COLUMN IF NOT EXISTS liquidity          NUMERIC,
  ADD COLUMN IF NOT EXISTS open_interest      NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_24hr        NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_1wk         NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_1mo         NUMERIC,
  ADD COLUMN IF NOT EXISTS competitive        REAL,
  ADD COLUMN IF NOT EXISTS comment_count      INTEGER,
  ADD COLUMN IF NOT EXISTS resolution_source  TEXT,
  ADD COLUMN IF NOT EXISTS group_item_title   TEXT,
  ADD COLUMN IF NOT EXISTS raw_payload        JSONB,
  ADD COLUMN IF NOT EXISTS fetched_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_closed_time ON events(closed_time);
CREATE INDEX IF NOT EXISTS idx_events_fetched_at ON events(fetched_at);

-- ============================================================
-- Markets: enrichment columns
-- ============================================================
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS start_date            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at_poly       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_time           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived              BOOLEAN,
  ADD COLUMN IF NOT EXISTS uma_resolution_status TEXT,
  ADD COLUMN IF NOT EXISTS uma_resolution_statuses JSONB,
  ADD COLUMN IF NOT EXISTS resolved_by           TEXT,
  ADD COLUMN IF NOT EXISTS resolution_source     TEXT,
  ADD COLUMN IF NOT EXISTS best_bid              NUMERIC,
  ADD COLUMN IF NOT EXISTS best_ask              NUMERIC,
  ADD COLUMN IF NOT EXISTS spread               NUMERIC,
  ADD COLUMN IF NOT EXISTS last_trade_price      NUMERIC,
  ADD COLUMN IF NOT EXISTS final_yes_price       NUMERIC,
  ADD COLUMN IF NOT EXISTS final_no_price        NUMERIC,
  ADD COLUMN IF NOT EXISTS volume                NUMERIC,
  ADD COLUMN IF NOT EXISTS liquidity             NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_24hr           NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_1wk            NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_1mo            NUMERIC,
  ADD COLUMN IF NOT EXISTS order_min_size        NUMERIC,
  ADD COLUMN IF NOT EXISTS tick_size             NUMERIC,
  ADD COLUMN IF NOT EXISTS rewards_min_size      NUMERIC,
  ADD COLUMN IF NOT EXISTS rewards_max_spread    NUMERIC,
  ADD COLUMN IF NOT EXISTS neg_risk              BOOLEAN,
  ADD COLUMN IF NOT EXISTS neg_risk_market_id    TEXT,
  ADD COLUMN IF NOT EXISTS neg_risk_request_id   TEXT,
  ADD COLUMN IF NOT EXISTS accepting_orders      BOOLEAN,
  ADD COLUMN IF NOT EXISTS accepting_orders_ts   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enable_order_book     BOOLEAN,
  ADD COLUMN IF NOT EXISTS raw_payload           JSONB,
  ADD COLUMN IF NOT EXISTS fetched_at            TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_markets_uma_status ON markets(uma_resolution_status);
CREATE INDEX IF NOT EXISTS idx_markets_neg_risk ON markets(neg_risk);
CREATE INDEX IF NOT EXISTS idx_markets_fetched_at ON markets(fetched_at);

-- ============================================================
-- Trades: enrichment columns (for clean re-pull, existing rows null)
-- ============================================================
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS trade_key         TEXT,  -- deterministic dedup key, computed per source
  ADD COLUMN IF NOT EXISTS transaction_hash  TEXT,
  ADD COLUMN IF NOT EXISTS log_index         INTEGER,
  ADD COLUMN IF NOT EXISTS block_number      BIGINT,
  ADD COLUMN IF NOT EXISTS asset_token_id    TEXT,
  ADD COLUMN IF NOT EXISTS trade_type        TEXT,  -- 'TRADE', 'CONVERT', 'REDEEM', 'MERGE', 'SPLIT'
  ADD COLUMN IF NOT EXISTS role              TEXT,  -- 'maker', 'taker'
  ADD COLUMN IF NOT EXISTS fee_amount        NUMERIC,
  ADD COLUMN IF NOT EXISTS fee_rate_bps      INTEGER,
  ADD COLUMN IF NOT EXISTS match_time        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS order_hash        TEXT,
  ADD COLUMN IF NOT EXISTS counterparty      TEXT,  -- the other wallet
  ADD COLUMN IF NOT EXISTS source            TEXT,  -- 'data-api', 'clob', 'on-chain'
  ADD COLUMN IF NOT EXISTS clob_trade_id     TEXT,
  ADD COLUMN IF NOT EXISTS pseudonym         TEXT,
  ADD COLUMN IF NOT EXISTS display_name      TEXT,
  ADD COLUMN IF NOT EXISTS raw_payload       JSONB,
  ADD COLUMN IF NOT EXISTS fetched_at        TIMESTAMPTZ;

-- Primary dedup: trade_key is unique per ingested row, computed deterministically
-- Format examples:
--   clob:{clob_trade_id}:{proxy_wallet}:{role}
--   dataapi:{tx_hash}:{proxy_wallet}:{asset}:{ts}:{price}
--   onchain:{tx_hash}:{log_index}
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_trade_key
  ON trades (trade_key)
  WHERE trade_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trades_role ON trades(role);
CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(trade_type);
CREATE INDEX IF NOT EXISTS idx_trades_block ON trades(block_number);
CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(source);
CREATE INDEX IF NOT EXISTS idx_trades_tx_hash ON trades(transaction_hash);

-- ============================================================
-- Market price history (from CLOB /prices-history)
-- ============================================================
CREATE TABLE IF NOT EXISTS market_price_history (
    id SERIAL PRIMARY KEY,
    market_id INTEGER REFERENCES markets(id),
    condition_id TEXT NOT NULL,
    token_id TEXT NOT NULL,           -- Yes or No token
    outcome TEXT NOT NULL,            -- 'Yes' or 'No'
    timestamp BIGINT NOT NULL,        -- unix seconds
    price NUMERIC NOT NULL,
    fidelity INTEGER NOT NULL DEFAULT 60,  -- 1=min, 60=hour, 1440=day
    fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- NOT NULL on fidelity makes this index fully enforce dedup
-- (Postgres treats NULLs as distinct in unique indexes pre-15).
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique
  ON market_price_history (token_id, timestamp, fidelity);
CREATE INDEX IF NOT EXISTS idx_price_history_market ON market_price_history(market_id);
CREATE INDEX IF NOT EXISTS idx_price_history_condition ON market_price_history(condition_id);
CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON market_price_history(timestamp);

-- ============================================================
-- Orderbook snapshots (captured live on signal detection)
-- ============================================================
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    id SERIAL PRIMARY KEY,
    market_id INTEGER REFERENCES markets(id),
    condition_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    best_bid NUMERIC,
    best_ask NUMERIC,
    midpoint NUMERIC,
    spread NUMERIC,
    bids JSONB,                       -- [[price, size], ...]
    asks JSONB,
    source_hash TEXT,                 -- Polymarket's book hash
    trigger TEXT,                     -- 'signal', 'scheduled', 'trade'
    trigger_ref TEXT,                 -- e.g. copy_signal_id
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orderbook_market ON orderbook_snapshots(market_id);
CREATE INDEX IF NOT EXISTS idx_orderbook_captured ON orderbook_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_orderbook_token ON orderbook_snapshots(token_id);

-- ============================================================
-- Position snapshots (daily per target trader, for trust auditing)
-- ============================================================
CREATE TABLE IF NOT EXISTS position_snapshots (
    id SERIAL PRIMARY KEY,
    proxy_wallet TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    -- Aggregate totals
    total_positions INTEGER,
    total_size_usd NUMERIC,
    total_cash_pnl NUMERIC,
    total_realized_pnl NUMERIC,
    -- Per-position detail
    positions JSONB,                  -- [{asset, conditionId, size, avgPrice, currentValue, ...}]
    raw_payload JSONB,                -- full API response, for fields we haven't mapped
    source TEXT DEFAULT 'data-api',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_position_snapshot_unique
  ON position_snapshots (proxy_wallet, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_position_snapshot_captured ON position_snapshots(captured_at);

-- ============================================================
-- Execution log (our entry vs trader entry — slippage/latency truth)
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_log (
    id SERIAL PRIMARY KEY,
    copy_signal_id INTEGER,           -- FK to copy_signals.id
    copy_target_id INTEGER REFERENCES copy_targets(id),
    mode TEXT NOT NULL,               -- 'paper' or 'live'
    condition_id TEXT NOT NULL,
    side TEXT NOT NULL,
    -- Trader side
    trader_price NUMERIC NOT NULL,    -- their fill price
    trader_timestamp BIGINT NOT NULL, -- their fill time (unix sec)
    -- Our side
    our_price NUMERIC NOT NULL,       -- our entry price (midpoint or actual)
    our_timestamp TIMESTAMPTZ NOT NULL,
    latency_ms BIGINT,                -- detect_time - trader_time
    slippage NUMERIC,                 -- our_price - trader_price
    -- Context
    midpoint_at_signal NUMERIC,       -- from orderbook snapshot
    best_bid_at_signal NUMERIC,
    best_ask_at_signal NUMERIC,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execlog_target ON execution_log(copy_target_id);
CREATE INDEX IF NOT EXISTS idx_execlog_mode ON execution_log(mode);
CREATE INDEX IF NOT EXISTS idx_execlog_created ON execution_log(created_at);
CREATE INDEX IF NOT EXISTS idx_execlog_signal ON execution_log(copy_signal_id);

-- ============================================================
-- Ingest checkpoints (per-source resume state)
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_checkpoints (
    id SERIAL PRIMARY KEY,
    source TEXT UNIQUE NOT NULL,      -- 'events-sports', 'trades-clob', etc.
    cursor_value TEXT,                -- offset, block number, timestamp — source-specific
    records_ingested BIGINT DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    last_error TEXT,
    status TEXT DEFAULT 'idle',       -- 'idle', 'running', 'error'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Trader pseudonym history (handles alias changes over time)
-- ============================================================
CREATE TABLE IF NOT EXISTS trader_alias_history (
    id SERIAL PRIMARY KEY,
    proxy_wallet TEXT NOT NULL,
    pseudonym TEXT,
    display_name TEXT,
    seen_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Wallet case normalization (conditional, safe)
-- v2 scan scripts write proxy_wallet lowercase; v1 rows may be mixed-case.
-- `trades` has no UNIQUE on proxy_wallet so the UPDATE is safe.
-- `traders.proxy_wallet` IS UNIQUE — if both '0xABC' and '0xabc' exist in an
-- existing DB, LOWER() would collide. We skip the traders update here; run it
-- manually after inspecting for duplicates. On a fresh v2 DB this is a no-op.
-- ============================================================
UPDATE trades SET proxy_wallet = LOWER(proxy_wallet) WHERE proxy_wallet <> LOWER(proxy_wallet);

CREATE INDEX IF NOT EXISTS idx_alias_history_wallet ON trader_alias_history(proxy_wallet);
-- NULL-safe uniqueness: COALESCE folds NULLs to '' so
-- (wallet, 'alice', NULL) dedups with a second identical row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_history_unique
  ON trader_alias_history (
    proxy_wallet,
    COALESCE(pseudonym, ''),
    COALESCE(display_name, '')
  );
