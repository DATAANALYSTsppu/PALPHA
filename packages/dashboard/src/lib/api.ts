/**
 * API client for the dashboard.
 *
 * - Always sends cookies (`credentials: 'include'`) so the SSO session cookie
 *   set on the parent domain (6116.ai) is forwarded.
 * - On 401, redirects to NEXT_PUBLIC_AUTH_REDIRECT_URL (the SSO login page).
 * - In dev with NEXT_PUBLIC_DEV_USER_ID + NEXT_PUBLIC_DEV_ROLE set, attaches
 *   X-Dev-User-Id / X-Dev-Role headers to bypass cookie auth — matches the
 *   DEV_AUTH_OVERRIDE=true setting on api-server.ts.
 */

// API server is reached at the root of its host. In production that's
// https://api.palpha.6116.ai (a dedicated subdomain, so no `/api/` prefix is
// needed). Locally, the api-server listens on port 4001 by default.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

// Dev override headers — for local development without SSO cookie
const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID;
const DEV_ROLE = process.env.NEXT_PUBLIC_DEV_ROLE;
const DEV_USER_EMAIL = process.env.NEXT_PUBLIC_DEV_USER_EMAIL;
const DEV_USER_NAME = process.env.NEXT_PUBLIC_DEV_USER_NAME;

function getHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (DEV_USER_ID && DEV_ROLE) {
    headers['x-dev-user-id'] = DEV_USER_ID;
    headers['x-dev-role'] = DEV_ROLE;
    if (DEV_USER_EMAIL) headers['x-dev-email'] = DEV_USER_EMAIL;
    if (DEV_USER_NAME) headers['x-dev-name'] = DEV_USER_NAME;
  }
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...getHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      const loginUrl = process.env.NEXT_PUBLIC_AUTH_REDIRECT_URL;
      if (loginUrl) {
        window.location.href = loginUrl;
        return new Promise(() => {}); // never resolves — page is redirecting
      }
    }
    const body = await res.text();
    throw new Error(`API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ─── Typed endpoint helpers ─────────────────────────────────────────

export interface AuthUser {
  id: string;
  externalId: string;
  email: string;
  name: string;
  role: 'admin';
}

export const authApi = {
  me: () => api.get<AuthUser>('/auth/me'),
};

export interface OverviewResponse {
  account: { balance: number; total_pnl: number; realized_pnl: number };
  openCount: number;
  closed: { total: number; wins: number; pnl: number; invested?: number };
  categories: { category: string; cnt: number }[];
  scoredTraders: number;
  activeTargets: number;
  /** Live runner heartbeat (accounts.updated_at) — recent ⇒ bot is alive. */
  lastSync?: string | null;
}

export interface Position {
  id: number;
  copy_target_id: number;
  market_id: number;
  event_id: number;
  condition_id: string;
  side: string;
  entry_price: number;
  size_usd: number;
  shares: number;
  status: string;
  opened_at: string;
  closed_at?: string;
  exit_price?: number;
  /** USDC actually received across every exit + settlement. Authoritative for
   *  a closed position: shares are zeroed on settle, so exit_price * shares is
   *  not. */
  proceeds_usd?: number;
  pnl?: number;
  title?: string;
  category?: string;
  subcategory?: string;
  target_name?: string;
  outcome?: string;
  /** Server-side metadata blob — includes close_reason for closed positions. */
  metadata?: {
    close_reason?: 'target_sold' | 'redeemed_win' | 'redeemed_loss'
                  | 'redeemed_win_inferred' | 'redeemed_loss_inferred'
                  | 'redeemed_win_reconciled'
                  | 'closed_assumed_loss_reconciled_manually'
                  | 'manual' | string;
    token_id?: string;
    /** Set when the recorded fill could not be corroborated — excluded from totals. */
    data_issue?: string;
    target_wallet?: string;
    position_key?: string;
  };
  /** Augmented from CLOB midpoint for open positions */
  current_price?: number | null;
  unrealized_pnl?: number | null;
}

export interface Trader {
  id: number;
  proxy_wallet: string;
  display_name?: string;
  total_trades: number;
  total_markets: number;
  win_rate?: number;
  roi?: number;
  total_pnl?: number;
  composite_score?: number;
  alpha_score?: number;
  alpha_tags?: string;
  wins?: number;
  losses?: number;
}

export interface CopyTarget {
  id: number;
  trader_id?: number;
  proxy_wallet: string;
  display_name: string;
  category: string;
  status: 'active' | 'paused' | 'stopped';
  alpha_score?: number;
  trader_pnl?: number;
  trader_markets?: number;
}

export interface Signal {
  id: number;
  copy_target_id: number;
  trader_id: number;
  proxy_wallet: string;
  condition_id: string;
  side: string;
  outcome: string;
  price: number;
  size: number;
  signal_type: string;
  detected_at: string;
  acted_on: boolean;
  skip_reason?: string;
  target_name?: string;
  event_title?: string;
  category?: string;
}

export const overviewApi = {
  get: () => api.get<OverviewResponse>('/overview'),
};

export const positionsApi = {
  paper: () => api.get<{ open: Position[]; closed: Position[] }>('/positions'),
  live: () => api.get<{ open: Position[]; closed: Position[] }>('/positions/live'),
};

export const tradersApi = {
  list: (params: { category?: string; limit?: number; minMarkets?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.category) qs.set('category', params.category);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.minMarkets) qs.set('min_markets', String(params.minMarkets));
    const suffix = qs.toString() ? `?${qs}` : '';
    return api.get<{ traders: Trader[]; targets: CopyTarget[] }>(`/traders${suffix}`);
  },
};

export const signalsApi = {
  list: (params: { hours?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.hours) qs.set('hours', String(params.hours));
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return api.get<{
      signals: Signal[];
      stats: { total: number; acted: number; skipped: number };
    }>(`/signals${suffix}`);
  },
};

export const backtestsApi = {
  list: () => api.get<{ backtests: Record<string, unknown>[] }>('/backtests'),
};

// ─── Target management ──────────────────────────────────────────────

export interface AddTargetInput {
  wallet: string;
  displayName?: string;
  category: string;
}

export const targetsApi = {
  add: (input: AddTargetInput) =>
    api.post<{ id: number; trader_id: number; status: string }>('/targets', input),
  setStatus: (id: number, status: 'active' | 'paused' | 'stopped') =>
    api.patch<{ id: number; status: string }>(`/targets/${id}`, { status }),
  setCategory: (id: number, category: string) =>
    api.patch<{ id: number; status: string; category: string }>(`/targets/${id}`, { category }),
  remove: (id: number) => api.delete<{ id: number; status: string }>(`/targets/${id}`),
};
