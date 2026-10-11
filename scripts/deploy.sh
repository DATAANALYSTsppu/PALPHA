#!/usr/bin/env bash
#
# npm run deploy — pull, rebuild the dashboard, and restart the API + dashboard
# pm2 processes. The API runs under tsx (no build needed); the Next.js dashboard
# must be rebuilt.
#
# The bot (simple-copy-trader) is intentionally NOT restarted here.
#
# Set the two pm2 process names to match `pm2 ls` on this host — either edit the
# defaults below, or pass them in:  API_PROC=my-api DASH_PROC=my-dash npm run deploy
#
set -euo pipefail
cd "$(dirname "$0")/.."

API_PROC="${API_PROC:-palpha-api}"
DASH_PROC="${DASH_PROC:-palpha-dashboard}"

echo "▶ git pull…"
git pull

echo "▶ building core (compiles the API: src → dist/, which palpha-api runs)…"
npm run build --workspace=packages/core

echo "▶ building dashboard…"
npm run build --workspace=packages/dashboard

echo "▶ restarting API ($API_PROC)…"
pm2 restart "$API_PROC" --update-env \
  || { echo "❌ pm2 process '$API_PROC' not found — check 'pm2 ls' and set API_PROC"; exit 1; }

echo "▶ restarting dashboard ($DASH_PROC)…"
pm2 restart "$DASH_PROC" --update-env \
  || { echo "❌ pm2 process '$DASH_PROC' not found — check 'pm2 ls' and set DASH_PROC"; exit 1; }

echo "✓ deployed."
pm2 ls
