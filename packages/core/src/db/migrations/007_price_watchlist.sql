-- 007: Price Re-Check Engine watchlist.
--
-- When a target's BUY cannot be filled inside our price limit (the price has
-- run away since the target's fill), the bot no longer drops the signal for
-- good: it parks it here for up to 10 minutes and re-checks the price at
-- T+30s / 2m / 5m / 8m / 10m. See packages/core/src/services/price-recheck.ts.
--
-- Safe to apply while SIMPLE_RECHECK_ENABLED is off — nothing reads or writes
-- this table until the flag is on. Additive only: no existing table is touched.
--
-- Prices/sizes are DOUBLE PRECISION (not NUMERIC) on purpose: the node `pg`
-- driver returns NUMERIC as a string, and these values must round-trip exactly.

CREATE TABLE IF NOT EXISTS price_watchlist (
    id                BIGSERIAL PRIMARY KEY,

    -- Identity of the claimed target trade (copy_signals row).
    proxy_wallet      TEXT             NOT NULL,          -- target wallet, lower-case
    source_trade_key  TEXT             NOT NULL,          -- = copy_signals.source_trade_key
    condition_id      TEXT             NOT NULL,
    token_id          TEXT             NOT NULL,          -- outcome token we want to buy
    outcome           TEXT             NOT NULL,

    -- The target's fill we are trying to copy.
    target_price      DOUBLE PRECISION NOT NULL,
    target_size       DOUBLE PRECISION NOT NULL,          -- shares
    target_ts         BIGINT           NOT NULL,          -- unix seconds of the target's trade

    -- Best ask when we first saw the price was unavailable (fixed reference
    -- for the "moved against us" test). NULL until the first successful read.
    first_seen_price  DOUBLE PRECISION,

    -- Sizing context captured at enqueue time, so the buy is sized exactly as
    -- the original entry would have been.
    cap_usd           DOUBLE PRECISION NOT NULL,
    cap_kind          TEXT             NOT NULL DEFAULT 'market'
                      CHECK (cap_kind IN ('market', 'event')),

    -- Lifecycle.
    status            TEXT             NOT NULL DEFAULT 'watching'
                      CHECK (status IN ('watching', 'buying', 'bought', 'abandoned')),
    reason            TEXT,                               -- why it ended (abandon reason / 'filled')
    check_count       INTEGER          NOT NULL DEFAULT 0,-- schedule slots consumed (0..5)
    first_seen_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    next_check_at     TIMESTAMPTZ      NOT NULL,
    expires_at        TIMESTAMPTZ      NOT NULL,
    closed_at         TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

    -- Fill details when status = 'bought'.
    fill_price        DOUBLE PRECISION,
    fill_shares       DOUBLE PRECISION,
    fill_usd          DOUBLE PRECISION,

    -- Full re-check history: [{n, at, elapsed_s, price, slippage, max_slip, decision, note}, …]
    history           JSONB            NOT NULL DEFAULT '[]'::jsonb
);

-- One trade is parked at most once (mirrors uq_copy_signals_wallet_trade_key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_watchlist_trade
    ON price_watchlist (proxy_wallet, source_trade_key);

-- One live watch per {target, market, token}: a second failed buy in the same
-- market while one is already parked must not stack a second pending buy.
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_watchlist_active
    ON price_watchlist (proxy_wallet, condition_id, token_id)
    WHERE status IN ('watching', 'buying');

-- The per-cycle "what is due now" scan.
CREATE INDEX IF NOT EXISTS idx_price_watchlist_due
    ON price_watchlist (next_check_at)
    WHERE status = 'watching';

CREATE INDEX IF NOT EXISTS idx_price_watchlist_closed
    ON price_watchlist (closed_at DESC)
    WHERE status IN ('bought', 'abandoned');
