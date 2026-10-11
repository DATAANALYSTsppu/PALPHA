-- 006: columns needed for mirror mode (scale-ins + partial exits).
--
-- A position can now be sold in several tranches, so it may realize P/L while
-- still open. `pnl` accumulates realized P/L across tranches; these two make
-- the running state explicit rather than inferred.
--
-- Safe to apply while mirror mode is OFF — nothing reads these until it is on.

ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS proceeds_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS exit_count   INTEGER NOT NULL DEFAULT 0;
