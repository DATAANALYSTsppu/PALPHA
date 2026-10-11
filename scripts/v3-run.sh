#!/usr/bin/env bash
# v3-run.sh — Run any command with DATABASE_URL pointing at v3.
#
# Reads ~/.pg-creds-v3 (individual PG env vars — handles passwords with $ etc
# safely because they're in single-quoted bash exports).
# Constructs a properly URL-encoded DATABASE_URL.
# Then exec's the command you pass.
#
# Usage:
#   ./scripts/v3-run.sh npm run score
#   ./scripts/v3-run.sh npm run alpha:leaderboard
#   ./scripts/v3-run.sh npx tsx packages/core/src/cli/foo.ts

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command> [args...]" >&2
  echo "Example: $0 npm run score" >&2
  exit 1
fi

CREDS_FILE="${PG_CREDS_FILE:-$HOME/.pg-creds-v3}"
if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: $CREDS_FILE not found" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$CREDS_FILE"

: "${PGHOST:?PGHOST not set in $CREDS_FILE}"
: "${PGUSER:?PGUSER not set in $CREDS_FILE}"
: "${PGPASSWORD:?PGPASSWORD not set in $CREDS_FILE}"

# URL-encode the password using python3 (always available on Ubuntu).
# Handles $, ?, /, @, #, %, &, +, = etc. correctly.
ENCODED_PASS=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=''))" "$PGPASSWORD")
ENCODED_USER=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=''))" "$PGUSER")

# Use polymarket_v3 by default — override via PGDATABASE in creds file.
DB_NAME="${PGDATABASE:-polymarket_v3}"
PORT="${PGPORT:-5432}"
SSLMODE="${PGSSLMODE:-require}"

# Refuse if target DB doesn't look like v3 — safety check.
if [[ "$DB_NAME" != *"v3"* ]]; then
  echo "ERROR: target DB '$DB_NAME' does not contain 'v3' — refusing to run." >&2
  echo "       v3-run.sh is exclusively for v3. Update PGDATABASE in $CREDS_FILE." >&2
  exit 1
fi

# uselibpqcompat=true keeps the old behavior of sslmode=require not enforcing
# cert validation. Required for RDS (signed by AWS internal CA which Node
# doesn't trust). Without it, newer pg-connection-string treats 'require'
# as 'verify-full' and bombs with self-signed-certificate-in-chain.
export DATABASE_URL="postgresql://${ENCODED_USER}:${ENCODED_PASS}@${PGHOST}:${PORT}/${DB_NAME}?uselibpqcompat=true&sslmode=${SSLMODE}"

# Print sanitized banner (no password leak)
echo "─────────────────────────────────────────────────────"
echo "  v3-run wrapper"
echo "  host: $PGHOST  user: $PGUSER  db: $DB_NAME"
echo "  cmd:  $*"
echo "─────────────────────────────────────────────────────"

# Run from repo root
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

exec "$@"
