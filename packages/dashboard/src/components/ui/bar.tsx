import { cn } from '@/lib/utils';

/**
 * A thin horizontal progress bar — a visual readout that's faster to parse than
 * a bare number (e.g. win rate, or money-in-play vs balance).
 */
export function Bar({
  value,
  max = 100,
  color = 'bg-primary',
  className,
}: {
  value: number;
  max?: number;
  color?: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}
