#!/usr/bin/env bash
# v3-reset.sh — Drop all v3 tables and re-apply schema cleanly.
# Use after fixing v3-schema.sql when no critical data has been ingested yet.
#
# Reads PG_CREDS_FILE (default ~/.pg-creds-v3).
# Will hard-refuse if the target DB doesn't have 'v3' in the name.

set -euo pipefail

CREDS_FILE="${PG_CREDS_FILE:-$HOME/.pg-creds-v3}"
TARGET_DB="${1:-polymarket_v3}"

if [[ "$TARGET_DB" != *"v3"* ]]; then
  echo "ERROR: target database '$TARGET_DB' must contain 'v3'." >&2
  exit 1
fi

if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: $CREDS_FILE not found." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$CREDS_FILE"
unset PGDATABASE

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA_FILE="$REPO_ROOT/scripts/v3-schema.sql"

echo "==================================================="
echo "  v3 Reset: drop tables and re-apply schema"
echo "  Target DB: $TARGET_DB"
echo "  Host:      ${PGHOST:-?}"
echo "==================================================="
echo

read -r -p "This will DROP all tables in $TARGET_DB. Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

echo
echo "▶ Dropping all tables in $TARGET_DB..."
psql -d "$TARGET_DB" -v ON_ERROR_STOP=1 <<'EOF'
-- Drop in dependency order (children first). DROP CASCADE handles FKs.
DROP TABLE IF EXISTS execution_log         CASCADE;
DROP TABLE IF EXISTS orderbook_snapshots   CASCADE;
DROP TABLE IF EXISTS position_snapshots    CASCADE;
DROP TABLE IF EXISTS market_price_history  CASCADE;
DROP TABLE IF EXISTS copy_signals          CASCADE;
DROP TABLE IF EXISTS live_positions        CASCADE;
DROP TABLE IF EXISTS paper_positions       CASCADE;
DROP TABLE IF EXISTS copy_targets          CASCADE;
DROP TABLE IF EXISTS accounts              CASCADE;
DROP TABLE IF EXISTS scan_progress         CASCADE;
DROP TABLE IF EXISTS trader_category_stats CASCADE;
DROP TABLE IF EXISTS trader_alias_history  CASCADE;
DROP TABLE IF EXISTS backtest_runs         CASCADE;
DROP TABLE IF EXISTS ingest_checkpoints    CASCADE;
DROP TABLE IF EXISTS _v3_schema_version    CASCADE;
-- Trade partitions then trades parent
DROP TABLE IF EXISTS trades_default CASCADE;
DROP TABLE IF EXISTS trades_2026_04 CASCADE;
DROP TABLE IF EXISTS trades_2026_05 CASCADE;
DROP TABLE IF EXISTS trades_2026_06 CASCADE;
DROP TABLE IF EXISTS trades_2026_07 CASCADE;
DROP TABLE IF EXISTS trades_2026_08 CASCADE;
DROP TABLE IF EXISTS trades_2026_09 CASCADE;
DROP TABLE IF EXISTS trades_2026_10 CASCADE;
DROP TABLE IF EXISTS trades_2026_11 CASCADE;
DROP TABLE IF EXISTS trades_2026_12 CASCADE;
DROP TABLE IF EXISTS trades_2027_01 CASCADE;
DROP TABLE IF EXISTS trades_2027_02 CASCADE;
DROP TABLE IF EXISTS trades_2027_03 CASCADE;
DROP TABLE IF EXISTS trades CASCADE;
-- Last: traders, markets, events
DROP TABLE IF EXISTS traders CASCADE;
DROP TABLE IF EXISTS markets CASCADE;
DROP TABLE IF EXISTS events  CASCADE;
EOF
echo "  ✓ tables dropped"
echo

echo "▶ Re-applying schema from $SCHEMA_FILE"
psql -d "$TARGET_DB" -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE" | tail -20
echo

echo "▶ Verifying"
psql -d "$TARGET_DB" -c "\dt" | head -40

echo
echo "==================================================="
echo "  ✓ v3 reset complete"
echo "==================================================="
