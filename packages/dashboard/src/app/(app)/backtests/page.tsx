'use client';

import { useApi } from '@/lib/useApi';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SectionHeader } from '@/components/ui/section-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatBadge } from '@/components/ui/stat-badge';
import { PlainSummary } from '@/components/ui/plain-summary';
import { ResponsiveContainer, LineChart, Line, YAxis, Tooltip as RTooltip } from 'recharts';
import { BarChart3, AlertCircle } from 'lucide-react';
import { cn, formatCurrency, formatDate, formatPercent } from '@/lib/utils';

interface Backtest {
  id: number;
  category: string;
  strategy: string;
  start_date: string;
  end_date: string;
  created_at: string;
  total_return?: number;
  sharpe_ratio?: number;
  max_drawdown?: number;
  win_rate?: number;
  total_trades?: number;
  total_pnl?: number;
  config?: { initialBalance?: number; traderIds?: number[] } | null;
  per_trader?: { name?: string; wallet?: string; traderId?: number }[] | null;
  equity_curve?: { date: string; equity: number }[] | null;
}

/** % return = dollar return / starting balance. The engine stores total_return
 *  as DOLLARS (identical to total_pnl), so derive the percentage from the
 *  initialBalance saved in the config JSONB. */
function returnPct(bt: Backtest): number | null {
  const initial = bt.config?.initialBalance;
  if (bt.total_return == null || !initial) return null;
  return (bt.total_return / initial) * 100;
}

/** Short label for one trader: name if set, else a truncated wallet, else id. */
function traderLabel(t: { name?: string; wallet?: string; traderId?: number }): string {
  if (t.name && t.name.trim()) return t.name.trim();
  if (t.wallet) return `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`;
  return t.traderId != null ? `#${t.traderId}` : '?';
}

/** Which trader(s) a run covers, derived from per_trader (falls back to config.traderIds). */
function tradersSummary(bt: Backtest): { primary: string; extra: number } {
  const pt = bt.per_trader ?? [];
  if (pt.length > 0) {
    return { primary: traderLabel(pt[0]), extra: pt.length - 1 };
  }
  const ids = bt.config?.traderIds ?? [];
  if (ids.length > 0) return { primary: `#${ids[0]}`, extra: ids.length - 1 };
  return { primary: '—', extra: 0 };
}

