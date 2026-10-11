'use client';

import { useApi } from '@/lib/useApi';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SectionHeader } from '@/components/ui/section-header';
import { MetricCard } from '@/components/ui/metric-card';
import { StatBadge, signalStatusBadge } from '@/components/ui/stat-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PlainSummary } from '@/components/ui/plain-summary';
import { CopyAddress } from '@/components/ui/copy-address';
import { Activity, AlertCircle } from 'lucide-react';
import { cn, formatCurrency, timeAgo } from '@/lib/utils';
import type { Signal } from '@/lib/api';

interface SignalsResponse {
  signals: Signal[];
  stats: { total: number; acted: number; skipped: number };
}

export default function SignalsPage() {
  // Auto-refresh every 10s — near-realtime feed of newly-detected signals
  const { data, loading, error } = useApi<SignalsResponse>('/signals?hours=24&limit=100', 10000);

  const sideBadge = (outcome: string) => {
    if (outcome === 'Yes') return <StatBadge label="YES" variant="positive" />;
    if (outcome === 'No') return <StatBadge label="NO" variant="negative" />;
    return <StatBadge label={outcome ?? '—'} variant="neutral" />;
  };

  const columns: Column<Signal>[] = [
    {
      key: 'time',
      header: 'Time',
      cell: (s) => (
        <span className="text-muted-foreground text-xs tabular-nums whitespace-nowrap">
          {timeAgo(s.detected_at)}
        </span>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      cell: (s) => (
        <div>
          <p className="font-medium text-foreground">{s.target_name || 'unknown'}</p>
          <CopyAddress address={s.proxy_wallet} />
        </div>
      ),
    },
    {
      key: 'market',
      header: 'Market',
      cell: (s) => (
        <div>
          <p className="font-medium text-foreground line-clamp-1 max-w-md">
            {s.event_title || '—'}
          </p>
          <p className="text-xs text-muted-foreground">{s.category}</p>
        </div>
      ),
    },
    {
      key: 'side',
      header: 'Side',
      cell: (s) => sideBadge(s.outcome),
    },
    {
      key: 'price',
      header: 'Price',
      cell: (s) => (
        <span className="tabular-nums text-foreground">
          ${s.price?.toFixed(4) ?? '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'size',
      header: 'Size',
      cell: (s) => (
        <span className="tabular-nums text-foreground">{formatCurrency(s.size, true)}</span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'type',
      header: 'Type',
      cell: (s) => (
        <StatBadge
          label={s.signal_type === 'new_position' ? 'Entry' : s.signal_type}
          variant={s.signal_type === 'new_position' ? 'info' : 'warning'}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) =>
        signalStatusBadge(s.acted_on ? 'acted_on' : s.skip_reason ? 'skipped' : 'pending', s.skip_reason),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <SectionHeader title="Signals" size="lg" />
        <EmptyState icon={AlertCircle} title="Couldn't load signals" description={error} />
      </div>
    );
  }

  const stats = data?.stats ?? { total: 0, acted: 0, skipped: 0 };
  const signals = data?.signals ?? [];
  const actionRate = stats.total > 0 ? (stats.acted / stats.total) * 100 : 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Signals"
        subtitle="Every trade your traders made, and whether the bot copied it"
        size="lg"
      />

      <PlainSummary>
        Whenever a trader you follow places a trade, it appears here. In the last 24 hours the bot
        saw <strong>{stats.total}</strong> trade{stats.total === 1 ? '' : 's'} and{' '}
        <strong>copied {stats.acted}</strong> of them ({actionRate.toFixed(0)}%). The rest were
        skipped — the “Status” column says why (e.g. price too high, wrong market, or already held).
      </PlainSummary>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Signals (24h)" value={stats.total} variant="number" hint="Trades your traders made" tooltip="Every trade by your active targets in the last 24h that the bot detected." />
        <MetricCard label="Copied" value={stats.acted} variant="number" trend="up" hint="Trades the bot mirrored" tooltip="Detected trades that passed all filters and were actually placed." />
        <MetricCard label="Skipped" value={stats.skipped} variant="number" trend="neutral" hint="Trades the bot passed on" tooltip="Trades filtered out (price, category, already held, etc.) — see Status column." />
        <MetricCard label="Copy rate" value={`${actionRate.toFixed(1)}%`} hint="Share of trades we copied" tooltip="Copied ÷ total detected trades." />
      </div>

      <section className="space-y-3">
        <SectionHeader title="Recent signals" />
        {signals.length === 0 && !loading ? (
          <EmptyState
            icon={Activity}
            title="No signals yet"
            description="Signals appear here when your copy targets place new trades."
          />
        ) : (
          <DataTable
            columns={columns}
            data={signals}
            keyExtractor={(s) => String(s.id)}
            isLoading={loading}
            pageSize={25}
          />
        )}
      </section>
    </div>
  );
}
