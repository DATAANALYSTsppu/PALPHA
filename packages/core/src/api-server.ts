/**
 * api-server — REST API for the dashboard.
 *
 * Auth model: SSO cookie validation
 *   1. Frontend sends requests with `credentials: 'include'`
 *   2. The auth cookie (default name: `auth_session`, configurable) is read here
 *   3. We POST it to the SSO verify URL (e.g. 6116.ai) with our platform name + API key
 *   4. SSO responds with { userId, email, name, roles }
 *   5. Result is cached in-memory for AUTH_CACHE_TTL_MS (default 5 min)
 *   6. On 401, frontend redirects to NEXT_PUBLIC_AUTH_REDIRECT_URL
 *
 * Dev override: set DEV_AUTH_OVERRIDE=true + send X-Dev-User-Id / X-Dev-Role headers
 *   to bypass cookie auth. Never enable in production.
 */

// Load env BEFORE anything that reads process.env. Try per-package
// (packages/core/.env) first, then fall back to repo-root .env. Both
// layouts work — pick whichever you prefer. Resolved from this file's
// own location so cwd doesn't matter.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
const __envBase = dirname(fileURLToPath(import.meta.url));
for (const path of [
  resolve(__envBase, '..', '.env'),
  resolve(__envBase, '..', '..', '..', '.env'),
]) {
  if (existsSync(path)) {
    loadEnv({ path });
    break;
  }
}

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { query } from './db/pool.js';
import { createLogger } from './logger.js';
import { fetchOpenPositions, buildConsensus, attachBooks, type OpenPosition, type BookInfo } from './services/consensus.js';
import { TraderQualityCache, type QualityConfig } from './services/trader-quality.js';

const log = createLogger('api-server');
const app = express();
const PORT = parseInt(process.env.API_PORT || '3001');

// ─── Auth config ────────────────────────────────────────────────────

const AUTH_VERIFY_URL = process.env.AUTH_VERIFY_URL || '';
const AUTH_PLATFORM_NAME = process.env.AUTH_PLATFORM_NAME || 'palpha';
const AUTH_PLATFORM_API_KEY = process.env.AUTH_PLATFORM_API_KEY || '';
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'auth_session';
const AUTH_CACHE_TTL_MS = parseInt(process.env.AUTH_CACHE_TTL_MS || '300000'); // 5 min
const DEV_AUTH_OVERRIDE = process.env.DEV_AUTH_OVERRIDE === 'true';

// CORS — must reflect dashboard origin and allow credentials
const ALLOWED_ORIGINS = (process.env.DASHBOARD_ORIGIN || 'http://localhost:3000,http://localhost:3003')
  .split(',')
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl) and configured origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// ─── Auth cache (in-memory) ─────────────────────────────────────────

interface CachedUser {
  id: string;
  externalId: string;
  email: string;
  name: string;
  role: 'admin'; // simplified — only admin role for now
  expiresAt: number;
}

const authCache = new Map<string, CachedUser>();

function getCachedUser(cookieValue: string): CachedUser | null {
  const entry = authCache.get(cookieValue);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    authCache.delete(cookieValue);
    return null;
  }
  return entry;
}

function cacheUser(cookieValue: string, user: Omit<CachedUser, 'expiresAt'>) {
  authCache.set(cookieValue, { ...user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}

// Periodic cleanup of expired cache entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCache) {
    if (v.expiresAt < now) authCache.delete(k);
  }
}, 5 * 60 * 1000);

// ─── SSO verification ───────────────────────────────────────────────

interface AuthVerifyResponse {
  success: boolean;
  data?: {
    userId: string;
    email: string;
    name: string;
    roles?: string[];
  };
  error?: string;
}

