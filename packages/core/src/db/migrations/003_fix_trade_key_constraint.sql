-- 003: Fix trade_key unique index for ON CONFLICT compatibility.
--
-- The partial index (WHERE trade_key IS NOT NULL) doesn't support
-- ON CONFLICT (trade_key) DO NOTHING. Replace with a full unique index.
-- Rows with NULL trade_key (legacy) won't conflict — NULLs are always
-- distinct in a unique index, so this is safe.

DROP INDEX IF EXISTS idx_trades_trade_key;
CREATE UNIQUE INDEX idx_trades_trade_key ON trades (trade_key);

-- Drop the legacy v1 dedup index. It rejects valid trades that happen to
-- share (wallet, market, side, outcome, price, timestamp) — e.g. partial
-- fills in the same second. trade_key is the correct dedup mechanism now.
DROP INDEX IF EXISTS idx_trades_dedup;
