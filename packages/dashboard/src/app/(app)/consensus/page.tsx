'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { SectionHeader } from '@/components/ui/section-header';
import { MetricCard } from '@/components/ui/metric-card';
import { StatBadge } from '@/components/ui/stat-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PlainSummary } from '@/components/ui/plain-summary';
import { AlertCircle, Network, ExternalLink } from 'lucide-react';
import { cn, formatCurrency, timeAgo } from '@/lib/utils';

interface Book {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  askDepthUsdInSlip: number;
  slippage: number | null;
  copyable: boolean;
}
interface SideTrader { wallet: string; name: string; usd: number; shares: number; avgPrice: number }
interface Side {
  outcome: string;
  asset: string;
  traderCount: number;
  totalUsd: number;
  shares: number;
  avgPrice: number;
  traders: SideTrader[];
  book: Book | null;
}
interface Market {
  conditionId: string;
  title: string;
  slug: string;
  eventSlug: string;
  endDate: string;
  traderCount: number;
  totalUsd: number;
  topSide: string;
  agreement: number;
  split: boolean;
  sides: Side[];
}
interface TraderInfo {
  wallet: string;
  name: string;
  qualified: boolean | null;
  reasons: string[];
  roi: number | null;
  wins: number | null;
  grossWin: number | null;
  grossLoss: number | null;
}
interface ConsensusResponse {
  updatedAt: string;
  slippageCap: number;
  targetCount: number;
  failedWallets: string[];
  traders: TraderInfo[];
  markets: Market[];
}

