'use client';

import { cn, formatCurrency, formatPercent } from '@/lib/utils';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { InfoTooltip } from './info-tooltip';

type MetricVariant = 'currency' | 'percent' | 'number' | 'text';
type TrendDirection = 'up' | 'down' | 'neutral';

interface MetricCardProps {
  label: string;
  value: string | number;
  variant?: MetricVariant;
  change?: number;
  changePeriod?: string;
  trend?: TrendDirection;
  compact?: boolean;
  className?: string;
  prefix?: string;
  suffix?: string;
  /** Always-visible plain-English caption under the value (for non-technical readers). */
  hint?: string;
  /** Optional precise definition shown in an ⓘ hover tooltip next to the label. */
  tooltip?: string;
  /** Optional content rendered below the value/hint (e.g. a progress bar). */
  children?: React.ReactNode;
}

function formatValue(value: string | number, variant: MetricVariant, compact: boolean): string {
  if (typeof value === 'string') return value;
  switch (variant) {
    case 'currency':
      return formatCurrency(value, compact);
    case 'percent':
      return `${value.toFixed(2)}%`;
    case 'number':
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
    default:
      return String(value);
  }
}

export function MetricCard({
  label,
  value,
  variant = 'text',
  change,
  changePeriod,
  trend,
  compact = false,
  className,
  prefix,
  suffix,
  hint,
  tooltip,
  children,
}: MetricCardProps) {
  const resolvedTrend: TrendDirection =
    trend ?? (change !== undefined ? (change > 0 ? 'up' : change < 0 ? 'down' : 'neutral') : 'neutral');

  const TrendIcon =
    resolvedTrend === 'up' ? TrendingUp : resolvedTrend === 'down' ? TrendingDown : Minus;

  const trendColor =
    resolvedTrend === 'up'
      ? 'text-positive'
      : resolvedTrend === 'down'
        ? 'text-negative'
        : 'text-muted-foreground';

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface p-6 flex flex-col gap-1',
        className
      )}
    >
      <p className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </p>
      <p className="text-2xl font-semibold tabular-nums text-foreground tracking-tight">
        {prefix && <span className="text-muted-foreground text-lg">{prefix}</span>}
        {formatValue(value, variant, compact)}
        {suffix && <span className="text-muted-foreground text-lg ml-1">{suffix}</span>}
      </p>
      {change !== undefined && (
        <div className={cn('flex items-center gap-1 text-sm', trendColor)}>
          <TrendIcon className="h-3.5 w-3.5" />
          <span className="tabular-nums font-medium">{formatPercent(change)}</span>
          {changePeriod && (
            <span className="text-muted-foreground font-normal">{changePeriod}</span>
          )}
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground/80 leading-snug mt-0.5">{hint}</p>}
      {children}
    </div>
  );
}
