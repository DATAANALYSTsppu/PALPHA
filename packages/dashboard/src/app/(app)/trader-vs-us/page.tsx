'use client';

import { useState, useEffect } from 'react';
import { useApi } from '@/lib/useApi';
import { friendlySkipReason, skipReasonDetail } from '@/components/ui/stat-badge';
import { SectionHeader } from '@/components/ui/section-header';
import { MetricCard } from '@/components/ui/metric-card';
import { EmptyState } from '@/components/ui/empty-state';
import { PlainSummary } from '@/components/ui/plain-summary';
import { AlertCircle, Download, GitCompare } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';

type Range =
  | { kind: 'preset'; days: number | null }
  | { kind: 'custom'; from: string; to: string };

const PRESETS: { label: string; days: number | null }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All time', days: null },
];

interface CompareRow {
  detected_at: string;
  outcome: string;
  condition_id: string;
  market: string;
  target_price: number | null;
  target_size: number | null;
  acted_on: boolean;
  skip_reason: string | null;
  our_price: number | null;
  our_size: number | null;
  our_position_id: number | null;
  our_status: string | null;
  our_exit: number | null;
  our_pnl: number | null;
  /** True when this row is shown against the position it scaled INTO, rather
   *  than a position of its own — its P/L belongs to the first buy. */
  our_scale_in?: boolean;
}
interface CompareResponse {
  wallet: string;
  rows: CompareRow[];
  summary: {
    total: number; copied: number; filled: number; avgSlippage: number;
    settled: number; wins: number; winRate: number;
    realizedPnl: number; invested: number; roi: number;
  };
}
interface Target { proxy_wallet: string; display_name: string | null; status: string }

// A position that was sold before resolution, or settled from a voided market
// at 0.5, never had an exit price of 1 or 0 — scoring on exit_price left most
// closed trades blank. The P/L is what actually decides it.
const rowResult = (r: CompareRow) => {
  if (r.our_status !== 'closed') return '';
  const pnl = r.our_pnl ?? 0;
  return pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'EVEN';
};
// A top-up has no fill price of its own — the joined position carries the
// running AVERAGE entry across every buy. Differencing that against this
// trade's price invents a slippage number that was never paid.
const rowSlip = (r: CompareRow) =>
  r.target_price != null && r.our_price != null && !r.our_scale_in
    ? +(r.our_price - r.target_price).toFixed(3)
    : null;

