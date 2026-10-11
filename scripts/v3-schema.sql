-- ============================================================
-- Polymarket Bot: Consolidated v3 schema (single-shot, properly aligned with v2)
--
-- This file is the SINGLE SOURCE OF TRUTH for v3. It is a careful merge of
-- v2 migrations (001+002+003) with the following changes:
--   • trades partitioned by trade_date (monthly), Apr2026–Mar2027 + default
--   • trades.id, traders.id, copy_signals.id, etc. → BIGINT/BIGSERIAL
--   • trade_key UNIQUE is composite with trade_date (partitioning requirement)
--   • All v2 enrichment columns + v2 scorer columns baked in
--
-- File lives in scripts/ NOT db/migrations/ so the application's migration
-- runner cannot apply this to a v1/v2 DB.
-- ============================================================

DO $$
BEGIN
  IF current_database() NOT LIKE '%v3%' THEN
    RAISE EXCEPTION 'Refusing to apply v3 schema to database "%": expected name to contain "v3"', current_database();
  END IF;
END $$;

-- ============================================================
-- events
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    poly_event_id INTEGER UNIQUE NOT NULL,           -- v2: INTEGER (NOT TEXT)
    title TEXT NOT NULL,
    slug TEXT,
    description TEXT,
    category TEXT NOT NULL,
    subcategory TEXT,
    subcategory_detail TEXT,
    end_date TIMESTAMPTZ,
    tags TEXT[],                                     -- v2: TEXT[] (NOT JSONB)
    is_resolved BOOLEAN DEFAULT FALSE,
    resolved_outcome TEXT,
    -- 002 enrichment
    start_date TIMESTAMPTZ,
    created_at_poly TIMESTAMPTZ,
    closed_time TIMESTAMPTZ,
    archived BOOLEAN,
    restricted BOOLEAN,
    featured BOOLEAN,
    volume NUMERIC,
    liquidity NUMERIC,
    open_interest NUMERIC,
    volume_24hr NUMERIC,
    volume_1wk NUMERIC,
    volume_1mo NUMERIC,
    competitive REAL,
    comment_count INTEGER,
    resolution_source TEXT,
    group_item_title TEXT,
    raw_payload JSONB,
    fetched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_category    ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_subcategory ON events(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_events_poly_id     ON events(poly_event_id);
CREATE INDEX IF NOT EXISTS idx_events_end_date    ON events(end_date);
CREATE INDEX IF NOT EXISTS idx_events_resolved    ON events(is_resolved);
CREATE INDEX IF NOT EXISTS idx_events_start_date  ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_closed_time ON events(closed_time);
CREATE INDEX IF NOT EXISTS idx_events_fetched_at  ON events(fetched_at);

-- ============================================================
-- markets
-- ============================================================
CREATE TABLE IF NOT EXISTS markets (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    condition_id TEXT UNIQUE NOT NULL,
    question TEXT NOT NULL,
    slug TEXT,                                       -- v2: present in scanner INSERTs
    outcome_yes_token TEXT,
    outcome_no_token TEXT,
    is_closed BOOLEAN DEFAULT FALSE,
    resolved_to TEXT,
    end_date TIMESTAMPTZ,
    -- 002 enrichment
    start_date TIMESTAMPTZ,
    created_at_poly TIMESTAMPTZ,
    closed_time TIMESTAMPTZ,
    archived BOOLEAN,
    uma_resolution_status TEXT,
    uma_resolution_statuses JSONB,
    resolved_by TEXT,
    resolution_source TEXT,
    best_bid NUMERIC,
    best_ask NUMERIC,
    spread NUMERIC,
    last_trade_price NUMERIC,
    final_yes_price NUMERIC,
    final_no_price NUMERIC,
    volume NUMERIC,
    liquidity NUMERIC,
    volume_24hr NUMERIC,
    volume_1wk NUMERIC,
    volume_1mo NUMERIC,
    order_min_size NUMERIC,
    tick_size NUMERIC,
    rewards_min_size NUMERIC,
    rewards_max_spread NUMERIC,
    neg_risk BOOLEAN,
    neg_risk_market_id TEXT,
    neg_risk_request_id TEXT,
    accepting_orders BOOLEAN,
    accepting_orders_ts TIMESTAMPTZ,
    enable_order_book BOOLEAN,
    raw_payload JSONB,
    fetched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_markets_event_id     ON markets(event_id);
CREATE INDEX IF NOT EXISTS idx_markets_condition_id ON markets(condition_id);
CREATE INDEX IF NOT EXISTS idx_markets_yes_token    ON markets(outcome_yes_token);
CREATE INDEX IF NOT EXISTS idx_markets_no_token     ON markets(outcome_no_token);
CREATE INDEX IF NOT EXISTS idx_markets_uma_status   ON markets(uma_resolution_status);
CREATE INDEX IF NOT EXISTS idx_markets_neg_risk     ON markets(neg_risk);
CREATE INDEX IF NOT EXISTS idx_markets_fetched_at   ON markets(fetched_at);

-- ============================================================
-- traders (BIGSERIAL — v2 had SERIAL but we may exceed int4)
-- All scoring columns from v2 baked in.
-- ============================================================
CREATE TABLE IF NOT EXISTS traders (
    id BIGSERIAL PRIMARY KEY,
    proxy_wallet TEXT UNIQUE NOT NULL,
    display_name TEXT,
    pseudonym TEXT,
    first_seen_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    total_trades INTEGER DEFAULT 0,
    total_markets INTEGER DEFAULT 0,
    win_rate REAL,
    roi REAL,
    total_pnl REAL,
    consistency_score REAL,
    composite_score REAL,
    -- Alpha scores (5-dim)
    profit_score REAL,
    efficiency_score REAL,
    precision_score REAL,
    conviction_score REAL,
    asymmetry_score REAL,
    alpha_score REAL,
    alpha_tags TEXT,
    score_updated_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_traders_score     ON traders(composite_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_traders_alpha     ON traders(alpha_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_traders_wallet    ON traders(proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_traders_pseudonym ON traders(pseudonym);
CREATE INDEX IF NOT EXISTS idx_traders_last_seen ON traders(last_seen_at);

-- ============================================================
-- trades — PARTITIONED BY trade_date (monthly)
--
-- Partitioning constraints:
--   PRIMARY KEY must include partition key  → (id, trade_date)
--   UNIQUE constraints must include the key → (trade_key, trade_date)
-- ============================================================
CREATE TABLE IF NOT EXISTS trades (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    trader_id BIGINT,                                -- FK enforced at app layer
    event_id INTEGER REFERENCES events(id),
    market_id INTEGER REFERENCES markets(id),
    proxy_wallet TEXT NOT NULL,
    side TEXT NOT NULL,
    outcome TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    "timestamp" BIGINT NOT NULL,
    trade_date TIMESTAMPTZ NOT NULL,                 -- partition key — must be NOT NULL
    trade_key TEXT,
    transaction_hash TEXT,
    log_index INTEGER,
    block_number BIGINT,
    asset_token_id TEXT,
    trade_type TEXT,
    role TEXT,
    fee_amount NUMERIC,
    fee_rate_bps INTEGER,
    match_time TIMESTAMPTZ,
    order_hash TEXT,
    counterparty TEXT,
    source TEXT,
    clob_trade_id TEXT,
    pseudonym TEXT,
    display_name TEXT,
    raw_payload JSONB,
    fetched_at TIMESTAMPTZ,
    PRIMARY KEY (id, trade_date)
) PARTITION BY RANGE (trade_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_trade_key ON trades(trade_key, trade_date);
CREATE INDEX IF NOT EXISTS idx_trades_trader     ON trades(trader_id);
CREATE INDEX IF NOT EXISTS idx_trades_event      ON trades(event_id);
CREATE INDEX IF NOT EXISTS idx_trades_market     ON trades(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp  ON trades("timestamp");
CREATE INDEX IF NOT EXISTS idx_trades_role       ON trades(role);
CREATE INDEX IF NOT EXISTS idx_trades_type       ON trades(trade_type);
CREATE INDEX IF NOT EXISTS idx_trades_block      ON trades(block_number);
CREATE INDEX IF NOT EXISTS idx_trades_source     ON trades(source);
CREATE INDEX IF NOT EXISTS idx_trades_tx_hash    ON trades(transaction_hash);
CREATE INDEX IF NOT EXISTS idx_trades_wallet     ON trades(proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_trades_asset      ON trades(asset_token_id);

-- Pre-create partitions Apr 2026 – Mar 2027 + default
CREATE TABLE IF NOT EXISTS trades_2026_04 PARTITION OF trades FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS trades_2026_05 PARTITION OF trades FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS trades_2026_06 PARTITION OF trades FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS trades_2026_07 PARTITION OF trades FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS trades_2026_08 PARTITION OF trades FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS trades_2026_09 PARTITION OF trades FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS trades_2026_10 PARTITION OF trades FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS trades_2026_11 PARTITION OF trades FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS trades_2026_12 PARTITION OF trades FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS trades_2027_01 PARTITION OF trades FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS trades_2027_02 PARTITION OF trades FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS trades_2027_03 PARTITION OF trades FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS trades_default PARTITION OF trades DEFAULT;

-- ============================================================
-- trader_category_stats — full v2 alpha-scoring schema
-- ============================================================
CREATE TABLE IF NOT EXISTS trader_category_stats (
    id SERIAL PRIMARY KEY,
    trader_id BIGINT REFERENCES traders(id),
    category TEXT NOT NULL,
    subcategory TEXT,
    total_trades INTEGER DEFAULT 0,
    total_markets INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    win_rate REAL,
    roi REAL,
    total_pnl REAL,
    total_invested REAL,
    consistency_score REAL,
    composite_score REAL,
    profit_score REAL,
    efficiency_score REAL,
    precision_score REAL,
    conviction_score REAL,
    asymmetry_score REAL,
    alpha_score REAL,
    alpha_tags TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (trader_id, category)
);
CREATE INDEX IF NOT EXISTS idx_category_stats_category ON trader_category_stats(category);
CREATE INDEX IF NOT EXISTS idx_category_stats_trader   ON trader_category_stats(trader_id);
CREATE INDEX IF NOT EXISTS idx_category_stats_score    ON trader_category_stats(category, composite_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_category_stats_alpha    ON trader_category_stats(category, alpha_score DESC NULLS LAST);

-- ============================================================
-- scan_progress
-- ============================================================
CREATE TABLE IF NOT EXISTS scan_progress (
    id SERIAL PRIMARY KEY,
    event_id INTEGER UNIQUE REFERENCES events(id),
    trades_fetched INTEGER DEFAULT 0,
    traders_found INTEGER DEFAULT 0,
    scanned_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- copy_targets — includes proxy_wallet + added_at to match v2
-- ============================================================
CREATE TABLE IF NOT EXISTS copy_targets (
    id SERIAL PRIMARY KEY,
    trader_id BIGINT REFERENCES traders(id),
    proxy_wallet TEXT NOT NULL,
    display_name TEXT,
    category TEXT,
    status TEXT DEFAULT 'active',
    added_by TEXT DEFAULT 'manual',
    added_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copy_targets_status   ON copy_targets(status);
CREATE INDEX IF NOT EXISTS idx_copy_targets_category ON copy_targets(category);

-- ============================================================
-- accounts — supports per-category scoping like v2
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    mode TEXT NOT NULL,
    category TEXT,
    balance REAL NOT NULL DEFAULT 0,
    total_deposited REAL NOT NULL DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    realized_pnl REAL DEFAULT 0,
    unrealized_pnl REAL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_mode_category
  ON accounts (mode, COALESCE(category, '__all__'));

INSERT INTO accounts (mode, balance, total_deposited) VALUES ('paper', 1000, 1000)
  ON CONFLICT DO NOTHING;
INSERT INTO accounts (mode, balance, total_deposited) VALUES ('live', 0, 0)
  ON CONFLICT DO NOTHING;

-- ============================================================
-- paper_positions
-- ============================================================
CREATE TABLE IF NOT EXISTS paper_positions (
    id SERIAL PRIMARY KEY,
    copy_target_id INTEGER REFERENCES copy_targets(id),
    market_id INTEGER REFERENCES markets(id),
    event_id INTEGER REFERENCES events(id),
    condition_id TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    size_usd REAL NOT NULL,
    shares REAL NOT NULL,
    status TEXT DEFAULT 'open',
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    exit_price REAL,
    pnl REAL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions(status);
CREATE INDEX IF NOT EXISTS idx_paper_positions_target ON paper_positions(copy_target_id);

-- ============================================================
-- live_positions
-- ============================================================
CREATE TABLE IF NOT EXISTS live_positions (
    id SERIAL PRIMARY KEY,
    copy_target_id INTEGER REFERENCES copy_targets(id),
    market_id INTEGER REFERENCES markets(id),
    event_id INTEGER REFERENCES events(id),
    condition_id TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    size_usd REAL NOT NULL,
    shares REAL NOT NULL,
    status TEXT DEFAULT 'open',
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    exit_price REAL,
    pnl REAL,
    order_id TEXT,
    tx_hash TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_positions_status ON live_positions(status);
CREATE INDEX IF NOT EXISTS idx_live_positions_target ON live_positions(copy_target_id);

-- ============================================================
-- copy_signals (BIGSERIAL — high-frequency)
-- v2 has no FK on market_id/event_id; we keep that to avoid blocking inserts
-- when markets/events haven't been scanned yet.
-- ============================================================
CREATE TABLE IF NOT EXISTS copy_signals (
    id BIGSERIAL PRIMARY KEY,
    copy_target_id INTEGER REFERENCES copy_targets(id),
    trader_id BIGINT REFERENCES traders(id),
    proxy_wallet TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    market_id INTEGER,
    event_id INTEGER,
    side TEXT NOT NULL,
    outcome TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    signal_type TEXT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL,
    acted_on BOOLEAN DEFAULT FALSE,
    skip_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copy_signals_target   ON copy_signals(copy_target_id);
CREATE INDEX IF NOT EXISTS idx_copy_signals_wallet   ON copy_signals(proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_copy_signals_detected ON copy_signals(detected_at);

-- ============================================================
-- backtest_runs — full v2 columns
-- ============================================================
CREATE TABLE IF NOT EXISTS backtest_runs (
    id SERIAL PRIMARY KEY,
    category TEXT,
    strategy TEXT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    config JSONB NOT NULL,
    total_return REAL,
    sharpe_ratio REAL,
    max_drawdown REAL,
    win_rate REAL,
    total_trades INTEGER,
    total_pnl REAL,
    equity_curve JSONB,
    per_trader JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_category ON backtest_runs(category);

-- ============================================================
-- market_price_history (BIGSERIAL — fidelity=1 means many rows)
-- ============================================================
CREATE TABLE IF NOT EXISTS market_price_history (
    id BIGSERIAL PRIMARY KEY,
    market_id INTEGER REFERENCES markets(id),
    condition_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    price NUMERIC NOT NULL,
    fidelity INTEGER NOT NULL DEFAULT 60,
    fetched_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique
  ON market_price_history (token_id, "timestamp", fidelity);
CREATE INDEX IF NOT EXISTS idx_price_history_market    ON market_price_history(market_id);
CREATE INDEX IF NOT EXISTS idx_price_history_condition ON market_price_history(condition_id);
CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON market_price_history("timestamp");

-- ============================================================
-- orderbook_snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    id BIGSERIAL PRIMARY KEY,
    market_id INTEGER REFERENCES markets(id),
    condition_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    best_bid NUMERIC,
    best_ask NUMERIC,
    midpoint NUMERIC,
    spread NUMERIC,
    bids JSONB,
    asks JSONB,
    source_hash TEXT,
    trigger TEXT,
    trigger_ref TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orderbook_market    ON orderbook_snapshots(market_id);
CREATE INDEX IF NOT EXISTS idx_orderbook_captured  ON orderbook_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_orderbook_token     ON orderbook_snapshots(token_id);

-- ============================================================
-- position_snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS position_snapshots (
    id SERIAL PRIMARY KEY,
    proxy_wallet TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    total_positions INTEGER,
    total_size_usd NUMERIC,
    total_cash_pnl NUMERIC,
    total_realized_pnl NUMERIC,
    positions JSONB,
    raw_payload JSONB,
    source TEXT DEFAULT 'data-api',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_snapshot_unique
  ON position_snapshots (proxy_wallet, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_position_snapshot_captured ON position_snapshots(captured_at);

-- ============================================================
-- execution_log
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_log (
    id BIGSERIAL PRIMARY KEY,
    copy_signal_id BIGINT,
    copy_target_id INTEGER REFERENCES copy_targets(id),
    mode TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    side TEXT NOT NULL,
    trader_price NUMERIC NOT NULL,
    trader_timestamp BIGINT NOT NULL,
    our_price NUMERIC NOT NULL,
    our_timestamp TIMESTAMPTZ NOT NULL,
    latency_ms BIGINT,
    slippage NUMERIC,
    midpoint_at_signal NUMERIC,
    best_bid_at_signal NUMERIC,
    best_ask_at_signal NUMERIC,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_execlog_target  ON execution_log(copy_target_id);
CREATE INDEX IF NOT EXISTS idx_execlog_mode    ON execution_log(mode);
CREATE INDEX IF NOT EXISTS idx_execlog_created ON execution_log(created_at);
CREATE INDEX IF NOT EXISTS idx_execlog_signal  ON execution_log(copy_signal_id);

-- ============================================================
-- ingest_checkpoints
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_checkpoints (
    id SERIAL PRIMARY KEY,
    source TEXT UNIQUE NOT NULL,
    cursor_value TEXT,
    records_ingested BIGINT DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    last_error TEXT,
    status TEXT DEFAULT 'idle',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- trader_alias_history
-- ============================================================
CREATE TABLE IF NOT EXISTS trader_alias_history (
    id BIGSERIAL PRIMARY KEY,
    proxy_wallet TEXT NOT NULL,
    pseudonym TEXT,
    display_name TEXT,
    seen_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alias_history_wallet ON trader_alias_history(proxy_wallet);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_history_unique
  ON trader_alias_history (
    proxy_wallet,
    COALESCE(pseudonym, ''),
    COALESCE(display_name, '')
  );

-- ============================================================
-- Schema migrations for v1.2.0+
-- These additions support the bot's own trade tracking, moving it off the
-- legacy simple-state.json file into the DB.
-- ============================================================

-- Bot's own positions need an outcome name. Polymarket outcomes can be "Yes",
-- "No", or a named outcome like "Henrique Rocha" for sports. We used to stuff
-- this in metadata which is awkward to query.
ALTER TABLE live_positions
  ADD COLUMN IF NOT EXISTS outcome TEXT;

ALTER TABLE live_positions
  ADD COLUMN IF NOT EXISTS source_trade_key TEXT;

-- Dedup index on copy_signals — the bot uses this to know "have I seen this
-- target wallet's trade before?". Single atomic INSERT … ON CONFLICT DO
-- NOTHING replaces the in-memory `processedTradeKeys` list. The detected_at
-- timestamp keeps multi-fill rows from the same tx distinct (one BUY can
-- match against multiple maker orders, each with its own price).
CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_signals_dedup
  ON copy_signals(proxy_wallet, condition_id, side, outcome, detected_at, price, size);

-- ============================================================
-- trades_clean — scoring-safe view of trades
-- ============================================================
-- Restricts to markets that were both CREATED and RESOLVED inside our
-- scan window. This is the only correct universe to compute cash-flow
-- PnL over: we see every event in the market's lifetime, no pre-window
-- inventory, no post-window leakage.
--
-- The window auto-expands as the scanner ingests more data — MIN/MAX
-- of trade_date are computed at query time.
--
-- The scorer reads exclusively from this view. If you need raw trades
-- for ad-hoc analytics, query the base `trades` table directly.
CREATE OR REPLACE VIEW trades_clean AS
SELECT t.*
FROM trades t
JOIN markets m ON m.id = t.market_id
WHERE m.resolved_to     IS NOT NULL
  AND m.created_at_poly >= (SELECT MIN(trade_date) FROM trades)
  AND m.closed_time     <= (SELECT MAX(trade_date) FROM trades);

-- ============================================================
-- Schema version marker
-- ============================================================
CREATE TABLE IF NOT EXISTS _v3_schema_version (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO _v3_schema_version (version) VALUES ('1.2.0')
  ON CONFLICT (version) DO NOTHING;
