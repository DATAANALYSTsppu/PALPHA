'use client';

import { cn, timeAgo } from '@/lib/utils';

/**
 * Bot health at a glance — answers "is it running right now?" without any
 * jargon. Derives liveness from the runner's heartbeat (accounts.updated_at,
 * refreshed every ~60s): fresh = running (pulsing green), a bit old = lagging
 * (amber), very old/missing = looks stopped (red).
 */
export function BotStatusBanner({
  lastSync,
  activeTargets,
}: {
  lastSync?: string | null;
  activeTargets: number;
}) {
  const ageMs = lastSync ? Date.now() - new Date(lastSync).getTime() : null;
  const state =
    ageMs == null ? 'unknown' : ageMs < 3 * 60_000 ? 'running' : ageMs < 15 * 60_000 ? 'lagging' : 'stale';

  const cfg = {
    running: { dot: 'bg-positive', text: 'Bot is running', cls: 'text-positive' },
    lagging: { dot: 'bg-warning', text: 'Bot may be lagging', cls: 'text-warning' },
    stale: { dot: 'bg-negative', text: 'Bot looks stopped', cls: 'text-negative' },
    unknown: { dot: 'bg-muted-foreground', text: 'Bot status unknown', cls: 'text-muted-foreground' },
  }[state];

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2.5 w-2.5">
          {state === 'running' && (
            <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', cfg.dot)} />
          )}
          <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', cfg.dot)} />
        </span>
        <span className={cn('text-sm font-semibold', cfg.cls)}>{cfg.text}</span>
        {lastSync && (
          <span className="text-xs text-muted-foreground">· last activity {timeAgo(lastSync)}</span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        {activeTargets} trader{activeTargets === 1 ? '' : 's'} active
      </span>
    </div>
  );
}
