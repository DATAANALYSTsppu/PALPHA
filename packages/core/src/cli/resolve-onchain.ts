/**
 * resolve-onchain — read CTF payouts for markets the CLOB won't resolve.
 *
 * Sports props (and a good share of plain match markets) settle ON CHAIN only:
 * the CLOB keeps reporting 0.5/0.5 with no winner, so `markets.resolved_to`
 * stays NULL and any position on them sits "open" forever. This reads the
 * payout straight from the ConditionalTokens contract.
 *
 * Usage:
 *   npm run resolve:onchain                 # markets under our OPEN positions
 *   npm run resolve:onchain -- --apply      # ...and write markets.resolved_to
 *   npm run resolve:onchain -- 0xabc… 0xdef…   # specific condition ids
 *
 * Writing resolved_to is all this does; `npm run reconcile:positions --apply`
 * then settles the positions themselves.
 */

import 'dotenv/config';
import { query, shutdown } from '../db/pool.js';
import { fetchOnChainResolution, fetchOnChainWinner, fetchPayoutFraction } from '../services/ctf-resolution.js';

const CLOB_API = 'https://clob.polymarket.com';

async function clobTokens(conditionId: string): Promise<{ tokenId: string; outcome: string }[]> {
  try {
    const res = await fetch(`${CLOB_API}/markets/${conditionId}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const m = (await res.json()) as { tokens?: { token_id: string; outcome: string }[] };
    return (m.tokens ?? []).map(t => ({ tokenId: t.token_id, outcome: t.outcome }));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const explicit = args.filter(a => a.startsWith('0x'));

  let rows: { condition_id: string; question: string | null }[];
  if (explicit.length > 0) {
    const r = await query(
      `SELECT condition_id, question FROM markets WHERE condition_id = ANY($1)`,
      [explicit],
    );
    // Accept ids we've never seen locally too — the chain doesn't need our DB.
    const known = new Set(r.rows.map(x => x.condition_id));
    rows = [
      ...r.rows,
      ...explicit.filter(c => !known.has(c)).map(c => ({ condition_id: c, question: null })),
    ];
  } else {
    const r = await query(
      `SELECT DISTINCT m.condition_id, m.question
         FROM live_positions lp
         JOIN markets m ON m.condition_id = lp.condition_id
        WHERE lp.status = 'open' AND m.resolved_to IS NULL
        ORDER BY m.condition_id`,
    );
    rows = r.rows;
  }

  console.log('=== resolve-onchain ===');
  console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  Markets:  ${rows.length}\n`);

  let resolved = 0;
  let pending = 0;
  let split = 0;

  for (const row of rows) {
    const label = `${row.condition_id.slice(0, 14)}… ${(row.question ?? '').slice(0, 48)}`;
    let payout;
    try {
      payout = await fetchOnChainResolution(row.condition_id);
    } catch (err) {
      console.log(`  ERR      ${label} — ${(err as Error).message}`);
      continue;
    }

    if (!payout) {
      pending++;
      console.log(`  pending  ${label}`);
      continue;
    }
    if (payout.winnerIndex === null) {
      split++;
      console.log(`  split    ${label} — payouts [${payout.numerators.join(',')}]/${payout.denominator}`);
      continue;
    }

    resolved++;
    const winner = await fetchOnChainWinner(row.condition_id, await clobTokens(row.condition_id));

    // Names come from the CLOB, which is exactly what fails on these markets.
    // Without one, report what our OWN open positions are worth — that alone is
    // enough for the reconciler to settle them.
    if (!winner) {
      const held = await query(
        `SELECT lp.id, lp.outcome, lp.metadata->>'token_id' AS token_id,
                CASE WHEN lp.metadata->>'token_id' = m.outcome_yes_token THEN 0
                     WHEN lp.metadata->>'token_id' = m.outcome_no_token  THEN 1
                END AS clob_slot
           FROM live_positions lp
           LEFT JOIN markets m ON m.condition_id = lp.condition_id
          WHERE lp.status='open' AND lp.condition_id = $1`,
        [row.condition_id],
      );
      const parts: string[] = [];
      for (const h of held.rows) {
        const frac = h.token_id ? await fetchPayoutFraction(row.condition_id, h.token_id, h.clob_slot) : null;
        parts.push(`#${h.id} ${h.outcome} → ${frac === null ? 'unmapped' : frac}`);
      }
      console.log(`  RESOLVED ${label} — slot ${payout.winnerIndex}; ${parts.join(', ') || 'no open position'}`);
      continue;
    }

    console.log(`  RESOLVED ${label} → ${winner}`);
    if (apply) {
      await query(
        `UPDATE markets SET resolved_to = $1, is_closed = true
          WHERE condition_id = $2 AND resolved_to IS NULL`,
        [winner, row.condition_id],
      );
    }
  }

  console.log(`\n  resolved ${resolved} · pending ${pending} · split ${split}`);
  if (resolved > 0 && !apply) console.log('  (dry run — re-run with --apply to write resolved_to)');
  if (resolved > 0) console.log('  Positions settle on the bot\'s next reconcile pass (~30 min), or via');
  if (resolved > 0) console.log('  npm run reconcile:positions -- --apply');
  await shutdown();
}

main().catch(async err => {
  console.error(err);
  await shutdown();
  process.exit(1);
});
