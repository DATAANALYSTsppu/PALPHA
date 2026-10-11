'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { MetricCard } from '@/components/ui/metric-card';
import { SectionHeader } from '@/components/ui/section-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatBadge } from '@/components/ui/stat-badge';
import { PlainSummary } from '@/components/ui/plain-summary';
import { BotStatusBanner } from '@/components/ui/bot-status-banner';
import { Bar } from '@/components/ui/bar';
import type { OverviewResponse } from '@/lib/api';
import { AlertCircle } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';

// Settled-performance date filter. Preset windows default to 30d so recent
// results aren't buried under old (losing) campaigns; "Custom" reveals From/To
// date pickers; "All time" restores the full history.
type Range =
  | { kind: 'preset'; days: number | null }
  | { kind: 'custom'; from: string; to: string };

const PRESETS: { label: string; days: number | null }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All time', days: null },
];

export default function OverviewPage() {
  const [range, setRange] = useState<Range>({ kind: 'preset', days: 30 });

  const path =
    range.kind === 'custom'
      ? range.from && range.to
        ? `/overview?from=${range.from}&to=${range.to}`
        : '/overview'
      : range.days
        ? `/overview?days=${range.days}`
        : '/overview';

  const { data, loading, error } = useApi<OverviewResponse>(path);

  const rangeLabel =
    range.kind === 'custom'
      ? range.from && range.to
        ? `${range.from} → ${range.to}`
        : 'pick a date range'
      : range.days
        ? `last ${range.days} days`
        : 'all time';

  const shortLabel = range.kind === 'custom' ? 'custom' : range.days ? `${range.days}d` : 'all';
  const isPresetActive = (d: number | null) => range.kind === 'preset' && range.days === d;

  const inputCls =
    'rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark]';

  const rangePicker = (
    <div className="flex flex-wrap items-center gap-2 self-start">
      <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => setRange({ kind: 'preset', days: p.days })}
            className={cn(
              'whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors',
              isPresetActive(p.days)
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setRange((r) => (r.kind === 'custom' ? r : { kind: 'custom', from: '', to: '' }))}
          className={cn(
            'whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors',
            range.kind === 'custom'
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Custom
        </button>
      </div>
      {range.kind === 'custom' && (
        <div className="inline-flex items-center gap-1.5">
          <input
            type="date"
            aria-label="From date"
            value={range.from}
            max={range.to || undefined}
            onChange={(e) => setRange({ kind: 'custom', from: e.target.value, to: range.to })}
            className={inputCls}
          />
          <span className="text-muted-foreground">→</span>
          <input
            type="date"
            aria-label="To date"
            value={range.to}
            min={range.from || undefined}
            onChange={(e) => setRange({ kind: 'custom', from: range.from, to: e.target.value })}
            className={inputCls}
          />
        </div>
      )}
    </div>
  );

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <SectionHeader title="Overview" subtitle="A snapshot of your copy-trading account" size="lg" />
      {rangePicker}
    </div>
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState icon={AlertCircle} title="Couldn't load overview" description={error} />
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg border border-border bg-muted/30" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState icon={AlertCircle} title="Couldn't load overview" description="No data returned from the API." />
      </div>
    );
  }

  const balance = data.account?.balance ?? 0;
  const realizedPnl = data.account?.realized_pnl ?? 0;
  const closedTotal = data.closed?.total ?? 0;
  const closedWins = data.closed?.wins ?? 0;
  const winRate = closedTotal > 0 ? (closedWins / closedTotal) * 100 : 0;
  // ROI = realized P/L ÷ capital staked on the settled bets in this window.
  const invested = data.closed?.invested ?? 0;
  const roi = invested > 0 ? (realizedPnl / invested) * 100 : 0;

  return (
    <div className="space-y-6">
      {header}

      <BotStatusBanner lastSync={data.lastSync} activeTargets={data.activeTargets ?? 0} />

      <PlainSummary>
        This bot automatically copies the trades of {data.activeTargets ?? 0} chosen
        trader{(data.activeTargets ?? 0) === 1 ? '' : 's'}. Right now you have{' '}
        <strong>{formatCurrency(balance)}</strong> available to trade and{' '}
        <strong>{data.openCount ?? 0}</strong> bet{(data.openCount ?? 0) === 1 ? '' : 's'} still
        open. In the <strong>{rangeLabel}</strong>, of <strong>{closedTotal}</strong> finished
        bet{closedTotal === 1 ? '' : 's'}, <strong>{closedWins}</strong> won ({winRate.toFixed(0)}% win
        rate), for a locked-in result of{' '}
        <strong className={realizedPnl > 0 ? 'text-positive' : realizedPnl < 0 ? 'text-negative' : ''}>
          {formatCurrency(realizedPnl)}
        </strong>.
      </PlainSummary>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <MetricCard label="Balance" value={balance} variant="currency" compact hint="Cash available now" tooltip="On-chain USDC in the trading wallet, synced live. Always current — not affected by the date filter." />
        <MetricCard
          label={`Realized P/L (${shortLabel})`}
          value={realizedPnl}
          variant="currency"
          compact
          trend={realizedPnl > 0 ? 'up' : realizedPnl < 0 ? 'down' : 'neutral'}
          hint={`Profit/loss from bets settled in the ${rangeLabel}`}
          tooltip="Sum of profit/loss across positions settled in the selected date range."
        />
        <MetricCard
          label={`ROI (${shortLabel})`}
          value={roi}
          variant="percent"
          trend={roi > 0 ? 'up' : roi < 0 ? 'down' : 'neutral'}
          hint={`Return on the ${formatCurrency(invested, true)} staked`}
          tooltip="Realized P/L ÷ total amount staked on positions settled in the selected date range."
        />
        <MetricCard label="Open Positions" value={data.openCount ?? 0} variant="number" hint="Bets still waiting to finish" tooltip="Positions the bot holds that haven't resolved yet. Always current." />
        <MetricCard label="Active Targets" value={data.activeTargets ?? 0} variant="number" hint="Traders we're copying" tooltip="Traders set to 'active' — their trades get copied live." />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-6">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium text-muted-foreground">Closed Trades</p>
            <p className="text-xs text-muted-foreground">{rangeLabel}</p>
          </div>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {closedTotal}
          </p>
          <div className="mt-2 flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              <span className="font-medium text-positive">{closedWins}</span> won ·{' '}
              <span className="font-medium text-negative">{closedTotal - closedWins}</span> lost
            </span>
            <span className="text-muted-foreground">{winRate.toFixed(0)}% win rate</span>
          </div>
          {closedTotal > 0 && (
            <Bar value={winRate} color={winRate >= 50 ? 'bg-positive' : 'bg-negative'} className="mt-2" />
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface p-6">
          <p className="text-sm font-medium text-muted-foreground">Scored Traders</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {data.scoredTraders?.toLocaleString() ?? 0}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.activeTargets ?? 0} actively copied
          </p>
        </div>
      </div>

      {data.categories?.length > 0 && (
        <div className="rounded-lg border border-border bg-surface p-6">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Markets by Category</h3>
          <div className="flex flex-wrap gap-2">
            {data.categories.map((c) => (
              <StatBadge key={c.category} label={`${c.category} · ${c.cnt.toLocaleString()}`} variant="info" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
