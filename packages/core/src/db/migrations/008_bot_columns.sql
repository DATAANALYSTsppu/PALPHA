-- 008: columns, index and seed row the bot needs that 001-007 never created.
--
-- Without this, a database built only from migrations (npm run db:migrate)
-- cannot run the bot: loadState() fails with  column "outcome" does not exist,
-- and recordSignal() fails because the ON CONFLICT target below has no index.
-- scripts/v3-schema.sql already contains all of this, so every statement is
-- idempotent and safe to apply on a v3 database too.

-- The outcome name ("Yes", "No", a team name) and the target trade we copied.
ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS outcome          TEXT;
ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS source_trade_key TEXT;

-- recordSignal() upserts on exactly this 7-tuple.
CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_signals_dedup
  ON copy_signals (proxy_wallet, condition_id, side, outcome, detected_at, price, size);

-- The bot's balance sync / dashboard heartbeat reads accounts.mode = 'live'.
INSERT INTO accounts (mode, balance, total_deposited)
VALUES ('live', 0, 0)
ON CONFLICT DO NOTHING;
