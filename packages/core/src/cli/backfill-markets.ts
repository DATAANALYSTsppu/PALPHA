/**
 * backfill-markets — fetch missing markets from Polymarket CLOB and insert
 * them into our `markets` table, then re-link `live_positions.market_id`.
 *
 * Why this exists:
 * Our `markets` table is populated by the events/markets scanner running
 * against Polymarket's Gamma API. Short-lived sports/weather markets often
 * start AND resolve between scanner runs and never get ingested. Positions
 * the bot opens on those markets land with NULL market_id, and the
 * dashboard has no title to show.
 *
 * This script:
 *   1. Finds every distinct condition_id in `live_positions` (and trades, if
 *      you want — toggle below) where the FK isn't pointing anywhere.
 *   2. Hits CLOB `https://clob.polymarket.com/markets/<condition_id>` for
 *      each one. CLOB has the data because every traded market was on CLOB.
 *   3. Upserts a `markets` row with question, slug, dates, neg_risk,
 *      outcome tokens, and resolved_to (derived from the winning token).
 *   4. Backfills `live_positions.market_id` to point at the new row.
 *
 * Usage:
 *   tsx packages/core/src/cli/backfill-markets.ts          # dry-run, prints plan
 *   tsx packages/core/src/cli/backfill-markets.ts --apply  # write
 *
 * Reusable — re-run any time positions accumulate with NULL market_id.
 */

import { config } from '../config.js';
import { query, shutdown } from '../db/pool.js';
import { request as undiciRequest } from 'undici';

void config;

const CLOB_API = config.api.clobUrl || 'https://clob.polymarket.com';
const UA = 'Mozilla/5.0 (compatible; palpha-backfill/1.0)';

interface ClobToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

interface ClobMarket {
  condition_id: string;
  question?: string;
  market_slug?: string;
  description?: string;
  end_date_iso?: string;
  game_start_time?: string;
  closed?: boolean;
  active?: boolean;
  archived?: boolean;
  neg_risk?: boolean;
  neg_risk_market_id?: string;
  neg_risk_request_id?: string;
  minimum_tick_size?: number;
  minimum_order_size?: number;
  tokens?: ClobToken[];
  tags?: string[];
}