export default function TraderVsUsPage() {
  const { data: tradersData } = useApi<{ targets: Target[] }>('/traders');
  // De-dupe targets by wallet (a wallet can have multiple copy_target rows).
  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const t of tradersData?.targets ?? []) {
    const w = (t.proxy_wallet || '').toLowerCase();
    if (w && !seen.has(w)) { seen.add(w); targets.push(t); }
  }

  const [wallet, setWallet] = useState('');
  const [range, setRange] = useState<Range>({ kind: 'preset', days: 7 });

  useEffect(() => {
    if (!wallet && targets.length) setWallet(targets[0].proxy_wallet);
  }, [targets, wallet]);

  const dateParam =
    range.kind === 'custom'
      ? range.from && range.to ? `from=${range.from}&to=${range.to}` : ''
      : range.days ? `days=${range.days}` : '';
  const path = wallet
    ? `/trader-compare?wallet=${wallet}${dateParam ? `&${dateParam}` : ''}`
    : '/trader-compare?wallet=none';
  const { data, loading, error } = useApi<CompareResponse>(path);

  const rangeLabel =
    range.kind === 'custom'
      ? range.from && range.to ? `${range.from} → ${range.to}` : 'pick dates'
      : range.days ? `last ${range.days} days` : 'all time';
  const traderName =
    targets.find((t) => t.proxy_wallet === wallet)?.display_name || wallet.slice(0, 10);

  const rows = data?.rows ?? [];
  const s = data?.summary;

  // How many buys went into each position, so a top-up can say what it is part
  // of ("total for 5 buys") instead of leaving the reader to hunt for the row
  // that carries the money.
  const buysPerPosition = new Map<number, number>();
  for (const r of rows) {
    if (r.acted_on && r.our_position_id != null) {
      buysPerPosition.set(r.our_position_id, (buysPerPosition.get(r.our_position_id) ?? 0) + 1);
    }
  }

  const downloadCsv = () => {
    const cols = ['time_ist', 'market', 'outcome', 'target_price', 'target_size', 'our_action', 'our_price', 'our_size', 'slippage', 'result', 'our_pnl', 'position_id', 'position_pnl'];
    const esc = (v: unknown) => {
      const x = v == null ? '' : String(v);
      return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
    };
    const lines = [cols.join(',')];
    for (const r of rows) {
      const action = r.acted_on
        ? (r.our_scale_in ? 'COPIED (top-up)' : 'COPIED')
        : (r.skip_reason ? friendlySkipReason(r.skip_reason) : '');
      lines.push([r.detected_at, r.market || '', r.outcome, r.target_price, r.target_size, action,
        r.our_price, r.our_size, rowSlip(r), rowResult(r),
        // Money once per position, never once per row, so a column sum is right.
        r.our_scale_in ? '' : r.our_pnl,
        r.our_position_id ?? '', r.our_pnl].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${traderName}-vs-us.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const inputCls = 'rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark]';

  const rangePicker = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => setRange({ kind: 'preset', days: p.days })}
            className={cn('whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors',
              range.kind === 'preset' && range.days === p.days ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setRange((r) => (r.kind === 'custom' ? r : { kind: 'custom', from: '', to: '' }))}
          className={cn('whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors',
            range.kind === 'custom' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          Custom
        </button>
      </div>
      {range.kind === 'custom' && (
        <div className="inline-flex items-center gap-1.5">
          <input type="date" aria-label="From" value={range.from} max={range.to || undefined}
            onChange={(e) => setRange({ kind: 'custom', from: e.target.value, to: range.to })} className={inputCls} />
          <span className="text-muted-foreground">→</span>
          <input type="date" aria-label="To" value={range.to} min={range.from || undefined}
            onChange={(e) => setRange({ kind: 'custom', from: range.from, to: e.target.value })} className={inputCls} />
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <SectionHeader title="Trader vs Us" subtitle="Every real trade a target made, next to how our copy actually did" size="lg" />

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <select value={wallet} onChange={(e) => setWallet(e.target.value)} className={cn(inputCls, 'min-w-52')}>
            {targets.length === 0 && <option value="">(no copy targets)</option>}
            {targets.map((t) => (
              <option key={t.proxy_wallet} value={t.proxy_wallet}>
                {(t.display_name || t.proxy_wallet.slice(0, 10))} · {t.status}
              </option>
            ))}
          </select>
          {rangePicker}
        </div>
        <button
          onClick={downloadCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40"
        >
          <Download className="h-4 w-4" /> CSV
        </button>
      </div>

      <PlainSummary>
        <strong>{traderName}</strong> made <strong>{s?.total ?? 0}</strong> trades in the{' '}
        <strong>{rangeLabel}</strong>. We copied <strong>{s?.copied ?? 0}</strong> of them
        {s && s.total > 0 ? ` (${((s.copied / s.total) * 100).toFixed(0)}%)` : ''}; the rest were
        skipped or couldn&apos;t fill. Where we filled, we paid on average{' '}
        <strong>{s ? (s.avgSlippage >= 0 ? '+' : '') + (s.avgSlippage * 100).toFixed(1) + '¢' : '—'}</strong>{' '}
        vs the trader&apos;s price, for a realized result of{' '}
        <strong className={(s?.realizedPnl ?? 0) > 0 ? 'text-positive' : (s?.realizedPnl ?? 0) < 0 ? 'text-negative' : ''}>
          {formatCurrency(s?.realizedPnl ?? 0)}
        </strong>{' '}({s ? s.roi.toFixed(1) : '0'}% ROI).
      </PlainSummary>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Their trades" value={s?.total ?? 0} variant="number" hint="Real trades detected" />
        <MetricCard label="We copied" value={s?.copied ?? 0} variant="number" hint={s && s.total ? `${((s.copied / s.total) * 100).toFixed(0)}% copy rate` : ''} />
        <MetricCard label="Avg slippage" value={s ? `${s.avgSlippage >= 0 ? '+' : ''}${(s.avgSlippage * 100).toFixed(1)}¢` : '—'} trend={(s?.avgSlippage ?? 0) > 0 ? 'down' : 'up'} hint="Our fill vs their price" tooltip="Average (our fill price − trader price) on trades we filled. Positive = we paid more." />
        <MetricCard label="Win rate" value={s ? `${s.winRate.toFixed(0)}%` : '—'} hint={s ? `${s.wins}/${s.settled} settled` : ''} />
        <MetricCard label="Realized P/L" value={s?.realizedPnl ?? 0} variant="currency" compact trend={(s?.realizedPnl ?? 0) > 0 ? 'up' : (s?.realizedPnl ?? 0) < 0 ? 'down' : 'neutral'} hint="Our settled result" />
        <MetricCard label="ROI" value={s ? s.roi : 0} variant="percent" trend={(s?.roi ?? 0) > 0 ? 'up' : (s?.roi ?? 0) < 0 ? 'down' : 'neutral'} hint="On capital staked" />
      </div>

      {/* Table */}
      {error && !wallet ? null : error ? (
        <EmptyState icon={AlertCircle} title="Couldn't load comparison" description={error} />
      ) : rows.length === 0 && !loading ? (
        <EmptyState icon={GitCompare} title="No trades in this window" description="Pick a different trader or widen the date range." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-surface text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Time (IST)</th>
                <th className="px-3 py-2 text-left font-medium">Market / Outcome</th>
                <th className="px-3 py-2 text-right font-medium">Their px</th>
                <th className="px-3 py-2 text-right font-medium">Their size</th>
                <th className="px-3 py-2 text-left font-medium">Our action</th>
                <th className="px-3 py-2 text-right font-medium">Our fill</th>
                <th className="px-3 py-2 text-right font-medium">Slippage</th>
                <th className="px-3 py-2 text-center font-medium">Result</th>
                <th className="px-3 py-2 text-right font-medium">Our P/L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => {
                const slip = rowSlip(r);
                const result = rowResult(r);
                return (
                  <tr key={i} className="hover:bg-accent/40">
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground tabular-nums">
                      {new Date(r.detected_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-foreground">{r.outcome}</span>
                      {r.market && <span className="ml-1 text-xs text-muted-foreground line-clamp-1">{r.market}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">{r.target_price?.toFixed(3) ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.target_size?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn('text-xs', r.acted_on ? 'text-positive font-medium' : 'text-muted-foreground')}
                        title={r.acted_on
                          ? (r.our_scale_in ? 'We already held this — this buy topped up that position' : undefined)
                          : skipReasonDetail(r.skip_reason ?? undefined)}
                      >
                        {r.acted_on
                          ? (r.our_scale_in ? 'COPIED · top-up' : 'COPIED')
                          : (r.skip_reason ? friendlySkipReason(r.skip_reason) : '—')}
                      </span>
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', r.our_scale_in ? 'text-muted-foreground' : 'text-foreground')}>
                      {r.our_price == null ? '—'
                        : r.our_scale_in
                          ? <span title="Average price across every buy in this position — this top-up has no separate fill price recorded">avg {r.our_price.toFixed(3)}</span>
                          : r.our_price.toFixed(3)}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', slip == null ? 'text-muted-foreground' : slip > 0 ? 'text-negative' : slip < 0 ? 'text-positive' : 'text-muted-foreground')}>
                      {slip == null ? '—' : `${slip > 0 ? '+' : ''}${(slip * 100).toFixed(1)}¢`}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {result === 'WIN' ? <span className="text-positive font-medium">WIN</span>
                        : result === 'LOSS' ? <span className="text-negative font-medium">LOSS</span>
                        : result === 'EVEN' ? <span className="text-muted-foreground font-medium">EVEN</span>
                        : <span className="text-muted-foreground" title={r.our_status === 'open' ? 'Still open — settles when the market resolves' : undefined}>—</span>}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', (r.our_pnl ?? 0) > 0 ? 'text-positive' : (r.our_pnl ?? 0) < 0 ? 'text-negative' : 'text-muted-foreground')}>
                      {r.our_pnl == null ? '—'
                        : r.our_scale_in
                          ? <span
                              className="text-xs text-muted-foreground"
                              title={`Part of one position built from ${buysPerPosition.get(r.our_position_id ?? -1) ?? 'several'} buys in this market. ${formatCurrency(r.our_pnl)} is that whole position's result — counted once, on the first buy, not once per row.`}
                            >↳ {formatCurrency(r.our_pnl)} total</span>
                          : formatCurrency(r.our_pnl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
