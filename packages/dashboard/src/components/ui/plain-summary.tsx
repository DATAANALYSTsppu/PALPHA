import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A plain-English, always-visible one-liner that narrates the current state of a
 * page in everyday words — so a non-technical reader understands the screen at a
 * glance without hovering tooltips or knowing jargon. Purely presentational.
 */
export function PlainSummary({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-foreground/90 leading-relaxed',
        className,
      )}
    >
      <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
      <p>{children}</p>
    </div>
  );
}