export default function BacktestsPage() {
  const { data, loading, error } = useApi<{ backtests: Backtest[] }>('/backtests');

  const columns: Column<Backtest>[] = [
    {
      key: 'strategy',
      header: 'Strategy',
      cell: (bt) => (
        <div>
          <p className="font-medium text-foreground">{bt.strategy}</p>
          <p className="text-xs text-muted-foreground">
            {formatDate(bt.start_date, 'short')} – {formatDate(bt.end_date, 'short')}
          </p>
        </div>
      ),
    },
    {
      key: 'trader',
      header: 'Trader',
      cell: (bt) => {
        const { primary, extra } = tradersSummary(bt);
        return (
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground">{primary}</span>
            {extra > 0 && (
              <span
                className="text-xs text-muted-foreground"
                title={(bt.per_trader ?? []).map(traderLabel).join(', ')}
              >
                +{extra}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'category',
      header: 'Category',
      cell: (bt) => <StatBadge label={bt.category || 'all'} variant="neutral" />,
    },
    {
      key: 'return',
      header: 'Return %',
      cell: (bt) => {
        const pct = returnPct(bt);
        return (
          <span
            className={cn(
              'tabular-nums font-medium',
              (pct ?? 0) > 0
                ? 'text-positive'
                : (pct ?? 0) < 0
                  ? 'text-negative'
                  : 'text-muted-foreground'
            )}
          >
            {pct != null ? formatPercent(pct) : '—'}
          </span>
        );
      },
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'sharpe',
      header: 'Steadiness',
      cell: (bt) => (
        <span className="tabular-nums text-foreground">
          {bt.sharpe_ratio != null ? bt.sharpe_ratio.toFixed(2) : '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'maxdd',
      header: 'Worst dip',
      cell: (bt) => (
        <span className="tabular-nums text-negative">
          {bt.max_drawdown != null ? formatCurrency(bt.max_drawdown, true) : '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'winrate',
      header: 'Win Rate',
      cell: (bt) => (
        <span className="tabular-nums text-foreground">
          {bt.win_rate != null ? `${(bt.win_rate * 100).toFixed(1)}%` : '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'trades',
      header: 'Trades',
      cell: (bt) => (
        <span className="tabular-nums text-muted-foreground">{bt.total_trades ?? 0}</span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'pnl',
      header: 'Profit',
      cell: (bt) => (
        <span
          className={cn(
            'tabular-nums font-medium',
            (bt.total_pnl ?? 0) > 0 ? 'text-positive' : (bt.total_pnl ?? 0) < 0 ? 'text-negative' : 'text-muted-foreground'
          )}
        >
          {bt.total_pnl != null ? formatCurrency(bt.total_pnl, true) : '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'created',
      header: 'Run',
      cell: (bt) => (
        <span className="text-muted-foreground text-xs">
          {formatDate(bt.created_at, 'short')}
        </span>
      ),
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <SectionHeader title="Backtests" size="lg" />
        <EmptyState icon={AlertCircle} title="Couldn't load backtests" description={error} />
      </div>
    );
  }

  const backtests = data?.backtests ?? [];
  // Feature the run with the LARGEST sample that has an equity curve — the most
  // trustworthy one to eyeball (e.g. quickql), not just whatever ran most recently.
  const curveRun = backtests
    .filter((b) => (b.equity_curve?.length ?? 0) > 1)
    .sort((a, b) => (b.total_trades ?? 0) - (a.total_trades ?? 0))[0];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Backtests"
        subtitle="Practice runs: how a trader would have done if we'd copied them"
        size="lg"
      />

      <PlainSummary>
        A backtest replays a trader’s past trades to estimate how copying them <em>would have</em>{' '}
        gone — no real money involved. <strong>Return %</strong> is the simulated gain,{' '}
        <strong>Steadiness</strong> is how smooth that gain was (higher = less bumpy),{' '}
        <strong>Worst dip</strong> is the biggest drop along the way, and <strong>Profit</strong> is
        the dollar result. These are estimates, not guarantees.
      </PlainSummary>

      {curveRun && (
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="mb-1 flex items-baseline justify-between">
            <p className="text-sm font-medium text-foreground">Simulated balance over time</p>
            <p className="text-xs text-muted-foreground">
              {tradersSummary(curveRun).primary} · largest sample ({curveRun.total_trades ?? 0} bets)
            </p>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            How the practice balance moved if we&apos;d copied this trader — up and to the right is good.
          </p>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curveRun.equity_curve ?? []} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <YAxis
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => formatCurrency(Number(v), true)}
                  width={56}
                  tick={{ fontSize: 11 }}
                  stroke="currentColor"
                  className="text-muted-foreground"
                />
                <RTooltip
                  formatter={(v) => [formatCurrency(Number(v)), 'Balance']}
                  labelFormatter={(l) => formatDate(String(l), 'short')}
                  contentStyle={{ fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey="equity"
                  stroke={(curveRun.total_return ?? 0) >= 0 ? 'var(--color-positive, #16a34a)' : 'var(--color-negative, #dc2626)'}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {backtests.length === 0 && !loading ? (
        <EmptyState
          icon={BarChart3}
          title="No backtests yet"
          description="Run npm run backtest -- --category=sports --days=30 to create one."
        />
      ) : (
        <DataTable
          columns={columns}
          data={backtests}
          keyExtractor={(b) => String(b.id)}
          isLoading={loading}
          pageSize={20}
        />
      )}
    </div>
  );
}
