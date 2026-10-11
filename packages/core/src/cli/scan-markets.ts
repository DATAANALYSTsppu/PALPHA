import { loadAllCategories, getAllCategories } from '../registry.js';
import { paginateEvents } from '../api/gamma.js';
import { query, shutdown } from '../db/pool.js';
import { createLogger } from '../logger.js';

const log = createLogger('cli:scan-markets');

async function main() {
  await loadAllCategories();
  const categories = getAllCategories();

  if (categories.length === 0) {
    log.error('No category plugins loaded');
    process.exit(1);
  }

  const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];

  const stats: Record<string, { events: number; markets: number }> = {};

  for (const plugin of categories) {
    if (categoryArg && plugin.name !== categoryArg) continue;

    log.info({ category: plugin.name }, 'Scanning for events');
    stats[plugin.name] = { events: 0, markets: 0 };

    // Scan active events
    for await (const batch of paginateEvents({ active: true, closed: false })) {
      for (const event of batch) {
        if (!plugin.isMatchingEvent(event)) continue;

        const classified = plugin.classifyEvent(event);
        if (!classified) continue;

        // Upsert event
        const eventResult = await query(
          `INSERT INTO events (poly_event_id, title, slug, description, category, subcategory, subcategory_detail, end_date, tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (poly_event_id) DO UPDATE SET
             title = EXCLUDED.title,
             end_date = EXCLUDED.end_date,
             subcategory = EXCLUDED.subcategory,
             subcategory_detail = EXCLUDED.subcategory_detail,
             updated_at = NOW()
           RETURNING id`,
          [classified.polyEventId, classified.title, classified.slug, classified.description,
           classified.category, classified.subcategory, classified.subcategoryDetail,
           classified.endDate, classified.tags]
        );
        const eventDbId = eventResult.rows[0].id;
        stats[plugin.name].events++;

        // Upsert markets
        if (event.markets) {
          for (const market of event.markets) {
            let yesToken: string | null = null;
            let noToken: string | null = null;
            if (market.clobTokenIds) {
              try {
                const tokens = JSON.parse(market.clobTokenIds);
                yesToken = tokens[0] || null;
                noToken = tokens[1] || null;
              } catch { /* ignore */ }
            }

            let resolvedTo: string | null = null;
            if (market.outcomePrices) {
              try {
                const prices = JSON.parse(market.outcomePrices);
                const yesPrice = parseFloat(prices[0]);
                const noPrice = parseFloat(prices[1]);
                if (yesPrice >= 0.99) resolvedTo = 'Yes';
                else if (noPrice >= 0.99) resolvedTo = 'No';
              } catch { /* ignore */ }
            }

            await query(
              `INSERT INTO markets (event_id, condition_id, question, slug, outcome_yes_token, outcome_no_token, is_closed, resolved_to, end_date)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (condition_id) DO UPDATE SET
                 is_closed = EXCLUDED.is_closed,
                 resolved_to = COALESCE(EXCLUDED.resolved_to, markets.resolved_to),
                 outcome_yes_token = COALESCE(EXCLUDED.outcome_yes_token, markets.outcome_yes_token),
                 outcome_no_token = COALESCE(EXCLUDED.outcome_no_token, markets.outcome_no_token)`,
              [eventDbId, market.conditionId, market.question, market.slug,
               yesToken, noToken, market.closed || false, resolvedTo, market.endDate || null]
            );
            stats[plugin.name].markets++;
          }
        }
      }
    }

    // Scan closed/resolved events too (historical data)
    for await (const batch of paginateEvents({ active: false, closed: true }, 100)) {
      for (const event of batch) {
        if (!plugin.isMatchingEvent(event)) continue;
        const classified = plugin.classifyEvent(event);
        if (!classified) continue;

        const eventResult = await query(
          `INSERT INTO events (poly_event_id, title, slug, description, category, subcategory, subcategory_detail, end_date, tags, is_resolved)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
           ON CONFLICT (poly_event_id) DO UPDATE SET
             is_resolved = true,
             updated_at = NOW()
           RETURNING id`,
          [classified.polyEventId, classified.title, classified.slug, classified.description,
           classified.category, classified.subcategory, classified.subcategoryDetail,
           classified.endDate, classified.tags]
        );
        const eventDbId = eventResult.rows[0].id;
        stats[plugin.name].events++;

        if (event.markets) {
          for (const market of event.markets) {
            let yesToken: string | null = null;
            let noToken: string | null = null;
            if (market.clobTokenIds) {
              try { const tokens = JSON.parse(market.clobTokenIds); yesToken = tokens[0]; noToken = tokens[1]; } catch {}
            }
            let resolvedTo: string | null = null;
            if (market.outcomePrices) {
              try {
                const prices = JSON.parse(market.outcomePrices);
                if (parseFloat(prices[0]) >= 0.99) resolvedTo = 'Yes';
                else if (parseFloat(prices[1]) >= 0.99) resolvedTo = 'No';
              } catch {}
            }

            await query(
              `INSERT INTO markets (event_id, condition_id, question, slug, outcome_yes_token, outcome_no_token, is_closed, resolved_to, end_date)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (condition_id) DO UPDATE SET
                 is_closed = true,
                 resolved_to = COALESCE(EXCLUDED.resolved_to, markets.resolved_to)`,
              [eventDbId, market.conditionId, market.question, market.slug,
               yesToken, noToken, true, resolvedTo, market.endDate || null]
            );
            stats[plugin.name].markets++;
          }
        }
      }
    }

    log.info({ category: plugin.name, ...stats[plugin.name] }, 'Scan complete');
  }

  console.log('\n=== Market Scan Results ===');
  for (const [cat, s] of Object.entries(stats)) {
    console.log(`  ${cat}: ${s.events} events, ${s.markets} markets`);
  }

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
