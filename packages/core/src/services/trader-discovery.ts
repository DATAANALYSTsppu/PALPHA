import { query } from '../db/pool.js';
import { createLogger } from '../logger.js';
import type { PolyTrade } from '../types.js';

const log = createLogger('trader-discovery');

export async function upsertTrader(trade: PolyTrade): Promise<number> {
  const result = await query(
    `INSERT INTO traders (proxy_wallet, display_name, pseudonym, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($4))
     ON CONFLICT (proxy_wallet) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, traders.display_name),
       pseudonym = COALESCE(EXCLUDED.pseudonym, traders.pseudonym),
       last_seen_at = GREATEST(traders.last_seen_at, EXCLUDED.last_seen_at),
       updated_at = NOW()
     RETURNING id`,
    [trade.proxyWallet, trade.name || null, trade.pseudonym || null, trade.timestamp]
  );
  return result.rows[0].id;
}

export async function insertTrade(
  trade: PolyTrade,
  traderId: number,
  eventId: number,
  marketId: number | null
): Promise<boolean> {
  try {
    const ts = Math.floor(trade.timestamp);
    const result = await query(
      `INSERT INTO trades (trader_id, event_id, market_id, proxy_wallet, side, outcome, price, size, timestamp, trade_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))
       ON CONFLICT (proxy_wallet, COALESCE(market_id, -1), side, outcome, price, timestamp)
       DO NOTHING`,
      [traderId, eventId, marketId, trade.proxyWallet, trade.side, trade.outcome, trade.price, trade.size, ts, ts]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    log.error({ err: (err as Error).message, wallet: trade.proxyWallet, eventId }, 'Trade insert failed');
    return false;
  }
}

export async function updateTraderAggregates(traderId: number): Promise<void> {
  await query(
    `UPDATE traders SET
       total_trades = (SELECT COUNT(*) FROM trades WHERE trader_id = $1),
       total_markets = (SELECT COUNT(DISTINCT market_id) FROM trades WHERE trader_id = $1 AND market_id IS NOT NULL),
       updated_at = NOW()
     WHERE id = $1`,
    [traderId]
  );
}

export async function processEventTrades(
  trades: PolyTrade[],
  eventDbId: number,
  conditionToMarketId: Map<string, number>
): Promise<{ newTraders: number; newTrades: number }> {
  let newTraders = 0;
  let newTrades = 0;
  const traderCache = new Map<string, number>();

  for (const trade of trades) {
    let traderId = traderCache.get(trade.proxyWallet);
    if (!traderId) {
      traderId = await upsertTrader(trade);
      traderCache.set(trade.proxyWallet, traderId);
      newTraders++;
    }
    const marketId = conditionToMarketId.get(trade.conditionId) || null;
    const inserted = await insertTrade(trade, traderId, eventDbId, marketId);
    if (inserted) newTrades++;
  }

  for (const traderId of new Set(traderCache.values())) {
    await updateTraderAggregates(traderId);
  }

  return { newTraders, newTrades };
}