async function verifyCookieWithSso(cookieValue: string): Promise<CachedUser | null> {
  if (!AUTH_VERIFY_URL) {
    throw new Error('AUTH_VERIFY_URL not configured');
  }

  const cached = getCachedUser(cookieValue);
  if (cached) return cached;

  try {
    const res = await fetch(AUTH_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${AUTH_COOKIE_NAME}=${cookieValue}`,
      },
      body: JSON.stringify({
        platformName: AUTH_PLATFORM_NAME,
        platformApiKey: AUTH_PLATFORM_API_KEY,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log.warn({ status: res.status, statusText: res.statusText }, 'SSO verify HTTP error');
      return null;
    }

    const data = (await res.json()) as AuthVerifyResponse;
    if (!data.success || !data.data) {
      log.warn({ data }, 'SSO returned unsuccessful response');
      return null;
    }

    const user: Omit<CachedUser, 'expiresAt'> = {
      id: data.data.userId,
      externalId: data.data.userId,
      email: data.data.email,
      name: data.data.name,
      role: 'admin', // simplified
    };

    cacheUser(cookieValue, user);
    return { ...user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'SSO verify failed');
    return null;
  }
}

// ─── Auth middleware ────────────────────────────────────────────────

interface AuthedRequest extends express.Request {
  user?: CachedUser;
}

async function authMiddleware(
  req: AuthedRequest,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  // ── Dev override ──
  if (DEV_AUTH_OVERRIDE) {
    const devUserId = req.headers['x-dev-user-id'] as string | undefined;
    const devRole = req.headers['x-dev-role'] as string | undefined;
    if (devUserId && devRole) {
      log.warn({ devUserId, devRole }, 'DEV AUTH OVERRIDE — bypassing cookie auth');
      req.user = {
        id: devUserId,
        externalId: devUserId,
        email: (req.headers['x-dev-email'] as string) || 'dev@local',
        name: (req.headers['x-dev-name'] as string) || 'Dev User',
        role: 'admin',
        expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
      };
      return next();
    }
  }

  // ── Cookie auth ──
  const cookieValue = req.cookies?.[AUTH_COOKIE_NAME];
  if (!cookieValue) {
    res.status(401).json({ error: 'No session cookie' });
    return;
  }

  const user = await verifyCookieWithSso(cookieValue);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.user = user;
  next();
}

// ─── Public routes ──────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── Protected routes (cookie auth) ─────────────────────────────────
//
// All routes below are served at the root of this server. In production they
// are reached at https://api.palpha.6116.ai/<route>. The dedicated `api.`
// subdomain makes a `/api/` prefix redundant, so we don't use one.

app.use(authMiddleware);

// Who am I — used by frontend to check auth + display user info
app.get('/auth/me', (req: AuthedRequest, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { id, externalId, email, name, role } = req.user;
  res.json({ id, externalId, email, name, role });
});

// Overview
//
// Defaults to live trading numbers — that's the bot the user actually cares
// about. Pass ?mode=paper to query paper trading instead. Both modes use the
// same response shape so the frontend doesn't need conditional rendering.
//
// We don't depend on a row in `accounts` for live — the bot doesn't write to
// that table. Instead total_pnl / realized_pnl / balance are computed
// directly from the positions table. (Paper still has an accounts row.)
app.get('/overview', async (req, res) => {
  try {
    const mode = req.query.mode === 'paper' ? 'paper' : 'live';
    const positionsTable = mode === 'paper' ? 'paper_positions' : 'live_positions';

    // Optional date filter on settled performance, so recent numbers aren't
    // drowned out by old campaigns. Either a preset window (?days=N) or a custom
    // range (?from=YYYY-MM-DD&to=YYYY-MM-DD). Applies to the closed-trade counts
    // and realized P/L (by closed_at); balance / open / targets stay current.
    // closed_at exists on live_positions; only apply in live mode (paper is legacy).
    const daysRaw = req.query.days ? parseInt(String(req.query.days), 10) : NaN;
    const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 3650 ? daysRaw : null;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // strict YYYY-MM-DD — safe to inline
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    let sinceClause = '';
    if (mode === 'live') {
      if (DATE_RE.test(from) && DATE_RE.test(to)) {
        sinceClause = `AND closed_at >= '${from}'::date AND closed_at < ('${to}'::date + INTERVAL '1 day')`;
      } else if (DATE_RE.test(from)) {
        sinceClause = `AND closed_at >= '${from}'::date`;
      } else if (windowDays) {
        sinceClause = `AND closed_at >= NOW() - INTERVAL '${windowDays} days'`;
      }
    }

    const [accountRes, openRes, closedRes, eventsRes, tradersRes, targetsRes, heartbeatRes] = await Promise.all([
      // For 'paper' we still read accounts; for 'live' we compute from positions.
      mode === 'paper'
        ? query(`SELECT * FROM accounts WHERE mode = 'paper' LIMIT 1`)
        : query(
            // balance comes from the accounts row, which the live engine keeps
            // synced to the real on-chain USDC each cycle (it can't be computed
            // from positions). total/realized pnl are derived from positions.
            `SELECT
               COALESCE((SELECT balance FROM accounts WHERE mode = 'live' LIMIT 1), 0)::real AS balance,
               COALESCE(SUM(pnl) FILTER (WHERE ${VERIFIED}), 0)::real AS total_pnl,
               COALESCE(SUM(pnl) FILTER (WHERE ${VERIFIED} AND status IN ('closed','expired','redeem_pending') ${sinceClause}), 0)::real AS realized_pnl
             FROM ${positionsTable}`,
          ),
      query(`SELECT COUNT(*)::int as cnt FROM ${positionsTable} WHERE status = 'open'`),
      query(
        `SELECT COUNT(*)::int as total,
                COUNT(CASE WHEN pnl > 0 THEN 1 END)::int as wins,
                COALESCE(SUM(pnl), 0)::real as pnl,
                COALESCE(SUM(size_usd), 0)::real as invested
           FROM ${positionsTable}
          WHERE ${VERIFIED} AND status IN ('closed', 'expired', 'redeem_pending') ${sinceClause}`,
      ),
      query(`SELECT category, COUNT(*)::int as cnt FROM events GROUP BY category ORDER BY category`),
      // Scorer writes to composite_score (not alpha_score — that's a legacy column).
      query(`SELECT COUNT(*)::int as cnt FROM traders WHERE composite_score IS NOT NULL`),
      query(`SELECT COUNT(*)::int as cnt FROM copy_targets WHERE status = 'active'`),
      // Bot heartbeat: the live runner refreshes accounts.updated_at every cycle
      // (balance sync). A recent timestamp ⇒ the bot is alive and polling.
      query(`SELECT updated_at FROM accounts WHERE mode = 'live' LIMIT 1`),
    ]);
    res.json({
      mode,
      account: accountRes.rows[0],
      openCount: openRes.rows[0]?.cnt || 0,
      closed: closedRes.rows[0],
      categories: eventsRes.rows,
      scoredTraders: tradersRes.rows[0]?.cnt || 0,
      activeTargets: targetsRes.rows[0]?.cnt || 0,
      lastSync: heartbeatRes.rows[0]?.updated_at ?? null,
      windowDays: windowDays ?? null,
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Overview query failed');
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Midpoint price cache for unrealized P/L ─────────────────────────
// Polymarket CLOB has rate limits; we cache midpoints for 15s to avoid
// hammering it on every dashboard refresh.
interface MidpointCacheEntry {
  price: number;
  expiresAt: number;
}
const midpointCache = new Map<string, MidpointCacheEntry>();
const MIDPOINT_TTL_MS = 15_000;

async function fetchMidpoints(tokenIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const uncached: string[] = [];
  const now = Date.now();

  for (const tid of tokenIds) {
    if (!tid) continue;
    const cached = midpointCache.get(tid);
    if (cached && cached.expiresAt > now) {
      result.set(tid, cached.price);
    } else {
      uncached.push(tid);
    }
  }

  if (uncached.length === 0) return result;

  // Polymarket /midpoint accepts ?token_id=X. Fetch all in parallel.
  // For huge counts we batch to avoid socket exhaustion.
  const CONCURRENCY = 10;
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    const batch = uncached.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (tid) => {
        try {
          const res = await fetch(
            `https://clob.polymarket.com/midpoint?token_id=${tid}`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (!res.ok) return;
          const data = (await res.json()) as { mid?: string };
          const price = parseFloat(data.mid ?? '');
          if (!Number.isFinite(price)) return;
          midpointCache.set(tid, { price, expiresAt: Date.now() + MIDPOINT_TTL_MS });
          result.set(tid, price);
        } catch {
          // ignore — pos will show stale/no current price
        }
      })
    );
  }

  return result;
}

