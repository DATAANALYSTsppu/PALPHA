/**
 * Test Data API pagination to find a working approach for full trade fetching.
 */
import { query, shutdown } from '../db/pool.js';

const CONDITION_ID = '0xf7b5491e70b477d451afe7d9c1fde4bf1a927e69ff289d294b96df164f6c10f0';
const BASE = 'https://data-api.polymarket.com';

async function testFetch(label: string, url: string) {
  console.log(`\n--- ${label} ---`);
  console.log(`  URL: ${url}`);
  const start = Date.now();
  const res = await fetch(url);
  const elapsed = Date.now() - start;
  console.log(`  Status: ${res.status} (${elapsed}ms)`);
  if (!res.ok) {
    console.log(`  Body: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json() as any[];
  if (!Array.isArray(data)) {
    console.log(`  Non-array: ${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }
  const timestamps = data.map((t: any) => parseInt(t.timestamp)).filter(Number.isFinite);
  console.log(`  Count: ${data.length}`);
  if (timestamps.length > 0) {
    console.log(`  Ts range: ${Math.min(...timestamps)} - ${Math.max(...timestamps)}`);
  }
  return data;
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'wipe') {
    console.log('Deleting all trades...');
    const t = await query('DELETE FROM trades');
    console.log(`  Deleted ${t.rowCount} trades.`);
    await query('DELETE FROM trader_alias_history');
    const tr = await query('DELETE FROM traders');
    console.log(`  Deleted ${tr.rowCount} traders.`);
    const cp = await query(`DELETE FROM ingest_checkpoints WHERE source LIKE 'trades-v2:%'`);
    console.log(`  Deleted ${cp.rowCount} checkpoints.`);
    await shutdown();
    console.log('\nDone!');
    return;
  }

  // Test 1: What's the actual max records per request?
  console.log('=== Test 1: Max records per request ===');
  for (const limit of [500, 1000, 2000, 5000, 10000]) {
    await testFetch(`limit=${limit}`, `${BASE}/trades?market=${CONDITION_ID}&limit=${limit}`);
  }

  // Test 2: Where does offset break?
  console.log('\n=== Test 2: Offset limits (limit=5000) ===');
  for (const offset of [0, 5000, 10000, 15000, 20000]) {
    const data = await testFetch(`offset=${offset}`, `${BASE}/trades?market=${CONDITION_ID}&limit=5000&offset=${offset}`);
    if (!data) break;
  }

  // Test 3: Does `after` param work? (forward pagination)
  console.log('\n=== Test 3: after param ===');
  const base = await testFetch('baseline (newest 5)', `${BASE}/trades?market=${CONDITION_ID}&limit=5`);
  if (base && base.length > 0) {
    const maxTs = Math.max(...base.map((t: any) => parseInt(t.timestamp)));
    // `after` should return trades newer than maxTs (should be 0 or very few)
    const oldTs = maxTs - 86400; // 24 hours ago
    await testFetch(`after=${oldTs} (24h ago)`, `${BASE}/trades?market=${CONDITION_ID}&limit=5&after=${oldTs}`);
    await testFetch(`before=${oldTs}`, `${BASE}/trades?market=${CONDITION_ID}&limit=5&before=${oldTs}`);
  }

  // Test 4: Fetch by eventId / event_slug instead of conditionId
  console.log('\n=== Test 4: eventId / slug vs market (conditionId) ===');
  const evRes = await query(
    `SELECT e.id, e.poly_event_id, e.slug, e.title FROM events e
     JOIN markets m ON m.event_id = e.id
     WHERE m.condition_id = $1 LIMIT 1`,
    [CONDITION_ID]
  );
  if (evRes.rows[0]) {
    const { poly_event_id, slug, title } = evRes.rows[0];
    console.log(`  Event: ${title} (poly_event_id: ${poly_event_id}, slug: ${slug})`);

    // Try numeric eventId
    await testFetch(`eventId=${poly_event_id}`, `${BASE}/trades?eventId=${poly_event_id}&limit=1000`);
    await testFetch(`eventId=${poly_event_id} offset=3000`, `${BASE}/trades?eventId=${poly_event_id}&limit=1000&offset=3000`);
    await testFetch(`eventId=${poly_event_id} offset=5000`, `${BASE}/trades?eventId=${poly_event_id}&limit=1000&offset=5000`);
    await testFetch(`eventId=${poly_event_id} offset=10000`, `${BASE}/trades?eventId=${poly_event_id}&limit=1000&offset=10000`);

    // Try slug
    if (slug) {
      await testFetch(`eventSlug=${slug}`, `${BASE}/trades?eventSlug=${slug}&limit=1000`);
      await testFetch(`eventSlug=${slug} offset=5000`, `${BASE}/trades?eventSlug=${slug}&limit=1000&offset=5000`);
    }
  }

  // Test 5: cursor_id / next_cursor
  console.log('\n=== Test 5: Check response for cursor fields ===');
  const sample = await fetch(`${BASE}/trades?market=${CONDITION_ID}&limit=2`);
  const sampleBody = await sample.text();
  // Check if it's a wrapper with cursor
  try {
    const parsed = JSON.parse(sampleBody);
    if (Array.isArray(parsed)) {
      console.log('  Response is bare array (no cursor wrapper)');
      if (parsed[0]) {
        console.log('  Trade keys:', Object.keys(parsed[0]).join(', '));
        console.log('  Has id?', 'id' in parsed[0], parsed[0].id);
      }
    } else {
      console.log('  Response keys:', Object.keys(parsed));
      console.log('  next_cursor:', parsed.next_cursor);
    }
  } catch {
    console.log('  Raw:', sampleBody.slice(0, 300));
  }

  await shutdown();
}

main().catch(err => { console.error(err); process.exit(1); });
