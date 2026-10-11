#!/usr/bin/env bash
# cleanup-after-scan.sh — Post on-chain trade scan cleanup pipeline.
#
# Runs the heavy maintenance steps after the trades-onchain-v2 scan completes:
#   1. Verify scan is finished
#   2. Backfill trader_id on all NULL rows
#   3. Recreate dropped indexes (CONCURRENTLY)
#   4. Refresh markets/events (sports + weather)
#   5. Link orphan trades to newly-discovered markets
#
# Usage:
#   ./scripts/cleanup-after-scan.sh                # run all steps
#   ./scripts/cleanup-after-scan.sh --skip-backfill --skip-indexes  # skip parts
#   ./scripts/cleanup-after-scan.sh --start=3      # start from step 3
#
# Reads ~/.pg-creds for PG env vars (PGHOST, PGUSER, PGPASSWORD, etc.)
#
# All output is logged to /tmp/cleanup-after-scan-<timestamp>.log
# Run inside tmux: `tmux new -s cleanup` then `./scripts/cleanup-after-scan.sh`

set -euo pipefail

# ─── Setup ────────────────────────────────────────────────────────

LOG_FILE="/tmp/cleanup-after-scan-$(date +%Y%m%d-%H%M%S).log"
START_STEP="${START_STEP:-1}"
SKIP_VERIFY=false
SKIP_BACKFILL=false
SKIP_INDEXES=false
SKIP_REFRESH=false
SKIP_ORPHANS=false

for arg in "$@"; do
  case "$arg" in
    --start=*)        START_STEP="${arg#*=}" ;;
    --skip-verify)    SKIP_VERIFY=true ;;
    --skip-backfill)  SKIP_BACKFILL=true ;;
    --skip-indexes)   SKIP_INDEXES=true ;;
    --skip-refresh)   SKIP_REFRESH=true ;;
    --skip-orphans)   SKIP_ORPHANS=true ;;
    -h|--help)
      grep -E '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

# Mirror everything to log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "======================================================"
echo "  Polymarket Bot: post-scan cleanup pipeline"
echo "  Started:  $(date -Iseconds)"
echo "  Log file: $LOG_FILE"
echo "  Start step: $START_STEP"
echo "======================================================"
echo

