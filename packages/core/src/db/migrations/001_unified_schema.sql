-- ============================================================
-- Polymarket Bot: Unified Schema
-- Single database, categories distinguished by column
-- ============================================================

-- Events from Polymarket (weather, sports, crypto, etc.)
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    poly_event_id INTEGER UNIQUE NOT NULL,
    title TEXT NOT NULL,
    slug TEXT,
    description TEXT,
    category TEXT NOT NULL,              -- 'weather', 'sports', 'crypto', etc.
    subcategory TEXT,                    -- sport type, weather category, etc.
    subcategory_detail TEXT,             -- league, city, etc.
    end_date TIMESTAMPTZ,
    tags TEXT[],
    is_resolved BOOLEAN DEFAULT false,
    resolved_outcome TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual markets within events
CREATE TABLE IF NOT EXISTS markets (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES events(id),
    condition_id TEXT UNIQUE NOT NULL,
    question TEXT NOT NULL,
    slug TEXT,
    outcome_yes_token TEXT,
    outcome_no_token TEXT,
    is_closed BOOLEAN DEFAULT false,
    resolved_to TEXT,                    -- 'Yes' or 'No'
    end_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Traders discovered across all categories
CREATE TABLE IF NOT EXISTS traders (
    id SERIAL PRIMARY KEY,
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
    -- Alpha scores (5-dimensional)
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

-- Individual trade records
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    trader_id INTEGER REFERENCES traders(id),
    event_id INTEGER REFERENCES events(id),
    market_id INTEGER REFERENCES markets(id),
    proxy_wallet TEXT NOT NULL,
    side TEXT NOT NULL,                  -- 'BUY' or 'SELL'
    outcome TEXT NOT NULL,              -- 'Yes' or 'No'
    price REAL NOT NULL,
    size REAL NOT NULL,
    timestamp BIGINT NOT NULL,
    trade_date TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_dedup
  ON trades (proxy_wallet, COALESCE(market_id, -1), side, outcome, price, timestamp);

-- Per-trader per-category aggregated stats
CREATE TABLE IF NOT EXISTS trader_category_stats (
    id SERIAL PRIMARY KEY,
    trader_id INTEGER REFERENCES traders(id),
    category TEXT NOT NULL,             -- matches events.category
    subcategory TEXT,                   -- optional: sport, weather type, etc.
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
    -- Alpha scores per category
    profit_score REAL,
    efficiency_score REAL,
    precision_score REAL,
    conviction_score REAL,
    asymmetry_score REAL,
    alpha_score REAL,
    alpha_tags TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(trader_id, category)
);

-- Track which events have been scanned for trades
CREATE TABLE IF NOT EXISTS scan_progress (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES events(id) UNIQUE,
    trades_fetched INTEGER DEFAULT 0,
    traders_found INTEGER DEFAULT 0,
    scanned_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Copy Trading Tables
-- ============================================================

-- Traders being followed/copied
CREATE TABLE IF NOT EXISTS copy_targets (
    id SERIAL PRIMARY KEY,
    trader_id INTEGER REFERENCES traders(id),
    proxy_wallet TEXT NOT NULL,
    display_name TEXT,
    category TEXT,                       -- optional: scope to category
    status TEXT DEFAULT 'active',        -- active, paused, stopped
    added_by TEXT DEFAULT 'manual',      -- manual, auto, mcp
    added_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trading accounts (paper + live)
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    mode TEXT NOT NULL,                  -- 'paper' or 'live'
    category TEXT,                       -- optional: scope to category
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

-- Paper trading positions
CREATE TABLE IF NOT EXISTS paper_positions (
    id SERIAL PRIMARY KEY,
    copy_target_id INTEGER REFERENCES copy_targets(id),
    market_id INTEGER REFERENCES markets(id),
    event_id INTEGER REFERENCES events(id),
    condition_id TEXT NOT NULL,
    side TEXT NOT NULL,                  -- 'YES' or 'NO'
    entry_price REAL NOT NULL,
    size_usd REAL NOT NULL,
    shares REAL NOT NULL,
    status TEXT DEFAULT 'open',          -- open, closed, expired
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    exit_price REAL,
    pnl REAL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live trading positions (same structure, separate table for safety)
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
    order_id TEXT,                       -- Polymarket CLOB order ID
    tx_hash TEXT,                        -- On-chain transaction hash
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signal audit trail
CREATE TABLE IF NOT EXISTS copy_signals (
    id SERIAL PRIMARY KEY,
    copy_target_id INTEGER REFERENCES copy_targets(id),
    trader_id INTEGER REFERENCES traders(id),
    proxy_wallet TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    market_id INTEGER,
    event_id INTEGER,
    side TEXT NOT NULL,
    outcome TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    signal_type TEXT NOT NULL,           -- 'new_position', 'add', 'exit'
    detected_at TIMESTAMPTZ NOT NULL,
    acted_on BOOLEAN DEFAULT false,
    skip_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backtest runs
CREATE TABLE IF NOT EXISTS backtest_runs (
    id SERIAL PRIMARY KEY,
    category TEXT,
    strategy TEXT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    config JSONB NOT NULL,
    -- Results
    total_return REAL,
    sharpe_ratio REAL,
    max_drawdown REAL,
    win_rate REAL,
    total_trades INTEGER,
    total_pnl REAL,
    equity_curve JSONB,                  -- [{date, equity}]
    per_trader JSONB,                    -- [{traderId, pnl, trades}]
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================

-- Events
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_subcategory ON events(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_events_poly_id ON events(poly_event_id);
CREATE INDEX IF NOT EXISTS idx_events_end_date ON events(end_date);
CREATE INDEX IF NOT EXISTS idx_events_resolved ON events(is_resolved);

-- Markets
CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
CREATE INDEX IF NOT EXISTS idx_markets_condition ON markets(condition_id);

-- Trades
CREATE INDEX IF NOT EXISTS idx_trades_trader ON trades(trader_id);
CREATE INDEX IF NOT EXISTS idx_trades_event ON trades(event_id);
CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);

-- Traders
CREATE INDEX IF NOT EXISTS idx_traders_score ON traders(composite_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_traders_alpha ON traders(alpha_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_traders_wallet ON traders(proxy_wallet);

-- Category stats
CREATE INDEX IF NOT EXISTS idx_category_stats_category ON trader_category_stats(category);
CREATE INDEX IF NOT EXISTS idx_category_stats_trader ON trader_category_stats(trader_id);
CREATE INDEX IF NOT EXISTS idx_category_stats_score ON trader_category_stats(category, composite_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_category_stats_alpha ON trader_category_stats(category, alpha_score DESC NULLS LAST);

-- Copy trading
CREATE INDEX IF NOT EXISTS idx_copy_targets_status ON copy_targets(status);
CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions(status);
CREATE INDEX IF NOT EXISTS idx_paper_positions_target ON paper_positions(copy_target_id);
CREATE INDEX IF NOT EXISTS idx_live_positions_status ON live_positions(status);
CREATE INDEX IF NOT EXISTS idx_copy_signals_target ON copy_signals(copy_target_id);
CREATE INDEX IF NOT EXISTS idx_copy_signals_wallet ON copy_signals(proxy_wallet);

-- Backtest
CREATE INDEX IF NOT EXISTS idx_backtest_runs_category ON backtest_runs(category);

-- ============================================================
-- Default paper trading account
-- ============================================================
INSERT INTO accounts (mode, balance, total_deposited)
VALUES ('paper', 1000, 1000)
ON CONFLICT DO NOTHING;