/**
 * Augment open positions with current_price + unrealized_pnl computed
 * from Polymarket CLOB midpoints. Token id comes from position metadata.
 */
async function augmentWithUnrealizedPnl(positions: Record<string, unknown>[]) {
  const openOnly = positions.filter((p) => p.status === 'open' || p.status === 'closing');
  const tokenIds = openOnly
    .map((p) => {
      const meta = p.metadata;
      if (typeof meta === 'string') {
        try {
          return JSON.parse(meta).token_id as string | undefined;
        } catch {
          return undefined;
        }
      }
      return (meta as { token_id?: string } | undefined)?.token_id;
    })
    .filter((t): t is string => Boolean(t));

  const prices = await fetchMidpoints(Array.from(new Set(tokenIds)));

  return positions.map((p) => {
    const meta = typeof p.metadata === 'string' ? safeJsonParse(p.metadata) : p.metadata;
    const tokenId = (meta as { token_id?: string } | undefined)?.token_id;
    const currentPrice = tokenId ? prices.get(tokenId) : undefined;
    if (currentPrice == null || p.status !== 'open' || !p.shares || !p.entry_price) {
      return { ...p, current_price: null, unrealized_pnl: null };
    }
    // Cost basis of the shares STILL HELD is entry_price * shares. size_usd is
    // cumulative capital deployed (the ROI denominator) and stays put when a
    // position is partially exited, so it would overstate cost here.
    const shares = p.shares as number;
    const positionValue = shares * currentPrice;
    const heldCost = (p.entry_price as number) * shares;
    return {
      ...p,
      current_price: currentPrice,
      unrealized_pnl: positionValue - heldCost,
    };
  });
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─── Positions endpoints ─────────────────────────────────────────────

// LEFT JOIN events: positions whose market hasn't been ingested yet (short-
// lived sports/weather markets that started and resolved between scanner
// runs) would otherwise silently disappear from the dashboard. The frontend
// renders "Unknown market" when title is NULL.
app.get('/positions', async (req, res) => {
  try {
    const JOINS = `FROM paper_positions pp
             LEFT JOIN events  e ON pp.event_id  = e.id
             LEFT JOIN markets m ON pp.condition_id = m.condition_id
             LEFT JOIN copy_targets ct ON pp.copy_target_id = ct.id`;
    const COLS = `pp.*, COALESCE(e.title, m.question) AS title,
                  e.category, e.subcategory, ct.display_name as target_name`;

    const openF = positionFilters({ ...req.query, result: '' }, 'pp');
    const closedF = positionFilters(req.query, 'pp');
    const { limit, offset } = positionPaging(req.query);

    const [openRes, closedRes, countRes, facetRes] = await Promise.all([
      query(`SELECT ${COLS} ${JOINS}
              WHERE pp.status = 'open' ${openF.where}
              ORDER BY pp.opened_at DESC`, openF.params),
      query(`SELECT ${COLS} ${JOINS}
              WHERE pp.status IN ('closed', 'expired') ${closedF.where}
              ORDER BY pp.closed_at DESC NULLS LAST
              LIMIT ${limit} OFFSET ${offset}`, closedF.params),
      query(`SELECT COUNT(*)::int AS n,
                    COALESCE(SUM(pp.pnl) FILTER (WHERE ${verified('pp')}), 0)::real AS pnl,
                    COUNT(*) FILTER (WHERE pp.pnl > 0)::int AS wins
               ${JOINS}
              WHERE pp.status IN ('closed', 'expired') ${closedF.where}`, closedF.params),
      query(`SELECT ARRAY(SELECT DISTINCT ct.display_name FROM paper_positions pp
                            JOIN copy_targets ct ON pp.copy_target_id = ct.id
                           WHERE ct.display_name IS NOT NULL ORDER BY 1) AS targets,
                    ARRAY(SELECT DISTINCT lower(e.category) FROM paper_positions pp
                            JOIN events e ON pp.event_id = e.id
                           WHERE e.category IS NOT NULL ORDER BY 1) AS categories`),
    ]);
    const openWithPnl = await augmentWithUnrealizedPnl(openRes.rows);
    res.json({
      open: openWithPnl,
      closed: closedRes.rows,
      closedTotal: countRes.rows[0]?.n ?? 0,
      closedPnl: countRes.rows[0]?.pnl ?? 0,
      closedWins: countRes.rows[0]?.wins ?? 0,
      limit,
      offset,
      facets: facetRes.rows[0] ?? { targets: [], categories: [] },
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Positions query failed');
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * Shared filter/paging for the two positions endpoints.
 *
 * Everything is applied in SQL: the closed list runs to thousands of rows, so
 * filtering a page that was already truncated to 50 would quietly answer the
 * wrong question.
 *
 *   ?result=won|lost|sold|all   how a closed position ended (P/L sign, or an
 *                               early exit — close_reason target_sold)
 *   ?target=<name>              copy target display name
 *   ?category=<c>               events.category
 *   ?q=<text>                   market title / outcome search
 *   ?days=N | ?from&?to         window over opened_at
 *   ?limit&?offset              paging, closed list only
 */
function positionFilters(
  q: Record<string, unknown>,
  alias: string,
): { where: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  const target = typeof q.target === 'string' ? q.target.trim() : '';
  if (target && target !== 'all') add(`ct.display_name = $?`, target);

  const category = typeof q.category === 'string' ? q.category.trim().toLowerCase() : '';
  if (category && category !== 'all') add(`lower(e.category) = $?`, category);

  const text = typeof q.q === 'string' ? q.q.trim() : '';
  if (text) {
    params.push(`%${text}%`);
    where.push(`(COALESCE(e.title, m.question) ILIKE $${params.length} OR ${alias}.outcome ILIKE $${params.length})`);
  }

  const days = parseInt(String(q.days ?? ''), 10);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (DATE_RE.test(String(q.from ?? '')) && DATE_RE.test(String(q.to ?? ''))) {
    add(`${alias}.opened_at >= $?::date`, String(q.from));
    add(`${alias}.opened_at < ($?::date + INTERVAL '1 day')`, String(q.to));
  } else if (Number.isFinite(days) && days > 0 && days <= 3650) {
    where.push(`${alias}.opened_at >= NOW() - INTERVAL '${days} days'`);
  }

  const result = typeof q.result === 'string' ? q.result.toLowerCase() : '';
  if (result === 'won') where.push(`COALESCE(${alias}.pnl, 0) > 0 AND COALESCE(${alias}.metadata->>'close_reason','') NOT LIKE '%target_sold%'`);
  else if (result === 'lost') where.push(`COALESCE(${alias}.pnl, 0) <= 0 AND COALESCE(${alias}.metadata->>'close_reason','') NOT LIKE '%target_sold%'`);
  else if (result === 'sold') where.push(`COALESCE(${alias}.metadata->>'close_reason','') LIKE '%target_sold%'`);

  return { where: where.length ? ' AND ' + where.join(' AND ') : '', params };
}

/** limit/offset with sane bounds — a CSV export asks for everything at once. */
function positionPaging(q: Record<string, unknown>): { limit: number; offset: number } {
  const l = parseInt(String(q.limit ?? ''), 10);
  const o = parseInt(String(q.offset ?? ''), 10);
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, 5000) : 50,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}

app.get('/positions/live', async (req, res) => {
  try {
    const JOINS = `FROM live_positions lp
             LEFT JOIN events  e ON lp.event_id = e.id
             LEFT JOIN markets m ON lp.condition_id = m.condition_id
             LEFT JOIN copy_targets ct ON lp.copy_target_id = ct.id`;
    const COLS = `lp.*, COALESCE(e.title, m.question) AS title,
                  e.category, e.subcategory, ct.display_name as target_name`;

    // 'result' only means something once a position has finished, so the open
    // list ignores it — otherwise picking "Won" would empty a table of bets
    // that haven't been decided yet.
    const openF = positionFilters({ ...req.query, result: '' }, 'lp');
    const closedF = positionFilters(req.query, 'lp');
    const { limit, offset } = positionPaging(req.query);

    const [openRes, closedRes, countRes, facetRes] = await Promise.all([
      query(`SELECT ${COLS} ${JOINS}
              WHERE lp.status IN ('open', 'closing') ${openF.where}
              ORDER BY lp.opened_at DESC`, openF.params),
      query(`SELECT ${COLS} ${JOINS}
              WHERE lp.status IN ('closed', 'expired', 'redeem_pending') ${closedF.where}
              ORDER BY lp.closed_at DESC NULLS LAST
              LIMIT ${limit} OFFSET ${offset}`, closedF.params),
      query(`SELECT COUNT(*)::int AS n,
                    COALESCE(SUM(lp.pnl) FILTER (WHERE ${verified('lp')}), 0)::real AS pnl,
                    COUNT(*) FILTER (WHERE lp.pnl > 0)::int AS wins
               ${JOINS}
              WHERE lp.status IN ('closed', 'expired', 'redeem_pending') ${closedF.where}`, closedF.params),
      // Options for the filter dropdowns, so they only ever offer values that
      // actually exist in the data.
      query(`SELECT ARRAY(SELECT DISTINCT ct.display_name FROM live_positions lp
                            JOIN copy_targets ct ON lp.copy_target_id = ct.id
                           WHERE ct.display_name IS NOT NULL ORDER BY 1) AS targets,
                    ARRAY(SELECT DISTINCT lower(e.category) FROM live_positions lp
                            JOIN events e ON lp.event_id = e.id
                           WHERE e.category IS NOT NULL ORDER BY 1) AS categories`),
    ]);
    const openWithPnl = await augmentWithUnrealizedPnl(openRes.rows);
    res.json({
      open: openWithPnl,
      closed: closedRes.rows,
      closedTotal: countRes.rows[0]?.n ?? 0,
      closedPnl: countRes.rows[0]?.pnl ?? 0,
      closedWins: countRes.rows[0]?.wins ?? 0,
      limit,
      offset,
      facets: facetRes.rows[0] ?? { targets: [], categories: [] },
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Live positions query failed');
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/traders', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const category = req.query.category as string;
    const minMarkets = parseInt(req.query.min_markets as string) || 20;

    let tradersRes;
    if (category) {
      tradersRes = await query(
        `SELECT t.id, t.proxy_wallet, t.display_name, tcs.total_trades, tcs.total_markets,
                tcs.win_rate, tcs.roi, tcs.total_pnl, tcs.composite_score, tcs.wins, tcs.losses,
                tcs.profit_score, tcs.efficiency_score, tcs.precision_score,
                tcs.conviction_score, tcs.asymmetry_score, tcs.alpha_score, tcs.alpha_tags
         FROM trader_category_stats tcs
         JOIN traders t ON t.id = tcs.trader_id
         WHERE tcs.category = $1 AND tcs.total_markets >= $2
         ORDER BY tcs.composite_score DESC NULLS LAST LIMIT $3`,
        [category, minMarkets, limit]
      );
    } else {
      tradersRes = await query(
        `SELECT id, proxy_wallet, display_name, total_trades, total_markets,
                win_rate, roi, total_pnl, composite_score,
                profit_score, efficiency_score, precision_score,
                conviction_score, asymmetry_score, alpha_score, alpha_tags
         FROM traders WHERE composite_score IS NOT NULL OR alpha_score IS NOT NULL
         ORDER BY COALESCE(alpha_score, composite_score) DESC NULLS LAST LIMIT $1`,
        [limit]
      );
    }

    // LEFT JOIN so manually-added targets without a traders row still appear.
    // SIMPLE_TARGET_WALLETS get inserted with just proxy_wallet — they don't
    // need a traders row to be useful; the bot polls them from the wallet
    // address directly via Polymarket API. Also fall back to matching by
    // proxy_wallet so we pick up trader stats even when trader_id wasn't set.
    const targetsRes = await query(
      `SELECT ct.*,
              COALESCE(t.alpha_score, t2.alpha_score)         AS alpha_score,
              COALESCE(t.composite_score, t2.composite_score) AS composite_score,
              COALESCE(t.total_pnl, t2.total_pnl)             AS trader_pnl,
              COALESCE(t.total_markets, t2.total_markets)     AS trader_markets
         FROM copy_targets ct
         LEFT JOIN traders t  ON t.id  = ct.trader_id
         LEFT JOIN traders t2 ON lower(t2.proxy_wallet) = lower(ct.proxy_wallet)
        ORDER BY ct.status, COALESCE(t.alpha_score, t2.alpha_score) DESC NULLS LAST`,
    );

    res.json({ traders: tradersRes.rows, targets: targetsRes.rows });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Traders query failed');
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/signals', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const limit = parseInt(req.query.limit as string) || 100;

    const [signalsRes, statsRes] = await Promise.all([
      query(
        `SELECT cs.*, ct.display_name as target_name, e.title as event_title, e.category
         FROM copy_signals cs
         LEFT JOIN copy_targets ct ON cs.copy_target_id = ct.id
         LEFT JOIN events e ON cs.event_id = e.id
         ORDER BY cs.created_at DESC LIMIT $1`,
        [limit]
      ),
      query(
        `SELECT COUNT(*)::int as total,
                COUNT(CASE WHEN acted_on THEN 1 END)::int as acted,
                COUNT(CASE WHEN skip_reason IS NOT NULL THEN 1 END)::int as skipped
         FROM copy_signals WHERE created_at >= NOW() - INTERVAL '${hours} hours'`
      ),
    ]);

    res.json({ signals: signalsRes.rows, stats: statsRes.rows[0] });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Signals query failed');
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/backtests', async (_req, res) => {
  try {
    const result = await query(`SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT 300`);
    res.json({ backtests: result.rows });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Backtests query failed');
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /trader-compare?wallet=0x..&days=N | from=YYYY-MM-DD&to=YYYY-MM-DD
 * Per-trade "actual vs ours" for one copy target: every real trade the bot
 * detected (copy_signals) joined to our copy of it (live_positions via
 * source_trade_key). Returns the rows + a summary (copy rate, slippage,
 * win%, realized P/L, ROI). DB-only, real-time — no external calls.
 */
app.get('/trader-compare', async (req, res) => {
  try {
    const wallet = String(req.query.wallet || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'valid ?wallet=0x… required' });
    }
    // Date filter on detected_at (the real trade time): ?days=N or ?from&to.
    const daysRaw = req.query.days ? parseInt(String(req.query.days), 10) : NaN;
    const windowDays = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 3650 ? daysRaw : null;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    let dateClause = '';
    if (DATE_RE.test(from) && DATE_RE.test(to)) {
      dateClause = `AND cs.detected_at >= '${from}'::date AND cs.detected_at < ('${to}'::date + INTERVAL '1 day')`;
    } else if (windowDays) {
      dateClause = `AND cs.detected_at >= NOW() - INTERVAL '${windowDays} days'`;
    }

    const rowsRes = await query(
      `SELECT cs.detected_at,
              cs.outcome,
              cs.condition_id,
              cs.price::real       AS target_price,
              cs.size::real        AS target_size,
              cs.acted_on,
              cs.skip_reason,
              COALESCE(NULLIF(m.question,''), '') AS market,
              lp.id                AS our_position_id,
              lp.entry_price::real AS our_price,
              lp.size_usd::real    AS our_size,
              lp.status            AS our_status,
              lp.exit_price::real  AS our_exit,
              lp.pnl::real         AS our_pnl,
              lp.source_trade_key IS DISTINCT FROM cs.source_trade_key AS our_scale_in,
              (lp.metadata->>'data_issue') AS our_data_issue
         FROM copy_signals cs
         -- Direct match first; failing that, the position this trade scaled
         -- INTO. In mirror mode a repeat buy folds into the open position
         -- instead of creating a row, so a third of our copies join to nothing
         -- on source_trade_key alone and read as if we never traded.
         LEFT JOIN LATERAL (
           SELECT p.* FROM live_positions p
            WHERE p.source_trade_key = cs.source_trade_key
               OR (cs.acted_on
                   AND p.condition_id = cs.condition_id
                   AND lower(p.metadata->>'target_wallet') = lower(cs.proxy_wallet)
                   AND p.opened_at <= cs.detected_at + INTERVAL '5 minutes')
            ORDER BY (p.source_trade_key = cs.source_trade_key) DESC NULLS LAST,
                     p.opened_at DESC
            LIMIT 1
         ) lp ON true
         LEFT JOIN markets m ON m.id = cs.market_id
        WHERE lower(cs.proxy_wallet) = $1 ${dateClause}
        ORDER BY cs.detected_at DESC
        LIMIT 2000`,
      [wallet],
    );

    const rows = rowsRes.rows as Record<string, any>[];
    let copied = 0, filled = 0, slipSum = 0, settled = 0, wins = 0, pnl = 0, invested = 0;
    for (const r of rows) {
      if (r.acted_on) copied++;
      // Skip scale-ins: they carry the POSITION's average entry, not a fill of
      // their own, so differencing it against this trade's price is noise.
      if (r.target_price != null && r.our_price != null && !r.our_scale_in) {
        filled++; slipSum += r.our_price - r.target_price;
      }
      // Settled = the position closed, however it closed. Scoring on
      // exit_price alone missed every position sold before resolution and
      // every voided market (exit 0.5), so most closed trades counted as
      // neither a win nor a loss.
      if (r.our_status === 'closed') { settled++; if ((r.our_pnl ?? 0) > 0) wins++; }
      if (r.our_pnl != null && !r.our_scale_in && !r.our_data_issue) { pnl += r.our_pnl; invested += r.our_size ?? 0; }
    }
    res.json({
      wallet,
      rows,
      summary: {
        total: rows.length,
        copied,
        filled,
        avgSlippage: filled ? slipSum / filled : 0,
        settled,
        wins,
        winRate: settled ? (wins / settled) * 100 : 0,
        realizedPnl: pnl,
        invested,
        roi: invested > 0 ? (pnl / invested) * 100 : 0,
      },
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Trader-compare query failed');
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Target management ──────────────────────────────────────────────

/** Rows whose recorded fill could not be corroborated — the delayed-fill bug
 *  (fixed in e6b5a7e) booked the counterparty's size, and neither the CLOB
 *  order record nor the chain can tell us what we really filled. They stay in
 *  the tables, flagged, but never in a total: left in, they overstate the
 *  account's losses by roughly $369. */
const VERIFIED = `(metadata->>'data_issue') IS NULL`;
const verified = (alias: string) => `(${alias}.metadata->>'data_issue') IS NULL`;

/** Categories a copy target may be scoped to. A target carries a comma-
 *  separated list; the bot copies a trade only if the market's category is in
 *  it. Kept in sync with TARGET_CATEGORIES in the dashboard. */
const TARGET_CATEGORIES = ['sports', 'esports', 'weather'];

/** "Sports, esports" -> "sports,esports". Returns null if nothing valid is
 *  left, so a typo can't silently widen a target to every market. */
function normalizeCategories(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const picked = TARGET_CATEGORIES.filter(c =>
    raw.split(',').some(part => part.trim().toLowerCase() === c)
  );
  return picked.length > 0 ? picked.join(',') : null;
}

/** POST /api/targets — add a wallet as a copy target. */
app.post('/targets', async (req: AuthedRequest, res) => {
  try {
    const { wallet, displayName, category } = req.body ?? {};
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({ error: 'wallet (string) required' });
    }
    const cats = normalizeCategories(category);
    if (!cats) {
      return res.status(400).json({ error: `category must be one or more of: ${TARGET_CATEGORIES.join(', ')}` });
    }
    const w = wallet.toLowerCase().trim();
    if (!/^0x[a-f0-9]{40}$/.test(w)) {
      return res.status(400).json({ error: 'wallet must be a 0x-prefixed 40-hex Ethereum address' });
    }

    // Wallets can be stored checksummed or lower-cased; match case-insensitively
    // so we don't create a second traders/copy_targets row for the same wallet.
    let traderRes = await query(`SELECT id FROM traders WHERE LOWER(proxy_wallet) = $1`, [w]);
    let traderId = traderRes.rows[0]?.id;
    if (!traderId) {
      const inserted = await query(
        `INSERT INTO traders (proxy_wallet, first_seen_at, last_seen_at)
         VALUES ($1, NOW(), NOW()) RETURNING id`,
        [w]
      );
      traderId = inserted.rows[0].id;
    }

    // The unique constraint is on the wallet, so look the target up by wallet
    // (any status) — a trader_id-only lookup misses rows attached to a
    // duplicate traders row and blows up on the unique index.
    const existing = await query(
      `SELECT id FROM copy_targets WHERE LOWER(proxy_wallet) = $1 OR trader_id = $2 LIMIT 1`,
      [w, traderId]
    );

    let targetId: number;
    if (existing.rows.length > 0) {
      targetId = existing.rows[0].id;
      await query(
        `UPDATE copy_targets SET
           status = 'active',
           trader_id = $1,
           proxy_wallet = $2,
           display_name = COALESCE($3, display_name),
           category = COALESCE($4, category),
           updated_at = NOW()
         WHERE id = $5`,
        [traderId, w, displayName || null, category, targetId]
      );
    } else {
      const inserted = await query(
        `INSERT INTO copy_targets (trader_id, proxy_wallet, display_name, category, status, added_by)
         VALUES ($1, $2, $3, $4, 'active', $5) RETURNING id`,
        [traderId, w, displayName || null, cats, req.user?.email || 'dashboard']
      );
      targetId = inserted.rows[0].id;
    }

    res.json({ id: targetId, trader_id: traderId, status: 'active' });
  } catch (err) {
    const e = err as Error & { code?: string };
    log.error({ err: e.message }, 'Add target failed');
    if (e.code === '23505') {
      return res.status(409).json({ error: 'This wallet is already a copy target' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

/** PATCH /targets/:id — update status and/or category. */
app.patch('/targets/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const { status, category } = req.body ?? {};

    const sets: string[] = [];
    const params: unknown[] = [];
    if (status !== undefined) {
      if (!['active', 'paused', 'stopped'].includes(status)) {
        return res.status(400).json({ error: 'status must be active / paused / stopped' });
      }
      params.push(status);
      sets.push(`status = $${params.length}`);
    }
    if (category !== undefined) {
      const cats = normalizeCategories(category);
      if (!cats) {
        return res.status(400).json({ error: `category must be one or more of: ${TARGET_CATEGORIES.join(', ')}` });
      }
      params.push(cats);
      sets.push(`category = $${params.length}`);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'nothing to update (status and/or category)' });
    }

    params.push(id);
    const result = await query(
      `UPDATE copy_targets SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length} RETURNING id, status, category`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'target not found' });
    res.json(result.rows[0]);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Update target failed');
    res.status(500).json({ error: 'Database error' });
  }
});

/** DELETE /targets/:id — soft-delete (sets status=stopped). */
app.delete('/targets/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const result = await query(
      `UPDATE copy_targets SET status = 'stopped', updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'target not found' });
    res.json({ id: result.rows[0].id, status: 'stopped' });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Delete target failed');
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Consensus ──────────────────────────────────────────────────────
//
// GET /consensus?min=1&limit=40
// Markets where our ACTIVE targets overlap: how many traders, which side, how
// much money, and the REAL live Polymarket order book for every side
// (CLOB GET /book — nothing simulated). Positions are cached 60 s per wallet,
// books 10 s, so the dashboard can poll without hammering Polymarket.

const DATA_API = process.env.DATA_API_URL || 'https://data-api.polymarket.com';
const CLOB_API = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
try {
  if (new URL(CLOB_API).hostname !== 'clob.polymarket.com') {
    log.warn({ CLOB_API }, 'CLOB_API_URL is not Polymarket\'s real order book (clob.polymarket.com) — consensus prices will not be real');
  }
} catch { log.warn({ CLOB_API }, 'CLOB_API_URL is not a valid URL'); }
const CONSENSUS_SLIP = (() => {
  const v = parseFloat(process.env.SIMPLE_MAX_SLIPPAGE || '0.05');
  return v > 0 && v < 1 ? v : 0.05;
})();
const QUALITY_CFG: QualityConfig = {
  minRoi: parseFloat(process.env.SIMPLE_QUAL_MIN_ROI || '0.10'),
  minRoiPositions: parseInt(process.env.SIMPLE_QUAL_MIN_POSITIONS || '30', 10),
  minWins: parseInt(process.env.SIMPLE_QUAL_MIN_WINS || '50', 10),
};
const qualityCache = new TraderQualityCache({
  dataUrl: DATA_API,
  cfg: QUALITY_CFG,
  ttlMs: parseInt(process.env.SIMPLE_QUAL_REFRESH_MS || '21600000', 10),
  log: (m) => log.warn(m),
});
const positionsCache = new Map<string, { at: number; rows: OpenPosition[] }>();
const bookCache = new Map<string, BookInfo | null>();
const POSITIONS_TTL_MS = 60_000;

app.get('/consensus', async (req, res) => {
  try {
    const minTraders = Math.max(1, Math.min(50, parseInt(String(req.query.min ?? '1'), 10) || 1));
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? '40'), 10) || 40));

    const t = await query(
      `SELECT lower(proxy_wallet) AS wallet, MAX(COALESCE(display_name, '')) AS name
         FROM copy_targets
        WHERE status = 'active' AND proxy_wallet IS NOT NULL
        GROUP BY lower(proxy_wallet)`,
    );
    const targets: { wallet: string; name: string }[] = t.rows.map((r: { wallet: string; name: string }) => ({
      wallet: r.wallet, name: r.name || `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}`,
    }));

    // Positions per wallet (bounded concurrency; one failing wallet doesn't sink the page).
    const failed: string[] = [];
    const all: OpenPosition[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const tg = targets[idx++];
        const hit = positionsCache.get(tg.wallet);
        if (hit && Date.now() - hit.at < POSITIONS_TTL_MS) { all.push(...hit.rows); continue; }
        try {
          const rows = await fetchOpenPositions(DATA_API, tg.wallet, tg.name);
          positionsCache.set(tg.wallet, { at: Date.now(), rows });
          all.push(...rows);
        } catch (err) {
          failed.push(tg.wallet);
          log.warn({ wallet: tg.wallet, err: (err as Error).message }, 'consensus: positions fetch failed');
          if (hit) all.push(...hit.rows);   // serve stale rather than nothing
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, targets.length)) }, worker));

    const markets = buildConsensus(all, minTraders).slice(0, limit);
    await attachBooks(markets, CLOB_API, { slipCap: CONSENSUS_SLIP, cache: bookCache });

    res.json({
      updatedAt: new Date().toISOString(),
      slippageCap: CONSENSUS_SLIP,
      targetCount: targets.length,
      failedWallets: failed,
      traders: targets.map((tg) => {
        const q = qualityCache.peek(tg.wallet);
        return {
          wallet: tg.wallet, name: tg.name,
          qualified: q?.qualified ?? null,           // null = still being measured
          reasons: q?.reasons ?? [],
          roi: q?.stats?.roi ?? null,
          wins: q?.stats?.wins ?? null,
          losses: q?.stats?.losses ?? null,
          grossWin: q?.stats?.grossWin ?? null,
          grossLoss: q?.stats?.grossLoss ?? null,
        };
      }),
      markets,
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Consensus failed');
    res.status(500).json({ error: 'Consensus failed' });
  }
});

// ─── Start ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log.info(
    {
      port: PORT,
      ssoConfigured: !!AUTH_VERIFY_URL,
      devOverride: DEV_AUTH_OVERRIDE,
      allowedOrigins: ALLOWED_ORIGINS,
    },
    'API server started'
  );
});
