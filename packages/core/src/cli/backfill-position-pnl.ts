/**
 * backfill-position-pnl — fill in pnl/exit_price for closed live_positions
 * that have pnl=NULL.
 *
 * Positions settled via redeem-positions are marked 'closed' but keep pnl=NULL
 * (that job only reconciles on-chain redemption, it doesn't compute P/L). This
 * understates the dashboard's realized P/L and win rate.
 *
 * Win/loss is determined by the TOKEN the position bought, not the outcome
 * string: a position wins iff its metadata.token_id is the market's winning
 * token. (Outcome-string matching breaks on multi-outcome markets — e.g. esports
 * teams or over/under — where side is just 'BUY' and the outcome is a team name.)
 *
 *   won  = metadata.token_id === winning token id (CLOB tokens[].winner)
 *   pnl  = (won ? shares : 0) - size_usd        (payout − cost)
 *   exit = won ? 1.0 : 0.0
 *
 * Dry-run by default. --apply to write. --rebackfill also recomputes rows a
 * previous run already stamped (use it to correct an earlier backfill).
 *
 * Usage:
 *   npx tsx packages/core/src/cli/backfill-position-pnl.ts                       # dry run, pnl IS NULL only
 *   npx tsx packages/core/src/cli/backfill-position-pnl.ts --apply               # write
 *   npx tsx packages/core/src/cli/backfill-position-pnl.ts --rebackfill --apply  # also redo prior backfills
 */
import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';

const CLOB = config.api.clobUrl || 'https://clob.polymarket.com';

/** Winning token id from CLOB tokens[].winner, or null if not resolved. */
async function winningTokenId(conditionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${CLOB}/markets/${conditionId}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const m = (await res.json()) as { closed?: boolean; tokens?: { token_id: string; outcome: string; winner: boolean }[] };
    if (!m.closed || !Array.isArray(m.tokens)) return null;
    return m.tokens.find((t) => t.winner)?.token_id ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const rebackfill = process.argv.includes('--rebackfill');
  console.log(`=== Backfill position P/L ===  mode: ${apply ? 'APPLY' : 'DRY RUN'}${rebackfill ? ' (rebackfill)' : ''}\n`);

  const rows = (
    await query(
      `SELECT id, condition_id, shares, size_usd, metadata->>'token_id' AS token_id
         FROM live_positions
        WHERE status = 'closed'
          AND (pnl IS NULL ${rebackfill ? "OR metadata ? 'pnl_backfilled_at'" : ''})
        ORDER BY id`,
    )
  ).rows as { id: number; condition_id: string; shares: number; size_usd: number; token_id: string | null }[];

  console.log(`Found ${rows.length} positions to evaluate.\n`);
  if (rows.length === 0) {
    await shutdown();
    return;
  }

  let updated = 0;
  let unresolved = 0;
  let wonCount = 0;

  for (const r of rows) {
    if (!r.token_id) {
      console.log(`  pos ${r.id}: no token_id in metadata — skipped`);
      unresolved++;
      continue;
    }
    const winId = await winningTokenId(r.condition_id);
    if (!winId) {
      console.log(`  pos ${r.id}: winner unknown on CLOB — skipped`);
      unresolved++;
      continue;
    }
    const won = winId === r.token_id;
    const exitPrice = won ? 1 : 0;
    const pnl = (won ? r.shares : 0) - r.size_usd;
    if (won) wonCount++;
    console.log(`  pos ${r.id}: ${won ? 'WON ' : 'LOST'}  shares=${r.shares.toFixed(3)}  pnl=${pnl.toFixed(4)}`);

    if (apply) {
      const res = await query(
        `UPDATE live_positions
            SET pnl = $1,
                exit_price = $2,
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('pnl_backfilled_at', NOW()::text)
          WHERE id = $3`,
        [pnl, exitPrice, r.id],
      );
      updated += res.rowCount ?? 0;
    }
  }

  console.log(
    `\n${apply ? `✓ Updated ${updated}` : `(dry-run) would update ${rows.length - unresolved}`} positions — ${wonCount} won, ${rows.length - unresolved - wonCount} lost, ${unresolved} unresolved.`,
  );
  if (!apply) console.log('Re-run with --apply to write.');
  await shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