const cents = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}¢`);

function sideBadge(outcome: string) {
  if (outcome === 'Yes') return <StatBadge label="YES" variant="positive" />;
  if (outcome === 'No') return <StatBadge label="NO" variant="negative" />;
  return <StatBadge label={outcome || '—'} variant="info" />;
}

export default function ConsensusPage() {
  const [minTraders, setMinTraders] = useState(2);
  // Live: positions are cached 60s and books 10s server-side, so 30s polling is cheap.
  const { data, loading, error } = useApi<ConsensusResponse>(`/consensus?min=${minTraders}&limit=40`, 30000);

  if (error) {
    return (
      <div className="space-y-6">
        <SectionHeader title="Consensus" size="lg" />
        <EmptyState icon={AlertCircle} title="Couldn't load consensus" description={error} />
      </div>
    );
  }

  const markets = data?.markets ?? [];
  const traders = data?.traders ?? [];
  const qualifiedCount = traders.filter((t) => t.qualified).length;
  const biggest = markets[0];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Consensus"
        subtitle="Markets where the traders you follow overlap — which side, how much money, and the live Polymarket price"
        size="lg"
        actions={
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Min traders
            <select
              value={minTraders}
              onChange={(e) => setMinTraders(parseInt(e.target.value, 10))}
              className="rounded-md border border-border bg-surface px-2 py-1 text-foreground"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n}+</option>
              ))}
            </select>
          </label>
        }
      />

      <PlainSummary>
        This looks at what your <strong>{data?.targetCount ?? 0}</strong> active trader
        {(data?.targetCount ?? 0) === 1 ? '' : 's'} are holding <em>right now</em> and ranks markets by how many of them
        are in. For each side you see the total money they put in, their average entry price, and the{' '}
        <strong>real live order book</strong> from Polymarket — so you can tell whether you could still buy within{' '}
        {((data?.slippageCap ?? 0.05) * 100).toFixed(0)}¢ of their price.
      </PlainSummary>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Active traders" value={data?.targetCount ?? 0} variant="number" hint="Wallets being followed" />
        <MetricCard label="Markets shown" value={markets.length} variant="number" hint={`With ${minTraders}+ traders in`} />
        <MetricCard
          label="Most-held market"
          value={biggest ? `${biggest.traderCount} traders` : '—'}
          hint={biggest ? biggest.title.slice(0, 40) : 'Nothing overlaps yet'}
        />
        <MetricCard label="Qualified traders" value={qualifiedCount} variant="number" hint="Get the bigger bet size" tooltip="ROI rule, or 50+ wins with more $ won than lost. Still measuring shows as pending." />
      </div>

      {(data?.failedWallets.length ?? 0) > 0 && (
        <p className="text-xs text-warning">
          Couldn&apos;t read positions for {data?.failedWallets.length} wallet(s) this refresh — numbers may be incomplete.
        </p>
      )}

      <section className="space-y-3">
        <SectionHeader title="Overlapping markets" subtitle={data ? `Updated ${timeAgo(data.updatedAt)}` : undefined} />

        {markets.length === 0 && !loading ? (
          <EmptyState
            icon={Network}
            title="No overlapping markets"
            description={
              minTraders > 1
                ? 'No market has this many of your traders in it right now. Lower “Min traders” to see single-trader positions.'
                : 'Add active traders on the Traders page and their open positions will appear here.'
            }
          />
        ) : (
          <div className="space-y-4">
            {markets.map((m) => (
              <article key={m.conditionId} className="rounded-lg border border-border bg-surface">
                <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-border">
                  <div className="min-w-0">
                    <h3 className="font-medium text-foreground">{m.title || m.conditionId.slice(0, 18)}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {m.endDate ? `Ends ${m.endDate.slice(0, 10)} · ` : ''}
                      Total in: {formatCurrency(m.totalUsd, true)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatBadge label={`${m.traderCount} trader${m.traderCount === 1 ? '' : 's'}`} variant="info" />
                    {m.split ? (
                      <StatBadge label="Split" variant="warning" title="Your traders are on opposite sides of this market" />
                    ) : (
                      <StatBadge label="Agree" variant="positive" title="Everyone is on the same side" />
                    )}
                    {(m.eventSlug || m.slug) && (
                      <a
                        href={`https://polymarket.com/event/${m.eventSlug || m.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        title="Open on Polymarket"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </header>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground uppercase tracking-wider">
                        <th className="px-4 py-2 text-left font-medium">Side</th>
                        <th className="px-4 py-2 text-right font-medium">Traders</th>
                        <th className="px-4 py-2 text-right font-medium">Money in</th>
                        <th className="px-4 py-2 text-right font-medium">Avg entry</th>
                        <th className="px-4 py-2 text-right font-medium">Live bid / ask</th>
                        <th className="px-4 py-2 text-right font-medium">Slippage now</th>
                        <th className="px-4 py-2 text-left font-medium">Who &amp; how much</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.sides.map((s) => (
                        <tr key={s.asset} className="border-t border-border align-top">
                          <td className="px-4 py-3">{sideBadge(s.outcome)}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{s.traderCount}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(s.totalUsd, true)}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{cents(s.avgPrice)}</td>
                          <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                            {s.book ? `${cents(s.book.bestBid)} / ${cents(s.book.bestAsk)}` : <span className="text-muted-foreground">book n/a</span>}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {s.book && s.book.slippage !== null ? (
                              <span className={cn('tabular-nums', s.book.copyable ? 'text-positive' : 'text-negative')}>
                                {s.book.slippage >= 0 ? '+' : ''}{(s.book.slippage * 100).toFixed(1)}¢{' '}
                                <span className="text-xs text-muted-foreground">
                                  ({formatCurrency(s.book.askDepthUsdInSlip, true)} avail.)
                                </span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              {s.traders.map((t) => (
                                <span
                                  key={t.wallet}
                                  title={`${t.wallet} — avg entry ${cents(t.avgPrice)}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
                                >
                                  {t.name}
                                  <span className="tabular-nums text-muted-foreground">{formatCurrency(t.usd, true)}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Trader quality" subtitle="Who gets the bigger bet size (needs SIMPLE_QUALITY_SIZING=true on the bot)" />
        <div className="rounded-lg border border-border bg-surface divide-y divide-border">
          {traders.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No active traders.</p>}
          {traders.map((t) => (
            <div key={t.wallet} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div>
                <span className="font-medium text-foreground">{t.name}</span>
                <p className="text-xs text-muted-foreground">{t.reasons[0] ?? 'Measuring…'}</p>
              </div>
              {t.qualified === null ? (
                <StatBadge label="Measuring…" variant="pending" />
              ) : t.qualified ? (
                <StatBadge label="Qualified" variant="positive" />
              ) : (
                <StatBadge label="Base size" variant="neutral" />
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
