#!/usr/bin/env bash
# setup-v3-db.sh — Create polymarket_v3 database and apply v3 schema.
#
# Idempotent: safe to re-run. Will skip CREATE DATABASE if it already exists,
# and the schema file uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
#
# Reads PG superuser creds from ~/.pg-creds (PGHOST, PGUSER, PGPASSWORD, etc.).
# The user in ~/.pg-creds must have CREATEDB privilege.
#
# Usage:
#   ./scripts/setup-v3-db.sh
#   ./scripts/setup-v3-db.sh --dbname polymarket_v3   # explicit name (default)

set -euo pipefail

# ─── Args ─────────────────────────────────────────────────────────
TARGET_DB="polymarket_v3"
for arg in "$@"; do
  case "$arg" in
    --dbname=*)  TARGET_DB="${arg#*=}" ;;
    --dbname)    shift; TARGET_DB="$1" ;;
    -h|--help)
      grep -E '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

# Hard safeguard: target DB name must contain "v3".
# Prevents accidentally running this against polymarket_v2.
if [[ "$TARGET_DB" != *"v3"* ]]; then
  echo "ERROR: target database name '$TARGET_DB' does not contain 'v3' — refusing to run." >&2
  echo "       This script is exclusively for v3 setup. Use --dbname=polymarket_v3 (or similar)." >&2
  exit 1
fi

# ─── Setup ────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA_FILE="$REPO_ROOT/scripts/v3-schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "ERROR: schema file not found: $SCHEMA_FILE" >&2
  exit 1
fi

# Allow override via PG_CREDS_FILE env var (e.g. for v3 on a separate RDS instance)
CREDS_FILE="${PG_CREDS_FILE:-$HOME/.pg-creds}"

if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: $CREDS_FILE not found." >&2
  echo "Create it with PGHOST, PGUSER, PGPASSWORD, PGSSLMODE exports." >&2
  echo "Or set PG_CREDS_FILE env var to point at a different file." >&2
  exit 1
fi

# Load creds — but DON'T inherit PGDATABASE (we connect to 'postgres' first
# to issue CREATE DATABASE, then to TARGET_DB to apply schema)
echo "  Using creds file: $CREDS_FILE"
# shellcheck source=/dev/null
source "$CREDS_FILE"
unset PGDATABASE

echo "===================================================="
echo "  Polymarket Bot: v3 database setup"
echo "  Target DB:  $TARGET_DB"
echo "  Host:       ${PGHOST:-?}"
echo "  User:       ${PGUSER:-?}"
echo "  Schema:     $SCHEMA_FILE"
echo "  Started:    $(date -Iseconds)"
echo "===================================================="
echo

# ─── Step 1: Create database if not exists ────────────────────────

echo "▶ Step 1: ensure database '$TARGET_DB' exists"

EXISTS=$(psql -d postgres -At -c "SELECT 1 FROM pg_database WHERE datname='$TARGET_DB';" 2>/dev/null || echo "")
if [ "$EXISTS" = "1" ]; then
  echo "  ✓ database already exists, skipping CREATE"
else
  echo "  Creating database..."
  psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\";"
  echo "  ✓ created"
fi
echo

# ─── Step 2: Apply schema ─────────────────────────────────────────

echo "▶ Step 2: apply v3 schema"
echo "  This is idempotent (CREATE ... IF NOT EXISTS everywhere)"
t0=$(date +%s)
psql -d "$TARGET_DB" -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE" | tail -50
elapsed=$(( $(date +%s) - t0 ))
echo "  ✓ schema applied in ${elapsed}s"
echo

# ─── Step 3: Verify ───────────────────────────────────────────────

echo "▶ Step 3: verify schema"
echo "  Tables:"
psql -d "$TARGET_DB" -c "\dt" | sed 's/^/    /'
echo
echo "  Trades partitions:"
psql -d "$TARGET_DB" -c "SELECT inhrelid::regclass AS partition FROM pg_inherits WHERE inhparent = 'trades'::regclass ORDER BY 1;" | sed 's/^/    /'
echo
echo "  Schema version:"
psql -d "$TARGET_DB" -c "SELECT * FROM _v3_schema_version;" | sed 's/^/    /'
echo

echo "===================================================="
echo "  ✓ v3 database setup complete"
echo
echo "  Next:"
echo "    1. cp .env-v3.example .env-v3"
echo "    2. Edit .env-v3, set DATABASE_URL to point at $TARGET_DB"
echo "    3. ./scripts/scan-v3-fresh.sh    (in tmux)"
echo "===================================================="
