#!/usr/bin/env bash
# v3-fix-prices.sh — Back-correct the buggy `price` in v3 trades.
#
# Background:
# The original on-chain scanner used `price = taker / (maker + taker)`.
# Depending on which side held USDC vs CTF shares for a given trade, this
# produces TWO different stored values for the SAME actual price:
#   - Maker=USDC, Taker=shares (BUY orders): stored = shares/(USDC+shares)
#       → close to 1 for low-price trades
#   - Maker=shares, Taker=USDC (SELL orders): stored = USDC/(USDC+shares)
#       → close to 0 for low-price trades
#
# Universal back-correction (works for both cases):
#   actual_price = LEAST(stored, 1 - stored) / GREATEST(stored, 1 - stored)
#
# Proof: actual = USDC/shares. Both (USDC/total) and (shares/total) appear
# in the data; whichever is smaller is USDC/total (since shares > USDC
# for any valid Polymarket price < 1). Their ratio = USDC/shares = price.
#
# Modes:
#   --check          run a SELECT comparing old vs corrected values for a
#                    sample of trades. Read-only. No DB writes.
#   --wallet=0x...   show the impact for ONE wallet (before/after totals).
#                    Read-only.
#   --apply          actually UPDATE the prices in batched chunks.
#   --wallet-fix=0x  apply ONLY to one wallet (for verification).
#
# Always reads ~/.pg-creds-v3.

set -euo pipefail

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "Usage: $0 --check | --wallet=0x... | --wallet-fix=0x... | --apply" >&2
  echo "  --check          dry-run sample to confirm formula" >&2
  echo "  --wallet=0xABC   compute impact for one wallet (read-only)" >&2
  echo "  --wallet-fix=0xA UPDATE just that wallet (limited blast radius)" >&2
  echo "  --apply          UPDATE all on-chain trades, batched" >&2
  exit 1
fi

# Run with v3 creds
if [ -f "$HOME/.pg-creds-v3" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.pg-creds-v3"
else
  echo "ERROR: ~/.pg-creds-v3 not found" >&2
  exit 1
fi

if [[ "${PGDATABASE:-}" != *"v3"* ]]; then
  echo "ERROR: PGDATABASE '$PGDATABASE' does not contain 'v3' — refusing to run." >&2
  exit 1
fi

case "$MODE" in
  --check)
    echo "▶ DRY RUN: sample trades across all stored-price bands"
    psql -c "
WITH samples AS (
  (SELECT * FROM trades WHERE source='on-chain' AND side IN ('BUY','SELL') AND price BETWEEN 0.05 AND 0.15 LIMIT 3)
  UNION ALL
  (SELECT * FROM trades WHERE source='on-chain' AND side IN ('BUY','SELL') AND price BETWEEN 0.35 AND 0.45 LIMIT 3)
  UNION ALL
  (SELECT * FROM trades WHERE source='on-chain' AND side IN ('BUY','SELL') AND price BETWEEN 0.85 AND 0.95 LIMIT 3)
)
SELECT
  side, outcome,
  ROUND(price::numeric, 4) AS stored_price,
  ROUND((LEAST(price, 1.0 - price) / NULLIF(GREATEST(price, 1.0 - price), 0))::numeric, 4) AS corrected_price,
  size AS shares,
  ROUND((price * size)::numeric, 2) AS stored_invested_usd,
  ROUND((LEAST(price, 1.0 - price) / NULLIF(GREATEST(price, 1.0 - price), 0) * size)::numeric, 2) AS corrected_invested_usd
FROM samples
ORDER BY stored_price;"
    ;;

  --wallet=*)
    WALLET="${MODE#*=}"
    echo "▶ READ-ONLY impact analysis for wallet: $WALLET"
    echo "  Uses corrected price formula + cash-flow PnL (accounts for sells,"
    echo "  splits, merges, redemptions). Matches the new scorer methodology."
    psql -c "
