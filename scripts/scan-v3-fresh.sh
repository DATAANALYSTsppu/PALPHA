#!/usr/bin/env bash
# scan-v3-fresh.sh — Fresh 30-day scan into v3 database.
#
# Sequence:
#   1. Verify .env-v3 points at v3 DB (safety check)
#   2. Refresh events for sports + weather
#   3. Run on-chain trade scan from 30 days ago
#   4. Final ANALYZE for query planner stats
#
# Usage (in tmux):
#   tmux new -s scan-v3
#   ./scripts/scan-v3-fresh.sh

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────

# 30 days back at ~43,200 blocks/day on Polygon (≈2 sec/block)
# Today's block (~86,400,000) - 30 days × 43,200 = 85,104,000
# Adjust if you want a different window.
DEFAULT_FROM_BLOCK="${V3_FROM_BLOCK:-85104000}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env-v3"
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/scan-v3-$(date +%Y%m%d-%H%M%S).log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "===================================================="
echo "  v3 Fresh Scan (30-day window)"
echo "  Started:    $(date -Iseconds)"
echo "  From block: $DEFAULT_FROM_BLOCK"
echo "  Log:        $LOG_FILE"
echo "===================================================="
echo

# ─── Step 0: Sanity checks ────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  echo "Copy .env-v3.example to .env-v3 and set DATABASE_URL." >&2
  exit 1
fi

# Source v3 env. dotenv (used by config.ts) does NOT override existing env vars,
# so the DATABASE_URL we export here will be honored over .env's value.
# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set in $ENV_FILE" >&2
  exit 1
fi

# HARD SAFEGUARD: refuse to run if URL doesn't point at v3.
if [[ "$DATABASE_URL" != *"v3"* ]]; then
  echo "ERROR: DATABASE_URL does not contain 'v3' — refusing to run." >&2
  echo "       Got: $(echo "$DATABASE_URL" | sed 's|://[^@]*@|://***@|')" >&2
  exit 1
fi

# Mask password when echoing
SAFE_URL=$(echo "$DATABASE_URL" | sed 's|://[^@]*@|://***@|')
echo "✓ DATABASE_URL: $SAFE_URL"
echo

cd "$REPO_ROOT"

# ─── Step 1: Refresh events (sports + weather) ────────────────────

echo "▶ Step 1: refresh events (sports)"
t0=$(date +%s)
npm run scan:events:v2 -- --tag=sports || echo "  ⚠ sports failed (continuing)"
elapsed=$(( $(date +%s) - t0 ))
echo "  ✓ sports done in ${elapsed}s"
echo

echo "▶ Step 2: refresh events (weather)"
t0=$(date +%s)
npm run scan:events:v2 -- --tag=weather || echo "  ⚠ weather failed (continuing)"
elapsed=$(( $(date +%s) - t0 ))
echo "  ✓ weather done in ${elapsed}s"
echo

# ─── Step 3: On-chain trade scan ──────────────────────────────────

echo "▶ Step 3: on-chain trade scan from block $DEFAULT_FROM_BLOCK"
echo "  This is the long step. Expect 6-10h on r6g.4xlarge."
echo "  Progress visible in this log file."
t0=$(date +%s)
npm run scan:trades:onchain:v2 -- --from-block="$DEFAULT_FROM_BLOCK"
elapsed=$(( $(date +%s) - t0 ))
echo "  ✓ trade scan done in ${elapsed}s"
echo

# ─── Step 4: ANALYZE for query planner ────────────────────────────

echo "▶ Step 4: ANALYZE trades + traders + events + markets"
t0=$(date +%s)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'EOF'
\timing on
ANALYZE trades;
ANALYZE traders;
ANALYZE events;
ANALYZE markets;
ANALYZE copy_signals;
EOF
elapsed=$(( $(date +%s) - t0 ))
echo "  ✓ ANALYZE done in ${elapsed}s"
echo

# ─── Summary ──────────────────────────────────────────────────────

echo "===================================================="
echo "  ✓ v3 scan complete: $(date -Iseconds)"
echo "===================================================="
echo
echo "Final counts:"
psql "$DATABASE_URL" -c "
SELECT 'events'  AS tbl, COUNT(*) FROM events
UNION ALL SELECT 'markets',  COUNT(*) FROM markets
UNION ALL SELECT 'trades',   COUNT(*) FROM trades
UNION ALL SELECT 'traders',  COUNT(*) FROM traders;
"

echo
echo "Storage usage:"
psql "$DATABASE_URL" -c "
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size,
       pg_size_pretty(pg_total_relation_size('trades'))     AS trades_total;
"

echo
echo "Trades per partition:"
psql "$DATABASE_URL" -c "
SELECT inhrelid::regclass AS partition,
       pg_size_pretty(pg_total_relation_size(inhrelid)) AS size
FROM pg_inherits WHERE inhparent = 'trades'::regclass
ORDER BY 1;
"

echo
echo "Next steps:"
echo "  - npm run score                   # generate trader scores"
echo "  - npm run alpha:leaderboard       # see top alpha traders"
echo "  - npm run copy:add -- add-wallet 0x... --name=alice --category=sports"
echo "  - Switch live trader to .env-v3   # if running full bot"