async function fetchClobMarket(conditionId: string): Promise<ClobMarket | null> {
  const url = `${CLOB_API}/markets/${conditionId}`;
  try {
    const res = await undiciRequest(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) {
      const body = await res.body.text();
      throw new Error(`CLOB HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
    }
    return (await res.body.json()) as ClobMarket;
  } catch (err) {
    console.error(`  fetch ${conditionId.slice(0, 14)}.. failed: ${(err as Error).message}`);
    return null;
  }
}

/** Derive resolved_to from CLOB's tokens[].winner field. */
function resolvedTo(m: ClobMarket): string | null {
  if (!m.closed || !m.tokens) return null;
  const winner = m.tokens.find(t => t.winner);
  return winner?.outcome ?? null;
}

/** First/Yes-side token id (for storage in outcome_yes_token). */
function firstToken(m: ClobMarket): string | null {
  return m.tokens?.[0]?.token_id ?? null;
}
function secondToken(m: ClobMarket): string | null {
  return m.tokens?.[1]?.token_id ?? null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const includeTrades = process.argv.includes('--include-trades');

  console.log('=== backfill-markets ===');
  console.log(`  Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  Source: live_positions${includeTrades ? ' + trades' : ''}`);
  console.log('');

  // Collect every condition_id with no resolved market_id link.
  const cidQueries: string[] = [
    `SELECT DISTINCT condition_id FROM live_positions WHERE market_id IS NULL AND condition_id IS NOT NULL`,
  ];
  if (includeTrades) {
    cidQueries.push(
      `SELECT DISTINCT t.market_id::text AS condition_id
         FROM trades t LEFT JOIN markets m ON t.market_id = m.id
        WHERE m.id IS NULL AND t.market_id IS NOT NULL
        LIMIT 1000`,
    );
  }
  const cidSet = new Set<string>();
  for (const q of cidQueries) {
    const r = await query(q);
    for (const row of r.rows) cidSet.add(row.condition_id);
  }
  const cids = [...cidSet];
  console.log(`Found ${cids.length} unique condition_ids missing markets metadata.\n`);
  if (cids.length === 0) {
    await shutdown();
    return;
  }

  // Fetch each from CLOB. Sequential with a small delay to avoid rate limits.
  let fetched = 0, missing = 0;
  const fetchedMarkets: { cid: string; m: ClobMarket }[] = [];
  for (let i = 0; i < cids.length; i++) {
    const cid = cids[i];
    process.stdout.write(`\r  fetching ${i + 1}/${cids.length}: ${cid.slice(0, 14)}..`);
    const m = await fetchClobMarket(cid);
    if (m && m.question) {
      fetched++;
      fetchedMarkets.push({ cid, m });
    } else {
      missing++;
    }
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 50)); // light rate-limit
  }
  console.log(`\n  ✓ ${fetched} found on CLOB, ${missing} not found.\n`);

  // Plan summary
  console.log('--- Plan ---');
  for (const { cid, m } of fetchedMarkets.slice(0, 50)) {
    const r = resolvedTo(m);
    console.log(
      `  ${cid.slice(0, 14)}..  ${(m.question ?? '').slice(0, 55).padEnd(55)}  closed=${m.closed}  resolved_to=${r ?? '—'}  negRisk=${!!m.neg_risk}`,
    );
  }
  if (fetchedMarkets.length > 50) console.log(`  …and ${fetchedMarkets.length - 50} more`);
  console.log('');

  if (!apply) {
    console.log('Dry-run. Re-run with --apply to write rows.');
    await shutdown();
    return;
  }

  // Upsert markets + relink live_positions
  let upserted = 0, relinked = 0, eventsCreated = 0;
  // Synthetic event ids — we don't have a real Polymarket event_id from CLOB,
  // so we use negative IDs in [-2_000_000_000, -1) for backfill-created
  // events. That keeps them out of the way of any future scanner that uses
  // positive Polymarket event IDs. Track the next id we'll assign so we
  // don't collide on a multi-row run.
  const nextSyntheticIdRes = await query(
    `SELECT COALESCE(MIN(poly_event_id), -1) AS min_id FROM events WHERE poly_event_id < 0`,
  );
  let nextSyntheticId = Math.min(-1, (nextSyntheticIdRes.rows[0]?.min_id ?? -1) - 1);

  for (const { cid, m } of fetchedMarkets) {
    // ── 1. Create a synthetic event for this market so dashboard category
    //       lookups have something to display. CLOB's tags array drives the
    //       category. Tags typically look like ["Sports", "Esports", ...].
    //       First-tag-as-category, second-tag-as-subcategory is a workable
    //       approximation. Falls back to "unknown" if no tags.
    let eventId: number | null = null;
    if (m.question) {
      const tags = m.tags ?? [];
      const category = (tags[0] ?? 'unknown').toLowerCase();
      const subcategory = tags[1]?.toLowerCase() ?? null;
      const syntheticPolyEventId = nextSyntheticId--;

      const evRes = await query(
        `INSERT INTO events
           (poly_event_id, title, slug, category, subcategory,
            end_date, start_date, tags, is_resolved)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9)
         RETURNING id`,
        [
          syntheticPolyEventId,
          m.question.slice(0, 500),
          m.market_slug ?? null,
          category,
          subcategory,
          m.end_date_iso ?? null,
          m.game_start_time ?? null,
          tags,
          !!m.closed,
        ],
      );
      eventId = evRes.rows[0]?.id ?? null;
      if (eventId) eventsCreated++;
    }

    // ── 2. Upsert the market with event_id linked.
    const upRes = await query(
      `INSERT INTO markets
         (event_id, condition_id, question, slug, is_closed, resolved_to,
          end_date, start_date,
          neg_risk, neg_risk_market_id, neg_risk_request_id,
          outcome_yes_token, outcome_no_token, tick_size, order_min_size,
          fetched_at, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6,
          $7::timestamptz, $8::timestamptz,
          $9, NULLIF($10,''), NULLIF($11,''),
          $12, $13, $14, $15,
          NOW(), NOW())
       ON CONFLICT (condition_id) DO UPDATE SET
         event_id     = COALESCE(markets.event_id, EXCLUDED.event_id),
         question     = EXCLUDED.question,
         slug         = EXCLUDED.slug,
         is_closed    = EXCLUDED.is_closed,
         resolved_to  = COALESCE(EXCLUDED.resolved_to, markets.resolved_to),
         end_date     = EXCLUDED.end_date,
         start_date   = EXCLUDED.start_date,
         neg_risk     = EXCLUDED.neg_risk,
         outcome_yes_token = COALESCE(markets.outcome_yes_token, EXCLUDED.outcome_yes_token),
         outcome_no_token  = COALESCE(markets.outcome_no_token,  EXCLUDED.outcome_no_token),
         fetched_at   = NOW()
       RETURNING id`,
      [
        eventId,
        cid,
        m.question ?? '',
        m.market_slug ?? null,
        !!m.closed,
        resolvedTo(m),
        m.end_date_iso ?? null,
        m.game_start_time ?? null,
        !!m.neg_risk,
        m.neg_risk_market_id ?? '',
        m.neg_risk_request_id ?? '',
        firstToken(m),
        secondToken(m),
        m.minimum_tick_size ?? null,
        m.minimum_order_size ?? null,
      ],
    );
    if ((upRes.rowCount ?? 0) > 0) upserted++;
  }
  console.log(`✓ Created ${eventsCreated} synthetic event rows (negative poly_event_id).`);
  console.log(`✓ Upserted ${upserted} markets rows.`);

  // Backfill live_positions.market_id AND .event_id so dashboard JOIN
  // picks up the new event row's category / title as well.
  const linkRes = await query(
    `UPDATE live_positions lp
        SET market_id = m.id,
            event_id  = COALESCE(lp.event_id, m.event_id)
       FROM markets m
      WHERE (lp.market_id IS NULL OR lp.event_id IS NULL)
        AND lp.condition_id = m.condition_id`,
  );
  relinked = linkRes.rowCount ?? 0;
  console.log(`✓ Re-linked ${relinked} live_positions rows to their markets/events.`);

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