WITH price_fixed AS (
  -- Apply price correction inline (read-only): LEAST(p, 1-p) / GREATEST(p, 1-p)
  SELECT
    t.market_id, m.resolved_to, t.side, t.outcome, t.size,
    CASE
      WHEN t.side IN ('BUY','SELL') AND t.price > 0 AND t.price < 1
        THEN LEAST(t.price, 1.0 - t.price) / NULLIF(GREATEST(t.price, 1.0 - t.price), 0)
      ELSE t.price
    END AS price_corrected,
    t.price AS price_buggy
  FROM trades t
  JOIN markets m ON t.market_id = m.id
  WHERE t.proxy_wallet = LOWER('$WALLET')
    AND m.resolved_to IS NOT NULL
),
flows AS (
  SELECT
    market_id, resolved_to,
    SUM(CASE WHEN side='BUY'  AND outcome='Yes' THEN size ELSE 0 END) AS yes_bought,
    SUM(CASE WHEN side='SELL' AND outcome='Yes' THEN size ELSE 0 END) AS yes_sold,
    SUM(CASE WHEN side='BUY'  AND outcome='No'  THEN size ELSE 0 END) AS no_bought,
    SUM(CASE WHEN side='SELL' AND outcome='No'  THEN size ELSE 0 END) AS no_sold,
    -- New (corrected) cash flows
    SUM(CASE WHEN side='BUY'  AND outcome='Yes' THEN price_corrected * size ELSE 0 END) AS yes_buy_usd_new,
    SUM(CASE WHEN side='SELL' AND outcome='Yes' THEN price_corrected * size ELSE 0 END) AS yes_sell_usd_new,
    SUM(CASE WHEN side='BUY'  AND outcome='No'  THEN price_corrected * size ELSE 0 END) AS no_buy_usd_new,
    SUM(CASE WHEN side='SELL' AND outcome='No'  THEN price_corrected * size ELSE 0 END) AS no_sell_usd_new,
    -- Old (buggy) cash flows for comparison
    SUM(CASE WHEN side='BUY'  AND outcome='Yes' THEN price_buggy * size ELSE 0 END) AS yes_buy_usd_old,
    SUM(CASE WHEN side='BUY'  AND outcome='No'  THEN price_buggy * size ELSE 0 END) AS no_buy_usd_old,
    SUM(CASE WHEN side='SPLIT'  THEN size ELSE 0 END) AS splits_usd,
    SUM(CASE WHEN side='MERGE'  THEN size ELSE 0 END) AS merges_usd,
    SUM(CASE WHEN side='REDEEM' THEN size ELSE 0 END) AS redeems_usd
  FROM price_fixed
  GROUP BY market_id, resolved_to
)
SELECT
  -- Old methodology (buy-and-hold, buggy prices)
  ROUND(SUM(
    CASE WHEN yes_bought > 0 AND resolved_to='Yes' THEN (1.0 - yes_buy_usd_old/NULLIF(yes_bought,0)) * yes_bought
         WHEN yes_bought > 0 AND resolved_to='No'  THEN -(yes_buy_usd_old/NULLIF(yes_bought,0)) * yes_bought ELSE 0 END +
    CASE WHEN no_bought > 0 AND resolved_to='No'   THEN (1.0 - no_buy_usd_old/NULLIF(no_bought,0)) * no_bought
         WHEN no_bought > 0 AND resolved_to='Yes'  THEN -(no_buy_usd_old/NULLIF(no_bought,0)) * no_bought ELSE 0 END
  )::numeric, 2) AS pnl_OLD_buyhold_buggyprice,
  -- New methodology (cash flow, corrected prices)
  ROUND(SUM(
    -- cash in
    yes_sell_usd_new + no_sell_usd_new + merges_usd + redeems_usd +
    -- resolution payout for surviving winning shares
    CASE WHEN resolved_to='Yes' THEN GREATEST(0, GREATEST(0, yes_bought - yes_sold + splits_usd - merges_usd) - redeems_usd)
         WHEN resolved_to='No'  THEN GREATEST(0, GREATEST(0, no_bought  - no_sold  + splits_usd - merges_usd) - redeems_usd)
         ELSE 0 END
    -- minus cash out
    - (yes_buy_usd_new + no_buy_usd_new + splits_usd)
  )::numeric, 2) AS pnl_NEW_cashflow,
  COUNT(*) AS markets_traded
FROM flows;"
    ;;

  --wallet-fix=*)
    WALLET="${MODE#*=}"
    echo "▶ APPLY fix to ONE wallet (limited blast): $WALLET"
    read -r -p "Type 'yes' to continue: " CONFIRM
    [ "$CONFIRM" = "yes" ] || { echo "Cancelled."; exit 0; }
    psql -v ON_ERROR_STOP=1 -c "
\timing on
UPDATE trades
SET price = LEAST(price, 1.0 - price) / NULLIF(GREATEST(price, 1.0 - price), 0)
WHERE proxy_wallet = LOWER('$WALLET')
  AND source = 'on-chain'
  AND side IN ('BUY','SELL')
  AND price > 0 AND price < 1.0;
"
    ;;

  --apply)
    echo "▶ APPLY fix to ALL on-chain trades (batched, ~30-60 min)"
    read -r -p "Type 'yes' to continue: " CONFIRM
    [ "$CONFIRM" = "yes" ] || { echo "Cancelled."; exit 0; }
    psql -v ON_ERROR_STOP=1 <<'SQL'
\timing on
DO $$
DECLARE
  batch_size BIGINT := 20000000;
  start_id   BIGINT := 0;
  max_id     BIGINT;
  updated    BIGINT;
  total      BIGINT := 0;
  t0         TIMESTAMP;
BEGIN
  SELECT MAX(id) INTO max_id FROM trades;
  RAISE NOTICE 'Starting price correction. Max id: %, batch size: %', max_id, batch_size;

  WHILE start_id <= max_id LOOP
    t0 := clock_timestamp();
    UPDATE trades
    SET price = LEAST(price, 1.0 - price) / NULLIF(GREATEST(price, 1.0 - price), 0)
    WHERE id >= start_id
      AND id <  start_id + batch_size
      AND source = 'on-chain'
      AND side IN ('BUY','SELL')
      AND price > 0 AND price < 1.0;
    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'batch [%, %)  updated: %  total: %  took: %',
      start_id, start_id + batch_size, updated, total,
      (clock_timestamp() - t0);
    start_id := start_id + batch_size;
    COMMIT;
  END LOOP;
  RAISE NOTICE 'DONE. Total updated: %', total;
END $$;
SQL
    ;;

  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
