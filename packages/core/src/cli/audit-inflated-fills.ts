/**
 * audit-inflated-fills — find positions whose recorded fill is bigger than the
 * order that produced it, and print the SQL to correct them.
 *
 * Until e6b5a7e the delayed-fill path summed Polymarket's /trades rows, which
 * describe the WHOLE match rather than our slice of it. A $1 buy that hit a
 * large resting order was booked as the counterparty's size — one row landed at
 * $227 of stake on an account that has never held more than ~$10.
 *
 * Read-only: it queries the DB and Polymarket, then prints UPDATE statements.
 * It never writes. Run the SQL yourself once the numbers look right.
 *
 * Usage:
 *   npm run audit:fills              # every position over the cap
 *   npm run audit:fills -- --cap=12  # different threshold
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client-v2';
import { Wallet } from 'ethers';
import { query, shutdown } from '../db/pool.js';
import { config } from '../config.js';

const DATA = process.env.DATA_API_URL || 'https://data-api.polymarket.com';
const FUNDER = (process.env.POLY_FUNDER || '').replace(/"/g, '');

/** getOrder needs L2 auth, so reuse the bot's own credentials. */
let _client: ClobClient | null = null;
function clob(): ClobClient {
  if (!_client) {
    _client = new ClobClient({
      host: config.api.clobUrl,
      chain: 137 as any,
      signer: new Wallet(process.env.POLY_PRIVATE_KEY!.replace(/"/g, '')) as any,
      creds: {
        key: (process.env.POLY_API_KEY || '').replace(/"/g, ''),
        secret: (process.env.POLY_API_SECRET || '').replace(/"/g, ''),
        passphrase: (process.env.POLY_PASSPHRASE || process.env.POLY_API_PASSPHRASE || '').replace(/"/g, ''),
      },
      signatureType: parseInt(process.env.POLY_SIGNATURE_TYPE || '2') as any,
      funderAddress: FUNDER,
    } as any);
  }
  return _client;
}

interface Row {
  id: number;
  opened_at: string;
  entry_price: number;
  size_usd: number;
  shares: number;
  pnl: number;
  proceeds_usd: number;
  exit_price: number | null;
  order_id: string | null;
  token_id: string | null;
  condition_id: string;
}

/** Our real fill for this order, straight from the CLOB's own order record. */
async function fillFromOrder(orderId: string): Promise<{ shares: number; price: number } | null> {
  try {
    const o: any = await (clob() as any).getOrder(orderId);
    const shares = parseFloat(o?.size_matched ?? '0');
    const price = parseFloat(o?.price ?? '0');
    return shares > 0 && price > 0 ? { shares, price } : null;
  } catch (err) {
    console.log(`    getOrder(${orderId.slice(0, 12)}…) failed: ${(err as Error).message}`);
    return null;
  }
}

/** Fallback: our funder's own trades on this token, within a minute of the open.
 *
 *  Weak evidence — /trades is the very feed whose whole-match rows caused the
 *  inflation, so a reconstruction from it is only accepted when its price
 *  agrees with the price we recorded at the time. A 1000-share "fill" at 0.001
 *  against a recorded 0.227 is the counterparty's trade, not ours. */
async function fillFromTrades(r: Row): Promise<{ shares: number; price: number } | null> {
  if (!r.token_id) return null;
  const at = Math.floor(new Date(r.opened_at).getTime() / 1000);
  try {
    const res = await fetch(`${DATA}/trades?user=${FUNDER}&limit=500&offset=0`,
      { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const trades = (await res.json()) as any[];
    const mine = (trades || []).filter(t =>
      String(t.asset) === r.token_id &&
      String(t.side).toUpperCase() === 'BUY' &&
      Math.abs(parseInt(String(t.timestamp ?? 0)) - at) <= 60);
    if (mine.length === 0) return null;
    let shares = 0, usd = 0;
    for (const t of mine) {
      const sz = parseFloat(t.size ?? '0');
      shares += sz;
      usd += sz * parseFloat(t.price ?? '0');
    }
    if (shares <= 0) return null;
    const price = usd / shares;
    if (r.entry_price > 0 && Math.abs(price - r.entry_price) / r.entry_price > 0.25) {
      console.log(`    /trades says ${shares.toFixed(2)} sh @ ${price.toFixed(4)} but we recorded ${r.entry_price} — not our fill, ignoring`);
      return null;
    }
    return { shares, price };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const capArg = process.argv.find(a => a.startsWith('--cap='));
  const cap = capArg ? parseFloat(capArg.split('=')[1]) : 12;

  const res = await query(
    `SELECT id, opened_at, entry_price::real, size_usd::real, shares::real, pnl::real,
            COALESCE(proceeds_usd,0)::real AS proceeds_usd, exit_price::real, order_id,
            metadata->>'token_id' AS token_id, condition_id
       FROM live_positions
      WHERE size_usd > $1
      ORDER BY opened_at`,
    [cap],
  );

  console.log(`=== audit-inflated-fills (cap $${cap}) ===`);
  console.log(`  ${res.rows.length} position(s) over the cap\n`);

  const sql: string[] = [];
  let phantomStake = 0, phantomPnl = 0;

  for (const r of res.rows as Row[]) {
    const real = (r.order_id ? await fillFromOrder(r.order_id) : null) ?? (await fillFromTrades(r));
    if (!real) {
      console.log(`#${r.id}  recorded $${r.size_usd.toFixed(2)} @ ${r.entry_price} — NO fill record found (too old?), skipping`);
      continue;
    }

    const trueStake = real.shares * real.price;
    // Settled at 0 or 1 per share; proceeds we already banked stay as they are.
    const exit = r.exit_price ?? 0;
    const trueProceeds = r.proceeds_usd > 0 ? r.proceeds_usd : exit * real.shares;
    const truePnl = trueProceeds - trueStake;

    phantomStake += r.size_usd - trueStake;
    phantomPnl += r.pnl - truePnl;

    console.log(`#${r.id}  recorded $${r.size_usd.toFixed(2)} / pnl ${r.pnl.toFixed(2)}`
      + `  ->  real ${real.shares.toFixed(4)} sh @ ${real.price.toFixed(4)} = $${trueStake.toFixed(2)} / pnl ${truePnl.toFixed(2)}`);

    sql.push(
      `UPDATE live_positions SET size_usd = ${trueStake.toFixed(6)}, `
      + `entry_price = ${real.price.toFixed(6)}, pnl = ${truePnl.toFixed(6)}, `
      + `proceeds_usd = ${trueProceeds.toFixed(6)}, `
      + `metadata = metadata || '{"corrected":"inflated_fill"}'::jsonb `
      + `WHERE id = ${r.id};`);
  }

  if (sql.length > 0) {
    console.log(`\n  Overstated stake $${phantomStake.toFixed(2)}, overstated loss $${Math.abs(phantomPnl).toFixed(2)}\n`);
    console.log('--- run these yourself, in a transaction ---');
    console.log('BEGIN;');
    for (const s of sql) console.log(s);
    console.log('COMMIT;');
  }
  await shutdown();
}

main().catch(async err => {
  console.error(err);
  await shutdown();
  process.exit(1);
});
