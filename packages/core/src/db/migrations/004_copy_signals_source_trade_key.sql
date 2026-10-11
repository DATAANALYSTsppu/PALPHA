-- Add source_trade_key to copy_signals for robust, atomic trade dedup.
--
-- simple-copy-trader (the live:simple runner) claims each target trade by
-- inserting its real trade key (txHash:asset:price:size:ts) under a unique
-- constraint BEFORE placing an order. ON CONFLICT DO NOTHING means a second
-- cycle / process / crash-retry that sees the same trade loses the race, so the
-- same trade can never be bought more than once.
--
-- NULLs are distinct in a Postgres unique index, so existing rows (and the
-- live-trader/signal-detector path, which doesn't set this column) keep
-- source_trade_key NULL and never conflict — only real keys are deduped.

ALTER TABLE copy_signals ADD COLUMN IF NOT EXISTS source_trade_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_signals_wallet_trade_key
  ON copy_signals (proxy_wallet, source_trade_key);
