/**
 * Trader quality — decides whether a copy target has earned a bigger bet size.
 *
 * A trader is QUALIFIED when EITHER rule holds, measured over their settled
 * (closed) positions on Polymarket:
 *
 *   ROI rule : ROI >= minRoi  AND  at least minRoiPositions settled positions
 *              AND positive net P/L.      (ROI = net realized P/L / money put in)
 *   WIN rule : at least minWins winning positions  AND  total $ won > total $ lost
 *
 * Data comes from the public Data API  GET /closed-positions  (read-only).
 * The query is sorted by TIMESTAMP, newest first. The API's default sort is by
 * realized P/L, which would hand us only the best trades and inflate every
 * trader — never rely on it.
 *
 * No imports: fetch is injectable so the logic is testable offline.
 */

export interface ClosedPosition {
  avgPrice?: number | string;
  totalBought?: number | string;   // shares bought
  realizedPnl?: number | string;   // $ realized on this position
}

export interface TraderStats {
  positions: number;     // settled positions counted
  wins: number;
  losses: number;
  grossWin: number;      // $ won on winning positions
  grossLoss: number;     // $ lost on losing positions (positive number)
  netPnl: number;
  invested: number;      // Σ avgPrice × totalBought
  roi: number | null;    // netPnl / invested, null when nothing invested
  capped: boolean;       // true when we stopped at the page cap (older history ignored)
  fetchedAt: number;     // ms
}

export interface QualityConfig {
  minRoi: number;            // 0.10 = 10%
  minRoiPositions: number;   // sample-size guard for the ROI rule
  minWins: number;           // winning positions needed for the WIN rule
}

export interface Qualification {
  qualified: boolean;
  reasons: string[];         // human-readable, why it qualified (or why not)
  stats: TraderStats | null; // null = could not be measured
}

export const DEFAULT_QUALITY: QualityConfig = { minRoi: 0.10, minRoiPositions: 30, minWins: 50 };

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

export function computeStats(rows: ClosedPosition[], capped: boolean, now = Date.now()): TraderStats {
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, invested = 0, positions = 0;
  for (const r of rows) {
    const pnl = num(r.realizedPnl);
    const cost = num(r.avgPrice) * num(r.totalBought);
    positions++;
    invested += cost > 0 ? cost : 0;
    if (pnl > 0) { wins++; grossWin += pnl; }
    else if (pnl < 0) { losses++; grossLoss += -pnl; }
  }
  const netPnl = grossWin - grossLoss;
  return {
    positions, wins, losses, grossWin, grossLoss, netPnl, invested,
    roi: invested > 0 ? netPnl / invested : null,
    capped, fetchedAt: now,
  };
}

export function evaluate(stats: TraderStats | null, cfg: QualityConfig = DEFAULT_QUALITY): Qualification {
  if (!stats) return { qualified: false, reasons: ['stats unavailable'], stats: null };
  const reasons: string[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  const roiOk =
    stats.roi !== null && stats.roi >= cfg.minRoi && stats.positions >= cfg.minRoiPositions && stats.netPnl > 0;
  if (roiOk) reasons.push(`ROI ${pct(stats.roi as number)} ≥ ${pct(cfg.minRoi)} over ${stats.positions} settled positions`);

  const winOk = stats.wins >= cfg.minWins && stats.grossWin > stats.grossLoss;
  if (winOk) {
    reasons.push(`${stats.wins} wins ≥ ${cfg.minWins} and won $${stats.grossWin.toFixed(0)} > lost $${stats.grossLoss.toFixed(0)}`);
  }

  if (reasons.length === 0) {
    reasons.push(
      `not qualified: ROI ${stats.roi === null ? 'n/a' : pct(stats.roi)} (${stats.positions} positions), ` +
      `${stats.wins} wins, won $${stats.grossWin.toFixed(0)} vs lost $${stats.grossLoss.toFixed(0)}`,
    );
  }
  return { qualified: roiOk || winOk, reasons, stats };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>;
}>;

const PAGE = 50;

/** Newest-first settled positions. Stops at a short page, or at maxPages (capped = true). */
export async function fetchClosedPositions(
  dataUrl: string,
  wallet: string,
  opts: { fetchImpl?: FetchLike; maxPages?: number } = {},
): Promise<{ rows: ClosedPosition[]; capped: boolean }> {
  const f: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i) as never);
  const maxPages = opts.maxPages ?? 100;
  const rows: ClosedPosition[] = [];
  for (let page = 0; page < maxPages; page++) {
    const url =
      `${dataUrl}/closed-positions?user=${encodeURIComponent(wallet)}` +
      `&limit=${PAGE}&offset=${page * PAGE}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await f(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`closed-positions HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('closed-positions: unexpected payload');
    rows.push(...(body as ClosedPosition[]));
    if (body.length < PAGE) return { rows, capped: false };
  }
  return { rows, capped: true };
}

/**
 * Per-wallet cache. Stats move slowly, so they are refreshed lazily every ttlMs
 * (default 6 h). A failed refresh keeps serving the previous result; with no
 * previous result the trader is simply "not qualified" (base bet size) and the
 * failure is retried after retryMs.
 */
export class TraderQualityCache {
  private readonly entries = new Map<string, { q: Qualification; at: number; ok: boolean }>();
  private readonly inflight = new Map<string, Promise<Qualification>>();

  constructor(private readonly o: {
    dataUrl: string;
    cfg?: QualityConfig;
    ttlMs?: number;
    retryMs?: number;
    fetchImpl?: FetchLike;
    maxPages?: number;
    now?: () => number;
    log?: (m: string) => void;
  }) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  private fresh(e: { at: number; ok: boolean }): boolean {
    const ttl = e.ok ? (this.o.ttlMs ?? 6 * 3600_000) : (this.o.retryMs ?? 5 * 60_000);
    return this.now() - e.at < ttl;
  }

  /** Cached result if present (may be stale); kicks off a background refresh when stale. Never waits. */
  peek(wallet: string): Qualification | null {
    const w = wallet.toLowerCase();
    const e = this.entries.get(w);
    if (!e || !this.fresh(e)) void this.get(w).catch(() => undefined);
    return e?.q ?? null;
  }

  async get(wallet: string): Promise<Qualification> {
    const w = wallet.toLowerCase();
    const cached = this.entries.get(w);
    if (cached && this.fresh(cached)) return cached.q;
    const running = this.inflight.get(w);
    if (running) return running;

    const p = (async (): Promise<Qualification> => {
      try {
        const { rows, capped } = await fetchClosedPositions(this.o.dataUrl, w, {
          fetchImpl: this.o.fetchImpl, maxPages: this.o.maxPages,
        });
        const q = evaluate(computeStats(rows, capped, this.now()), this.o.cfg ?? DEFAULT_QUALITY);
        this.entries.set(w, { q, at: this.now(), ok: true });
        return q;
      } catch (err) {
        (this.o.log ?? console.warn)(`[quality] ${w.slice(0, 10)} stats failed: ${(err as Error).message}`);
        const keep = cached?.q ?? { qualified: false, reasons: ['stats unavailable'], stats: null };
        this.entries.set(w, { q: keep, at: this.now(), ok: false });
        return keep;
      } finally {
        this.inflight.delete(w);
      }
    })();
    this.inflight.set(w, p);
    return p;
  }
}