# Load PG creds
if [ -f "$HOME/.pg-creds" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.pg-creds"
else
  echo "ERROR: ~/.pg-creds not found. Create it with PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE exports." >&2
  exit 1
fi

# Find repo root (script is in repo/scripts/)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
echo "Working dir: $REPO_ROOT"
echo

# ─── Helpers ──────────────────────────────────────────────────────

run_psql() {
  local label="$1"; shift
  echo "▶ $label"
  echo "  started: $(date -Iseconds)"
  local t0
  t0="$(date +%s)"
  psql -v ON_ERROR_STOP=1 "$@"
  local rc=$?
  local elapsed=$(( $(date +%s) - t0 ))
  if [ $rc -eq 0 ]; then
    echo "  ✓ done in ${elapsed}s"
  else
    echo "  ✗ FAILED (rc=$rc) after ${elapsed}s" >&2
  fi
  echo
  return $rc
}

step_header() {
  echo "──────────────────────────────────────────────────────"
  echo "  STEP $1: $2"
  echo "──────────────────────────────────────────────────────"
}

# ─── STEP 1: Verify scan completion ───────────────────────────────

if [ "$START_STEP" -le 1 ] && [ "$SKIP_VERIFY" = false ]; then
  step_header 1 "Verify scan completion"

  STATUS=$(psql -At -c "SELECT status FROM ingest_checkpoints WHERE source='trades-onchain-v2';")
  CURSOR=$(psql -At -c "SELECT cursor_value FROM ingest_checkpoints WHERE source='trades-onchain-v2';")
  echo "  Scan status: $STATUS"
  echo "  Cursor:      $CURSOR"

  if [ "$STATUS" = "running" ]; then
    echo "  ⚠ Scan is still running. Aborting cleanup."
    echo "  Re-run when status is 'idle'."
    exit 1
  fi
  if [ "$STATUS" != "idle" ]; then
    echo "  ⚠ Unexpected status. Investigate before continuing."
    echo "  Use --skip-verify to bypass this check."
    exit 1
  fi
  echo "  ✓ Scan is complete."
  echo
fi

# ─── STEP 2: Backfill trader_id ───────────────────────────────────

if [ "$START_STEP" -le 2 ] && [ "$SKIP_BACKFILL" = false ]; then
  step_header 2 "Backfill trader_id"

  run_psql "2a: Insert distinct wallets into traders" <<'EOF'
\timing on
INSERT INTO traders (proxy_wallet, first_seen_at, last_seen_at)
SELECT DISTINCT proxy_wallet, MIN(trade_date), MAX(trade_date)
FROM trades
WHERE trader_id IS NULL
GROUP BY proxy_wallet
ON CONFLICT (proxy_wallet) DO UPDATE SET
  last_seen_at = GREATEST(traders.last_seen_at, EXCLUDED.last_seen_at);
EOF

  run_psql "2b: Link trades to trader_id (slow — multiple hours)" <<'EOF'
\timing on
UPDATE trades t SET trader_id = tr.id
FROM traders tr
WHERE t.proxy_wallet = tr.proxy_wallet
  AND t.trader_id IS NULL;
EOF
fi

# ─── STEP 3: Recreate indexes (CONCURRENTLY) ──────────────────────

if [ "$START_STEP" -le 3 ] && [ "$SKIP_INDEXES" = false ]; then
  step_header 3 "Recreate indexes (CONCURRENTLY, one at a time)"

  # Each takes 30-90 minutes on a 600M-row table.
  # CONCURRENTLY does NOT lock writes — scan/dashboard can keep working.
  # CREATE INDEX CONCURRENTLY can't run inside a transaction → no \timing.
  declare -a INDEXES=(
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_trade_key ON trades(trade_key)"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_trader ON trades(trader_id)"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_event ON trades(event_id)"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_market ON trades(market_id)"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_timestamp ON trades(\"timestamp\")"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_role ON trades(role)"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_type ON trades(trade_type)"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_source ON trades(source)"
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_tx_hash ON trades(transaction_hash)"
  )

  for sql in "${INDEXES[@]}"; do
    name=$(echo "$sql" | grep -oE 'idx_trades_[a-z_]+' | head -1)
    echo "▶ Creating $name"
    t0=$(date +%s)
    if psql -v ON_ERROR_STOP=1 -c "$sql"; then
      elapsed=$(( $(date +%s) - t0 ))
      echo "  ✓ $name done in ${elapsed}s"
    else
      echo "  ✗ $name FAILED — moving to next" >&2
      # CONCURRENTLY can leave partial 'INVALID' index on failure. Drop it.
      psql -c "DROP INDEX IF EXISTS $name;" || true
    fi
    echo
  done
fi

# ─── STEP 4: Refresh markets/events ───────────────────────────────

if [ "$START_STEP" -le 4 ] && [ "$SKIP_REFRESH" = false ]; then
  step_header 4 "Refresh markets/events (sports + weather)"

  echo "▶ Sports"
  npm run scan:events:v2 -- --tag=sports || echo "  ✗ sports scan failed (continuing)"
  echo

  echo "▶ Weather"
  npm run scan:events:v2 -- --tag=weather || echo "  ✗ weather scan failed (continuing)"
  echo
fi

# ─── STEP 5: Link orphan trades to fresh markets ──────────────────

if [ "$START_STEP" -le 5 ] && [ "$SKIP_ORPHANS" = false ]; then
  step_header 5 "Link orphan trades (NULL market_id) to refreshed markets"

  run_psql "5a: Update event_id, market_id, outcome from token map" <<'EOF'
\timing on
UPDATE trades t
SET market_id = m.id,
    event_id  = m.event_id,
    outcome   = CASE
      WHEN t.asset_token_id = m.outcome_yes_token THEN 'Yes'
      WHEN t.asset_token_id = m.outcome_no_token  THEN 'No'
      ELSE t.outcome
    END
FROM markets m
WHERE t.market_id IS NULL
  AND (t.asset_token_id = m.outcome_yes_token
       OR t.asset_token_id = m.outcome_no_token);
EOF

  run_psql "5b: Link redemptions/splits/merges via condition_id" <<'EOF'
\timing on
UPDATE trades t
SET market_id = m.id,
    event_id  = m.event_id
FROM markets m
WHERE t.market_id IS NULL
  AND t.trade_type IN ('REDEEM', 'SPLIT', 'MERGE')
  AND t.asset_token_id = m.condition_id;
EOF
fi

# ─── Summary ──────────────────────────────────────────────────────

echo "======================================================"
echo "  Cleanup pipeline finished: $(date -Iseconds)"
echo "  Log: $LOG_FILE"
echo "======================================================"

# Summary stats
psql -c "
SELECT
  'trades total'                               AS metric, COUNT(*) AS val FROM trades
UNION ALL
SELECT 'trades with trader_id', COUNT(*) FROM trades WHERE trader_id IS NOT NULL
UNION ALL
SELECT 'trades with market_id', COUNT(*) FROM trades WHERE market_id IS NOT NULL
UNION ALL
SELECT 'traders total', COUNT(*) FROM traders;
" || true
