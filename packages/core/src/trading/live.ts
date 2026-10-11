import { query } from '../db/pool.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import type { TradingEngine, TradingMode, OpenPositionParams, Position } from '../types.js';

const log = createLogger('live-engine');

const CHAIN_ID = 137; // Polygon mainnet
const CLOB_HOST = config.api.clobUrl;

// The signal-detector balance gate calls getBalance() per candidate trade.
// getBalance() now hits the CLOB on-chain balance endpoint, so cache it for a
// short TTL to avoid rate limits. Invalidated whenever an open/close changes
// the proxy's USDC. Override with LIVE_BALANCE_TTL_MS.
const BALANCE_TTL_MS = parseInt(process.env.LIVE_BALANCE_TTL_MS || '15000');

export class LiveTradingEngine implements TradingEngine {
  mode: TradingMode = 'live';
  private client: any = null;
  private initialized = false;
  private balanceCache: { value: number; expiresAt: number } | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const privateKey = process.env.POLY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('POLY_PRIVATE_KEY not set in .env');
    }

    // Polymarket holds USDC and outcome tokens in a proxy wallet, not the EOA.
    // The CLOB client must know the proxy address (POLY_FUNDER) so that orders
    // are signed by the EOA but funded from the proxy. Without this, orders
    // will fail with "insufficient balance" because the EOA holds nothing.
    //
    // signatureType:
    //   0 = EOA (deprecated for Polymarket — funds in EOA, no proxy)
    //   1 = POLY_PROXY (older Polymarket proxy contracts)
    //   2 = POLY_GNOSIS_SAFE (current Polymarket — Gnosis Safe-based proxy)
    const funderAddress = process.env.POLY_FUNDER;
    const sigTypeRaw = process.env.POLY_SIGNATURE_TYPE || '2';
    const signatureType = parseInt(sigTypeRaw);

    if (!funderAddress) {
      throw new Error('POLY_FUNDER not set in .env (your Polymarket proxy wallet address)');
    }

    // V2 client (post April 28 2026 CLOB v2 migration). Legacy
    // @polymarket/clob-client returns order_version_mismatch on negRisk.
    const { ClobClient } = await import('@polymarket/clob-client-v2');
    const { Wallet } = await import('ethers');

    const wallet = new Wallet(privateKey);
    log.info({
      eoa: wallet.address,
      funder: funderAddress,
      signatureType,
    }, 'Initializing live trading engine (CLOB v2)');

    if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_PASSPHRASE) {
      const creds = {
        key: process.env.POLY_API_KEY,
        secret: process.env.POLY_API_SECRET,
        passphrase: process.env.POLY_PASSPHRASE,
      };
      this.client = new ClobClient({
        host: CLOB_HOST,
        chain: CHAIN_ID as any,
        signer: wallet as any,
        creds,
        signatureType: signatureType as any,
        funderAddress,
      });
      log.info('Using existing API credentials with proxy funder');
    } else {
      // First-pass client (no creds) just to derive API key
      this.client = new ClobClient({
        host: CLOB_HOST,
        chain: CHAIN_ID as any,
        signer: wallet as any,
        signatureType: signatureType as any,
        funderAddress,
      });
      log.info('Deriving API credentials...');
      const derived = await this.client.createOrDeriveApiKey();

      const spread = {...derived};
      const apiKey = spread.key || derived['key'] || '';
      const apiSecret = spread.secret || derived['secret'] || '';
      const apiPassphrase = spread.passphrase || derived['passphrase'] || '';

      if (apiKey && apiSecret && apiPassphrase) {
        const creds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };
        this.client = new ClobClient({
          host: CLOB_HOST,
          chain: CHAIN_ID as any,
          signer: wallet as any,
          creds,
          signatureType: signatureType as any,
          funderAddress,
        });
        log.info('API credentials derived with proxy funder — add to .env to skip next time');
      } else {
        log.warn('Could not extract credentials, passing raw object');
        this.client = new ClobClient({
          host: CLOB_HOST,
          chain: CHAIN_ID as any,
          signer: wallet as any,
          creds: derived as any,
          signatureType: signatureType as any,
          funderAddress,
        });
      }
    }

    // Ensure live account exists in DB
    await query(
      `INSERT INTO accounts (mode, balance, total_deposited) VALUES ('live', 0, 0) ON CONFLICT DO NOTHING`
    );

    this.initialized = true;
    log.info('Live trading engine initialized');
  }

  private getClient(): any {
    if (!this.client || !this.initialized) {
      throw new Error('Live engine not initialized. Call initialize() first.');
    }
    return this.client;
  }

  // ─── TradingEngine Interface ───────────────────────────────────

  async openPosition(params: OpenPositionParams): Promise<{ id: number; orderId?: string }> {
    const client = this.getClient();
    const tokenId = params.metadata?.token_id as string;

    if (!tokenId) {
      throw new Error('token_id required in metadata for live orders');
    }

    // Pre-flight: verify book has liquidity & price is sane.
    // Using midpoint from signal-detector as guidance, but for execution we
    // place a MARKET BUY (FOK) and let the CLOB take whatever's on the book.
    const { getOrderBook } = await import('../api/clob.js');
    let bestAsk: number | null = null;
    try {
      const book = await getOrderBook(tokenId);
      if (book.asks && book.asks.length > 0) {
        bestAsk = parseFloat(book.asks[0].price);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, tokenId }, 'Could not fetch orderbook (proceeding anyway)');
    }

    let orderId: string | undefined;
    let orderFailed = false;
    let failReason: string | undefined;
    let actualFillPrice = params.entryPrice;
    let actualSharesFilled = 0;
    let actualUsdSpent = 0;

    // Sanity check: if book exists, ensure price is within reasonable bounds.
    // Reject if best ask is wildly off from what we expect (>20% drift).
    if (bestAsk !== null) {
      if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) {
        orderFailed = true;
        failReason = `invalid_ask_${bestAsk}`;
      } else if (Math.abs(bestAsk - params.entryPrice) / params.entryPrice > 0.20) {
        orderFailed = true;
        failReason = `book_drift_ask=${bestAsk}_expected=${params.entryPrice}`;
      } else if (bestAsk > 0.95) {
        orderFailed = true;
        failReason = `ask_too_high_${bestAsk}`;
      }
    }

    // Verify on-chain USDC balance before submitting (catches bookkeeping drift).
    if (!orderFailed) {
      try {
        const balanceInfo = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
        const balanceUsdc = parseFloat(balanceInfo.balance) / 1_000_000; // 6 decimals
        if (balanceUsdc < params.sizeUsd) {
          orderFailed = true;
          failReason = `onchain_insufficient_${balanceUsdc.toFixed(2)}_<_${params.sizeUsd}`;
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'Balance check failed (proceeding)');
      }
    }

    if (!orderFailed) {
      // Use SDK's createAndPostMarketOrder — handles tick rounding & FOK semantics.
      // For BUY: amount is USD. SDK consumes the orderbook to compute fillable shares.
      // FOK: order fills entirely at acceptable prices, or fails (no resting).
      const orderPayload = {
        tokenID: tokenId,
        side: 'BUY' as const,    // SDK Side enum: 'BUY' | 'SELL'
        amount: params.sizeUsd,  // USD for BUY
      };

      log.info({
        orderPayload,
        conditionId: params.conditionId,
        side: params.side,
        bestAsk,
      }, 'Submitting FOK MARKET BUY order');

      try {
        // Pre-fetch market metadata: without tickSize and negRisk flags, the
        // SDK can build orders with the wrong version → CLOB rejects with
        // HTTP 400 order_version_mismatch on neg-risk or non-default-tick markets.
        const [tickSize, negRisk] = await Promise.all([
          (client as any).getTickSize(tokenId),
          (client as any).getNegRisk(tokenId),
        ]);

        // 3rd arg is OrderType; 'FOK' is the safer default for copy-trading.
        const orderResp = await client.createAndPostMarketOrder(orderPayload, { tickSize, negRisk }, 'FOK');

        log.info({ rawResponse: JSON.stringify(orderResp) }, 'CLOB raw response');

        // SDK response shape (normalized across versions):
        //   { success, errorMsg?, orderID?, status, takingAmount, makingAmount }
        // For FOK BUY:
        //   takingAmount = shares received (CTF tokens, 6 decimals as string)
        //   makingAmount = USDC spent (6 decimals as string)
        //   status: 'matched' | 'unmatched' | 'live' | 'delayed'
        if (orderResp?.success === false || orderResp?.errorMsg) {
          orderFailed = true;
          failReason = orderResp.errorMsg || 'rejected';
        } else if (orderResp?.status === 'unmatched') {
          orderFailed = true;
          failReason = 'unmatched';
        } else if (orderResp?.status === 'live' || orderResp?.status === 'delayed') {
          // FOK should never rest. If it does, something is wrong — cancel.
          orderFailed = true;
          failReason = `unexpected_status_${orderResp.status}`;
          if (orderResp?.orderID) {
            try { await client.cancelOrder({ orderID: orderResp.orderID }); } catch { /* best-effort */ }
          }
        } else if (orderResp?.status === 'matched') {
          const takingRaw = orderResp.takingAmount ?? '0';
          const makingRaw = orderResp.makingAmount ?? '0';
          // Polymarket amounts come back as decimal strings (already in human units).
          const taking = parseFloat(takingRaw);
          const making = parseFloat(makingRaw);
          if (taking > 0 && making > 0) {
            orderId = orderResp.orderID;
            actualSharesFilled = taking;
            actualUsdSpent = making;
            actualFillPrice = making / taking;
          } else {
            orderFailed = true;
            failReason = `zero_fill_taking=${takingRaw}_making=${makingRaw}`;
          }
        } else {
          orderFailed = true;
          failReason = `unknown_status_${orderResp?.status ?? 'none'}`;
        }
      } catch (err) {
        log.error({ err: (err as Error).message, orderPayload }, 'Failed to place order on CLOB');
        orderFailed = true;
        failReason = (err as Error).message;
      }
    }

    // Record in DB. For successful fills, store actual fill price & USD spent
    // (not the requested values). For failures, store the original intent
    // for debugging.
    const status = orderFailed ? 'failed' : 'open';
    const recordedShares = orderFailed ? 0 : actualSharesFilled;
    const recordedSizeUsd = orderFailed ? params.sizeUsd : actualUsdSpent;
    const recordedPrice = orderFailed ? params.entryPrice : actualFillPrice;

    const result = await query(
      `INSERT INTO live_positions
         (copy_target_id, market_id, event_id, condition_id, side, entry_price, size_usd, shares, status, order_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        params.copyTargetId, params.marketId, params.eventId, params.conditionId,
        params.side, recordedPrice, recordedSizeUsd, recordedShares,
        status, orderId || null,
        JSON.stringify({
          ...params.metadata,
          order_id: orderId,
          fail_reason: failReason,
          requested_size_usd: params.sizeUsd,
          requested_price: params.entryPrice,
          actual_fill_price: orderFailed ? null : actualFillPrice,
          actual_shares: orderFailed ? null : actualSharesFilled,
        }),
      ]
    );

    if (orderFailed) {
      log.warn({ positionId: result.rows[0].id, reason: failReason }, 'Position recorded as failed');
    } else {
      // Deduct only what was actually spent on-chain.
      await query(
        `UPDATE accounts SET balance = balance - $1, updated_at = NOW() WHERE mode = 'live'`,
        [actualUsdSpent]
      );
      this.balanceCache = null; // on-chain USDC just dropped — force a refetch
      log.info({
        positionId: result.rows[0].id,
        orderId,
        actualUsdSpent: actualUsdSpent.toFixed(4),
        actualSharesFilled: actualSharesFilled.toFixed(4),
        actualFillPrice: actualFillPrice.toFixed(4),
      }, 'Live position opened (FOK matched)');
    }

    return { id: result.rows[0].id, orderId };
  }

  async closePosition(positionId: number, exitPrice: number, reason: string): Promise<void> {
    // Lock-via-update pattern for idempotency: atomically transition status
    // from 'open' to 'closing'. If row is not 'open' (already closing/closed),
    // rowCount is 0 and we abort. Prevents double-close from overlapping cycles.
    const lockRes = await query(
      `UPDATE live_positions SET status = 'closing'
       WHERE id = $1 AND status = 'open' RETURNING *`,
      [positionId]
    );
    if (lockRes.rowCount === 0) {
      log.warn({ positionId, reason }, 'closePosition: position not in open state, skipping');
      return;
    }
    const pos = lockRes.rows[0];

    // metadata can be jsonb (object) or text (string) depending on schema —
    // handle both. Was a silent close-without-order bug if column is text.
    const meta = typeof pos.metadata === 'string'
      ? (() => { try { return JSON.parse(pos.metadata); } catch { return {}; } })()
      : (pos.metadata || {});
    const tokenId = meta.token_id;

    let closeStatus: 'closed' | 'redeem_pending' | 'close_failed' = 'close_failed';
    let closeOrderId: string | undefined;
    let actualExitPrice = exitPrice;
    let actualSharesSold = 0;
    let actualUsdReceived = 0;
    let closeError: string | undefined;

    if (reason === 'resolved' || reason === 'expired') {
      // Resolved OR expired (past end_date) market: the shares must be REDEEMED
      // on the CTF contract, not sold on CLOB. SELL at 1.0 won't fill (no
      // buyers); SELL at 0.0 is invalid; and for an ended market the orderbook
      // no longer exists, so a SELL returns 404. Routing 'expired' through the
      // normal-SELL path used to 404 → close_failed → revert to 'open', which
      // livelocked the position open forever (it retried the dead SELL every
      // cycle). We mark redeem_pending instead and let a separate redeem job
      // (or manual redemption via Polymarket UI) settle the real payout.
      // Bookkeeping: we credit the expected P/L provisionally since the redeem
      // returns the right USDC. If redeem doesn't happen, accounts drift from
      // on-chain; the reconcile job catches that.
      closeStatus = 'redeem_pending';
      actualSharesSold = pos.shares;
      actualUsdReceived = pos.shares * exitPrice;  // resolved: 1.0/0.0; expired: entryPrice (~breakeven until on-chain redeem reconciles)
      log.info({
        positionId, reason, exitPrice, shares: pos.shares,
      }, 'Market resolved/expired — marked redeem_pending (no CLOB order placed)');
    } else if (reason === 'kill_switch' || !tokenId) {
      // Kill switch or missing token_id: mark closed without trying to sell.
      // For kill_switch, user explicitly wants to stop; manual SELL needed if
      // shares need offloading. For missing token_id, we can't act anyway.
      closeStatus = 'closed';
      actualSharesSold = pos.shares;
      actualUsdReceived = pos.shares * exitPrice;
      log.warn({
        positionId, reason, hasTokenId: !!tokenId,
      }, 'Closing without CLOB order (kill_switch or missing token_id)');
    } else {
      // Normal close: place a MARKET SELL (FOK) at current best bid.
      // Use orderbook-derived price, not the entryPrice or exitPrice argument
      // which may be stale or misleading (especially for 'expired' reason).
      const client = this.getClient();
      try {
        const { getOrderBook } = await import('../api/clob.js');
        const book = await getOrderBook(tokenId);
        const bestBid = book.bids?.[0] ? parseFloat(book.bids[0].price) : null;

        if (bestBid === null || !Number.isFinite(bestBid) || bestBid <= 0) {
          closeError = `no_bid_${bestBid}`;
        } else {
          const sellPayload = {
            tokenID: tokenId,
            side: 'SELL' as const,
            amount: pos.shares,  // SELL: amount is shares
          };
          log.info({ sellPayload, bestBid, positionId }, 'Submitting FOK MARKET SELL order');
          const [tickSize, negRisk] = await Promise.all([
            (client as any).getTickSize(tokenId),
            (client as any).getNegRisk(tokenId),
          ]);
          const orderResp = await client.createAndPostMarketOrder(sellPayload, { tickSize, negRisk }, 'FOK');

          log.info({ rawResponse: JSON.stringify(orderResp), positionId }, 'CLOB close response');

          if (orderResp?.success === false || orderResp?.errorMsg) {
            closeError = orderResp.errorMsg || 'rejected';
          } else if (orderResp?.status === 'unmatched') {
            closeError = 'unmatched';
          } else if (orderResp?.status === 'matched') {
            const taking = parseFloat(orderResp.takingAmount ?? '0'); // USDC received
            const making = parseFloat(orderResp.makingAmount ?? '0'); // shares sold
            if (taking > 0 && making > 0) {
              closeOrderId = orderResp.orderID;
              actualSharesSold = making;
              actualUsdReceived = taking;
              actualExitPrice = taking / making;
              closeStatus = 'closed';
            } else {
              closeError = `zero_fill_taking=${orderResp.takingAmount}_making=${orderResp.makingAmount}`;
            }
          } else if (orderResp?.status === 'live' || orderResp?.status === 'delayed') {
            closeError = `unexpected_status_${orderResp.status}`;
            if (orderResp?.orderID) {
              try { await client.cancelOrder({ orderID: orderResp.orderID }); } catch { /* best-effort */ }
            }
          } else {
            closeError = `unknown_status_${orderResp?.status ?? 'none'}`;
          }
        }
      } catch (err) {
        closeError = (err as Error).message;
        log.error({ err: closeError, positionId }, 'Failed to place close order');
      }
    }

    // A 404 / "not found" from the orderbook means the market has ended and its
    // book no longer exists — there is nothing to sell into. Reverting to 'open'
    // here would livelock: every cycle retries the SELL, gets 404, reverts. Treat
    // it like a resolved market and hold the shares for on-chain redemption.
    if (closeStatus === 'close_failed' && closeError && /404|not\s*found/i.test(closeError)) {
      closeStatus = 'redeem_pending';
      actualSharesSold = pos.shares;
      actualUsdReceived = pos.shares * exitPrice;
      log.warn({ positionId, closeError }, 'Orderbook gone (market ended) — routing to redeem_pending instead of retry-loop');
    }

    // If close failed, reset status back to 'open' so a future cycle can retry.
    // Don't credit balance.
    if (closeStatus === 'close_failed') {
      await query(
        `UPDATE live_positions
           SET status = 'open',
               metadata = metadata || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({ last_close_error: closeError, last_close_attempt: new Date().toISOString() }), positionId]
      );
      log.error({ positionId, closeError }, 'Close failed — position reverted to open for retry');
      return;
    }

    // Compute P/L from actual fill (or expected for redeem_pending).
    const pnl = actualUsdReceived - pos.size_usd;

    await query(
      `UPDATE live_positions
         SET status = $1, exit_price = $2, pnl = $3, closed_at = NOW(),
             order_id = COALESCE($4, order_id),
             metadata = metadata || $5::jsonb
       WHERE id = $6`,
      [
        closeStatus,
        actualExitPrice,
        pnl,
        closeOrderId || null,
        JSON.stringify({
          close_reason: reason,
          actual_exit_price: actualExitPrice,
          actual_shares_sold: actualSharesSold,
          actual_usd_received: actualUsdReceived,
          close_order_id: closeOrderId,
        }),
        positionId,
      ]
    );

    // Credit balance & P/L. For redeem_pending, this is provisional —
    // the on-chain redemption hasn't actually happened yet.
    await query(
      `UPDATE accounts
         SET balance = balance + $1,
             total_pnl = total_pnl + $2,
             realized_pnl = realized_pnl + $2,
             updated_at = NOW()
       WHERE mode = 'live'`,
      [actualUsdReceived, pnl]
    );
    this.balanceCache = null; // on-chain USDC may have changed — force a refetch

    log.info({
      positionId,
      status: closeStatus,
      actualExitPrice: actualExitPrice.toFixed(4),
      pnl: pnl.toFixed(4),
      reason,
    }, 'Live position closed');
  }

  async getBalance(): Promise<number> {
    // Read the REAL on-chain USDC held by the proxy wallet, not the
    // `accounts.balance` bookkeeping row. That row is only seeded for paper
    // (1000) and is never funded for live, so it stays 0 — which made the
    // signal-detector balance gate skip every live entry as
    // 'insufficient_balance' even when the proxy held plenty of USDC.
    // This is the same call openPosition already uses for its pre-flight check.
    // Cached for BALANCE_TTL_MS so the per-candidate-trade gate doesn't hammer
    // CLOB; invalidated on every open/close that moves the proxy's USDC.
    const now = Date.now();
    if (this.balanceCache && this.balanceCache.expiresAt > now) {
      return this.balanceCache.value;
    }
    try {
      const client = this.getClient();
      const info = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const usdc = parseFloat(info.balance) / 1_000_000; // 6 decimals
      if (Number.isFinite(usdc)) {
        this.balanceCache = { value: usdc, expiresAt: now + BALANCE_TTL_MS };
        // Mirror the real on-chain balance into the accounts row so the
        // dashboard /overview can display it — the API server can't sign CLOB
        // calls itself. Fire-and-forget; this is display telemetry, not the
        // trading path.
        void query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE mode = 'live'`, [usdc])
          .catch(() => { /* non-critical */ });
        return usdc;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'On-chain balance fetch failed; falling back to accounts row');
    }
    const res = await query(`SELECT balance FROM accounts WHERE mode = 'live' LIMIT 1`);
    return res.rows[0]?.balance || 0;
  }

  async getOpenPositions(): Promise<Position[]> {
    const res = await query(`SELECT * FROM live_positions WHERE status = 'open'`);
    return res.rows.map(mapRowToPosition);
  }

  async getOpenPositionCount(): Promise<number> {
    const res = await query(`SELECT COUNT(*)::int as cnt FROM live_positions WHERE status = 'open'`);
    return res.rows[0].cnt;
  }

  async getDailyRealizedLoss(): Promise<number> {
    // "Today" in UTC. Net P/L (sums wins and losses) — if you had a +$10 win
    // and a -$15 loss today, net is -$5, not -$15. Stops over-aggressive
    // halting from a rolling 24h window that straddled days.
    // Includes both 'closed' and 'redeem_pending' positions so a winning
    // resolution today counts toward today's net.
    const res = await query(
      `SELECT COALESCE(SUM(pnl), 0)::real as net_pnl
       FROM live_positions
       WHERE status IN ('closed', 'redeem_pending')
         AND closed_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
    );
    const netPnl = res.rows[0].net_pnl ?? 0;
    // Return positive number representing today's net loss (0 if net positive).
    return netPnl < 0 ? Math.abs(netPnl) : 0;
  }

  async hasOpenPositionForMarket(targetId: number, conditionId: string): Promise<boolean> {
    const res = await query(
      `SELECT 1 FROM live_positions WHERE copy_target_id = $1 AND condition_id = $2 AND status = 'open' LIMIT 1`,
      [targetId, conditionId]
    );
    return res.rows.length > 0;
  }

  // ─── Live-Only Methods ─────────────────────────────────────────

  async cancelAllOrders(): Promise<void> {
    const client = this.getClient();
    try {
      await client.cancelAll();
      log.info('All open orders cancelled');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Failed to cancel orders');
    }
  }

  async killSwitch(): Promise<void> {
    log.warn('KILL SWITCH ACTIVATED');
    await this.cancelAllOrders();
    const positions = await this.getOpenPositions();
    for (const pos of positions) {
      await this.closePosition(pos.id, pos.entryPrice, 'kill_switch');
    }
    log.warn({ closed: positions.length }, 'Kill switch complete');
  }
}

function mapRowToPosition(row: any): Position {
  return {
    id: row.id,
    copyTargetId: row.copy_target_id,
    marketId: row.market_id,
    eventId: row.event_id,
    conditionId: row.condition_id,
    side: row.side,
    entryPrice: row.entry_price,
    sizeUsd: row.size_usd,
    shares: row.shares,
    status: row.status,
    openedAt: row.created_at,
    closedAt: row.closed_at,
    exitPrice: row.exit_price,
    pnl: row.pnl,
    metadata: row.metadata || {},
  };
}
