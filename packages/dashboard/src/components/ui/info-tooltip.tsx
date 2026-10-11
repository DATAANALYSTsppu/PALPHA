'use client';

import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A small accessible "ⓘ" with a hover/focus tooltip. Pure CSS (group-hover +
 * focus-within), no dependencies. Use next to a label for the precise definition
 * behind a term, layered on top of the always-visible plain-English captions.
 */
export function InfoTooltip({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('group relative inline-flex items-center align-middle', className)}>
      <Info
        className="h-3.5 w-3.5 cursor-help text-muted-foreground/50 hover:text-muted-foreground"
        tabIndex={0}
        aria-label={text}
      />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-[230px] -translate-x-1/2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-normal normal-case leading-snug text-foreground opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
