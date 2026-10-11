'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { api } from '@/lib/api';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SectionHeader } from '@/components/ui/section-header';
import { MetricCard } from '@/components/ui/metric-card';
import { StatBadge } from '@/components/ui/stat-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PlainSummary } from '@/components/ui/plain-summary';
import { Bar } from '@/components/ui/bar';
import { Briefcase, AlertCircle, Download, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn, formatCurrency, timeAgo } from '@/lib/utils';
import type { Position } from '@/lib/api';

type Mode = 'paper' | 'live';
type ResultFilter = 'all' | 'won' | 'lost' | 'sold';
type Range = { kind: 'preset'; days: number | null } | { kind: 'custom'; from: string; to: string };

const RESULTS: { value: ResultFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'sold', label: 'Sold early' },
];
const PRESETS: { label: string; days: number | null }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All time', days: null },
];
const PAGE_SIZE = 50;

interface PositionsResponse {
  open: Position[];
  closed: Position[];
  closedTotal: number;
  closedPnl: number;
  closedWins: number;
  facets: { targets: string[]; categories: string[] };
}

export default function PositionsPage() {
  // Default to 'live' — that's the active trader people care about. Paper
  // stays available as a togglable view (manual / synthetic experiments).
  const [mode, setMode] = useState<Mode>('live');

  // ── Filters (applied in SQL, so they run over the whole history rather than
  //    a page that was already truncated) ──
  const [result, setResult] = useState<ResultFilter>('all');
  const [target, setTarget] = useState('all');
  const [category, setCategory] = useState('all');
  const [range, setRange] = useState<Range>({ kind: 'preset', days: null });
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(0);

  // Don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any filter change invalidates the page we're on.
  useEffect(() => { setPage(0); }, [result, target, category, range, search, mode]);

  const filterQs = useMemo(() => {
    const qs = new URLSearchParams();
    if (result !== 'all') qs.set('result', result);
    if (target !== 'all') qs.set('target', target);
    if (category !== 'all') qs.set('category', category);
    if (search) qs.set('q', search);
    if (range.kind === 'custom') {
      if (range.from && range.to) { qs.set('from', range.from); qs.set('to', range.to); }
    } else if (range.days) {
      qs.set('days', String(range.days));
    }
    return qs.toString();
  }, [result, target, category, search, range]);

  const base = mode === 'paper' ? '/positions' : '/positions/live';
  const endpoint = `${base}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}${filterQs ? `&${filterQs}` : ''}`;
  // Refresh every 15s so unrealized P/L stays fresh
  const { data, loading, error } = useApi<PositionsResponse>(endpoint, 15000);

  const activeFilters =
    (result !== 'all' ? 1 : 0) + (target !== 'all' ? 1 : 0) + (category !== 'all' ? 1 : 0) +
    (search ? 1 : 0) + (range.kind === 'custom' || range.days ? 1 : 0);
  const clearFilters = () => {
    setResult('all'); setTarget('all'); setCategory('all');
    setRange({ kind: 'preset', days: null }); setSearchInput(''); setSearch('');
  };

  const [exporting, setExporting] = useState(false);
  const downloadCsv = async () => {
    setExporting(true);
    try {
      // Export everything the filters match, not just the page on screen.
      const all = await api.get<PositionsResponse>(
        `${base}?limit=5000&offset=0${filterQs ? `&${filterQs}` : ''}`,
      );
      const cols = ['result', 'market', 'outcome', 'side', 'category', 'target',
        'money_in', 'money_back', 'profit_loss', 'roi_pct', 'opened_at', 'closed_at', 'condition_id'];
      const esc = (v: unknown) => {
        const x = v == null ? '' : String(v);
        return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
      };
      const lines = [cols.join(',')];
      for (const p of all.closed) {
        const back = p.proceeds_usd ?? ((p.size_usd ?? 0) + (p.pnl ?? 0));
        const roi = p.size_usd ? ((p.pnl ?? 0) / p.size_usd) * 100 : null;
        lines.push([
          statusForRow(p), p.title ?? '', p.outcome ?? '', p.side ?? '', p.category ?? '',
          p.target_name ?? '', p.size_usd?.toFixed(2), back.toFixed(2), (p.pnl ?? 0).toFixed(2),
          roi == null ? '' : roi.toFixed(1), p.opened_at, p.closed_at ?? '', p.condition_id ?? '',
        ].map(esc).join(','));
      }
      const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `palpha-positions-${mode}-${result}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`CSV export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const sideBadge = (side: string) => {
    const v = side?.toUpperCase();
    if (v === 'YES') return <StatBadge label="YES" variant="positive" />;
    if (v === 'NO') return <StatBadge label="NO" variant="negative" />;
    if (v === 'BUY') return <StatBadge label="BUY" variant="info" />;
    if (v === 'SELL') return <StatBadge label="SELL" variant="warning" />;
    return <StatBadge label={side ?? '—'} variant="neutral" />;
  };

  // ───────────────────────────────────────────────────────────────────
  // Display helpers
  // ───────────────────────────────────────────────────────────────────

  // Status label derived from row state. Closed rows can be: target_sold
  // ("Sold" — we exited because the target sold), redeemed_win ("Won" —
  // resolution paid out), redeemed_loss ("Lost" — resolution paid nothing).
  // Anything still open is "Open".
  const statusForRow = (p: Position): 'Open' | 'Sold' | 'Won' | 'Lost' => {
    if (p.status === 'open') return 'Open';
    const reason = p.metadata?.close_reason ?? '';
    if (reason.includes('target_sold')) return 'Sold';
    if ((p.pnl ?? 0) > 0) return 'Won';
    return 'Lost';
  };

  // A row we can't vouch for still shows, but it is out of every total — say so
  // rather than let the reader add it up themselves.
  const unverified = (p: Position) => Boolean(p.metadata?.data_issue);

  const statusBadge = (p: Position) => {
    const s = statusForRow(p);
    if (s === 'Open') return <StatBadge label="OPEN"  variant="info" />;
    if (s === 'Sold') return <StatBadge label="SOLD"  variant="neutral" />;
    if (s === 'Won')  return <StatBadge label="WON"   variant="positive" />;
    return                    <StatBadge label="LOST"  variant="negative" />;
  };

  const marketCell = (p: Position) => (
    <div>
      <p className="font-medium text-foreground line-clamp-1 max-w-md">
        {p.title ?? (
          <span className="text-muted-foreground italic">
            {p.outcome ?? 'Unknown'} · {p.condition_id ? `${p.condition_id.slice(0, 10)}…` : ''}
          </span>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {unverified(p) && (
          <span
            className="mr-1.5 rounded bg-warning-muted px-1 py-0.5 text-[10px] text-warning"
            title="The recorded fill for this position could not be verified against Polymarket or the chain, so it is left out of every total on this page."
          >unverified</span>
        )}
        {p.outcome ? `${p.outcome}` : ''}{p.category ? ` · ${p.category}` : ''}
        {(p.size_usd ?? 0) < 0.5 && (
          <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground/70">tiny leftover</span>
        )}
      </p>
    </div>
  );

  // Realized proceeds for a closed position, mark-to-market for an open one.
  // Settling zeroes `shares`, so exit_price * shares reads $0 on every closed
  // position — proceeds_usd is what the settlement actually banked.
  const soldAmount = (p: Position): number | null => {
    if (p.status === 'open') {
      if (p.current_price != null && p.shares != null) return p.current_price * p.shares;
      return null;
    }
    if (p.proceeds_usd != null) return p.proceeds_usd;
    if (p.exit_price != null && p.shares != null) return p.exit_price * p.shares;
    return null;
  };

  const profitPctCell = (p: Position) => {
    const pnl = p.status === 'open' ? p.unrealized_pnl ?? null : p.pnl ?? null;
    if (pnl == null || !p.size_usd) return <span className="text-muted-foreground">—</span>;
    const pct = (pnl / p.size_usd) * 100;
    const cls = pnl > 0 ? 'text-positive' : pnl < 0 ? 'text-negative' : 'text-muted-foreground';
    return (
      <div className="flex flex-col items-end leading-tight">
        <span className={cn('tabular-nums font-medium', cls)}>{formatCurrency(pnl)}</span>
        <span className={cn('text-xs tabular-nums', cls.replace('text-', 'text-').concat('/70'))}>
          {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
        </span>
      </div>
    );
  };

  // ───────────────────────────────────────────────────────────────────
  // Column sets — open and closed share most columns; only "Sold" vs
  // "Closed" date/value column differs in semantics.
  // ───────────────────────────────────────────────────────────────────

  const openColumns: Column<Position>[] = [
    { key: 'side',   header: 'Side',   cell: (p) => sideBadge(p.side) },
    { key: 'market', header: 'Market', cell: marketCell },
    {
      key: 'bought',
      header: 'We paid',
      cell: (p) => <span className="tabular-nums text-foreground">{formatCurrency(p.size_usd, true)}</span>,
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'current_value',
      header: 'Worth now',
      cell: (p) => {
        const v = soldAmount(p);
        return <span className="tabular-nums text-foreground">{v == null ? '—' : formatCurrency(v, true)}</span>;
      },
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'profit_pct',
      header: 'Profit / Loss',
      cell: profitPctCell,
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'opened',
      header: 'Opened',
      cell: (p) => <span className="text-muted-foreground text-xs">{timeAgo(p.opened_at)}</span>,
    },
    { key: 'status', header: 'Status', cell: statusBadge },
    {
      key: 'target',
      header: 'Target',
      cell: (p) => <span className="text-foreground">{p.target_name || '—'}</span>,
    },
  ];

  const closedColumns: Column<Position>[] = [
    { key: 'side',   header: 'Side',   cell: (p) => sideBadge(p.side) },
    { key: 'market', header: 'Market', cell: marketCell },
    {
      key: 'bought',
      header: 'We paid',
      cell: (p) => <span className="tabular-nums text-foreground">{formatCurrency(p.size_usd, true)}</span>,
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'sold',
      header: 'We got back',
      cell: (p) => {
        const v = soldAmount(p);
        return <span className="tabular-nums text-foreground">{v == null ? '—' : formatCurrency(v, true)}</span>;
      },
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'profit_pct',
      header: 'Profit / Loss',
      cell: profitPctCell,
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'opened',
      header: 'Opened',
      cell: (p) => <span className="text-muted-foreground text-xs">{timeAgo(p.opened_at)}</span>,
    },
    {
      key: 'closed',
      header: 'Closed',
      cell: (p) => <span className="text-muted-foreground text-xs">{p.closed_at ? timeAgo(p.closed_at) : '—'}</span>,
    },
    { key: 'status', header: 'Status', cell: statusBadge },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <SectionHeader title="Positions" size="lg" />
        <EmptyState icon={AlertCircle} title="Couldn't load positions" description={error} />
      </div>
    );
  }

  const open = data?.open ?? [];
  const closed = data?.closed ?? [];
  const facets = data?.facets ?? { targets: [], categories: [] };

  // Closed totals come from the SERVER over every matching row — summing the
  // 50 on screen would describe the page, not the filter.
  const closedTotal = data?.closedTotal ?? 0;
  const closedPnl = data?.closedPnl ?? 0;
  const closedWins = data?.closedWins ?? 0;
  const winRate = closedTotal > 0 ? (closedWins / closedTotal) * 100 : 0;
  const totalOpenSize = open.reduce((sum, p) => sum + (p.size_usd || 0), 0);
  const totalUnrealized = open.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0);

  const pageCount = Math.max(1, Math.ceil(closedTotal / PAGE_SIZE));
  const firstRow = closedTotal === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastRow = Math.min(closedTotal, (page + 1) * PAGE_SIZE);

  const selectCls = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground';
  const filterBar = (
    <div className="rounded-lg border border-border bg-surface p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {RESULTS.map((r) => (
            <button
              key={r.value}
              onClick={() => setResult(r.value)}
              className={cn('whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors',
                result === r.value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {r.label}
            </button>
          ))}
        </div>

        <select value={target} onChange={(e) => setTarget(e.target.value)} className={selectCls} aria-label="Trader">
          <option value="all">All traders</option>
          {facets.targets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <select value={category} onChange={(e) => setCategory(e.target.value)} className={selectCls} aria-label="Category">
          <option value="all">All categories</option>
          {facets.categories.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
        </select>

        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search market or outcome…"
          className={cn(selectCls, 'min-w-56 flex-1')}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-border p-0.5">
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
                onChange={(e) => setRange({ kind: 'custom', from: e.target.value, to: range.to })} className={selectCls} />
              <span className="text-muted-foreground">→</span>
              <input type="date" aria-label="To" value={range.to} min={range.from || undefined}
                onChange={(e) => setRange({ kind: 'custom', from: range.from, to: e.target.value })} className={selectCls} />
            </div>
          )}
          {activeFilters > 0 && (
            <button onClick={clearFilters} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" /> Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
            </button>
          )}
        </div>

        <button
          onClick={downloadCsv}
          disabled={exporting || closedTotal === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40"
          title="Downloads every finished position matching these filters, with win/loss and P/L"
        >
          <Download className="h-3.5 w-3.5" />
          {exporting ? 'Preparing…' : `CSV (${closedTotal.toLocaleString()})`}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Positions"
        subtitle={`${mode === 'paper' ? 'Paper trading' : 'Live trading'} positions`}
        size="lg"
        actions={
          <div className="flex items-center gap-1 bg-muted rounded-md p-1">
            {(['paper', 'live'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded transition-colors capitalize',
                  mode === m
                    ? 'bg-surface text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {m}
              </button>
            ))}
          </div>
        }
      />

      <PlainSummary>
        These are the bets the bot placed by copying your traders. You have{' '}
        <strong>{open.length}</strong> still open (worth <strong>{formatCurrency(totalOpenSize)}</strong>),
        waiting for those games/events to finish. So far <strong>{closedTotal.toLocaleString()}</strong> have
        finished{activeFilters > 0 ? ' (matching these filters)' : ''} —{' '}
        <strong>{closedWins}</strong> won ({winRate.toFixed(0)}% win rate), for a
        locked-in result of{' '}
        <strong className={closedPnl > 0 ? 'text-positive' : closedPnl < 0 ? 'text-negative' : ''}>
          {formatCurrency(closedPnl)}
        </strong>.
      </PlainSummary>

      {filterBar}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <MetricCard label="Open" value={open.length} variant="number" hint="Bets not finished yet" tooltip="Positions still waiting for their event to resolve." />
        <MetricCard label="Money in play" value={totalOpenSize} variant="currency" compact hint="Total $ in open bets" tooltip="Sum of what we paid for all currently-open positions." />
        <MetricCard
          label="Paper P/L"
          value={totalUnrealized}
          variant="currency"
          compact
          trend={totalUnrealized > 0 ? 'up' : totalUnrealized < 0 ? 'down' : 'neutral'}
          hint="Profit on open bets — still changing"
          tooltip="Mark-to-market profit on open positions; not locked in until they settle."
        />
        <MetricCard
          label="Locked-in P/L"
          value={closedPnl}
          variant="currency"
          compact
          trend={closedPnl > 0 ? 'up' : closedPnl < 0 ? 'down' : 'neutral'}
          hint="Final profit/loss from finished bets"
          tooltip="Realized profit/loss from positions that have closed/resolved."
        />
        <MetricCard label="Win Rate" value={`${winRate.toFixed(1)}%`} hint="Finished bets that won" tooltip="Closed positions with a profit, as a share of all closed positions.">
          {closedTotal > 0 && (
            <Bar value={winRate} color={winRate >= 50 ? 'bg-positive' : 'bg-negative'} className="mt-2" />
          )}
        </MetricCard>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-positive" /> Won / profit</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-negative" /> Lost / loss</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" /> Still in play</span>
      </div>

      <section className="space-y-3">
        <SectionHeader title="Open positions" subtitle={`${open.length} active`} />
        {open.length === 0 && !loading ? (
          <EmptyState
            icon={Briefcase}
            title="No open positions"
            description="Positions will appear here once your copy targets place trades."
          />
        ) : (
          <DataTable
            columns={openColumns}
            data={open}
            keyExtractor={(p) => String(p.id)}
            isLoading={loading}
          />
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Finished positions"
          subtitle={closedTotal === 0 ? 'Nothing matches these filters' : `Showing ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${closedTotal.toLocaleString()}`}
        />
        <DataTable
          columns={closedColumns}
          data={closed}
          keyExtractor={(p) => String(p.id)}
          isLoading={loading}
        />
        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Page {page + 1} of {pageCount.toLocaleString()}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1 || loading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-40"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
