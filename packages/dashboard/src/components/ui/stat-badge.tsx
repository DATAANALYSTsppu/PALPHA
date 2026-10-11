import { cn } from '@/lib/utils';

type BadgeVariant = 'positive' | 'negative' | 'warning' | 'neutral' | 'info' | 'pending';

interface StatBadgeProps {
  label: string;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
  /** Hover tooltip — used to explain skip reasons in full. */
  title?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  positive: 'bg-positive-muted text-positive border-positive/20',
  negative: 'bg-negative-muted text-negative border-negative/20',
  warning: 'bg-warning-muted text-warning border-warning/20',
  pending: 'bg-warning-muted text-warning border-warning/20',
  neutral: 'bg-muted text-muted-foreground border-border',
  info: 'bg-primary/10 text-primary border-primary/20',
};

const dotStyles: Record<BadgeVariant, string> = {
  positive: 'bg-positive',
  negative: 'bg-negative',
  warning: 'bg-warning',
  pending: 'bg-warning',
  neutral: 'bg-muted-foreground',
  info: 'bg-primary',
};

export function StatBadge({ label, variant = 'neutral', dot = false, className, title }: StatBadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border',
        variantStyles[variant],
        title && 'cursor-help',
        className
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full flex-shrink-0', dotStyles[variant])} />}
      {label}
    </span>
  );
}

// Polymarket-specific helpers
type PositionStatus = 'open' | 'closing' | 'closed' | 'redeem_pending' | 'failed' | 'expired';

export function positionStatusBadge(status: PositionStatus) {
  const map: Record<PositionStatus, { label: string; variant: BadgeVariant }> = {
    open: { label: 'Open', variant: 'info' },
    closing: { label: 'Closing', variant: 'pending' },
    closed: { label: 'Closed', variant: 'neutral' },
    redeem_pending: { label: 'Redeem Pending', variant: 'pending' },
    failed: { label: 'Failed', variant: 'negative' },
    expired: { label: 'Expired', variant: 'neutral' },
  };
  const { label, variant } = map[status] || { label: status, variant: 'neutral' as BadgeVariant };
  return <StatBadge label={label} variant={variant} dot />;
}

type SignalStatus = 'acted_on' | 'skipped' | 'pending';

/** Turn an internal skip_reason code into a plain-English phrase a non-technical
 *  reader understands. Unknown codes fall back to a tidied version of the code. */
export function friendlySkipReason(reason?: string): string {
  if (!reason) return 'Skipped';
  const r = reason.toLowerCase();
  // Price Re-Check Engine states (checked first: they can embed other codes).
  if (r === 'price_watch') return 'Watching price (re-check)';
  if (r.startsWith('recheck_abandoned')) {
    if (r.includes('price_moved_against_us')) return 'Re-check: price ran away';
    if (r.includes('max_time_exceeded')) return 'Re-check: price never came back';
    if (r.includes('target_sold')) return 'Re-check: they sold first';
    if (r.includes('target_inactive')) return 'Re-check: trader paused';
    return 'Re-check abandoned';
  }
  if (r.includes('above_limit') || r.includes('below_floor')) return 'Price moved against us';
  if (r.includes('no_liquidity_at_our_price')) return 'Nobody selling at our price';
  if (r.includes('nothing_left_to_sell')) return 'Nothing left to sell';
  if (r.startsWith('buy_failed')) return "Couldn't buy";
  if (r.startsWith('sell_failed')) return "Couldn't sell";
  const map: Record<string, string> = {
    below_min_price: 'Price too low',
    above_max_price: 'Price too high',
    convert_detected: 'Not a real bet',
    not_my_position: "They sold — we weren't in it",
    market_closed: 'Market already closed',
    market_resolved: 'Market already finished',
    too_far_from_resolution: 'Event too far away',
    not_tracked_market: 'Market not tracked',
    excluded_subcategory: 'Excluded category',
    category_mismatch: 'Different category',
    category_unknown: 'Unknown category',
    already_open_for_target: 'Already holding this',
    insufficient_balance: 'Not enough balance',
    at_max_positions: 'At position limit',
    at_max_per_event: 'Match stake limit reached',
    at_max_per_market: 'Market stake limit reached',
  };
  if (map[r]) return map[r];
  // Tidy unknown codes: "some_reason" -> "Some reason"
  const tidy = r.replace(/[_:]/g, ' ').replace(/\s+/g, ' ').trim();
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
}

/** One-sentence "why" behind a skip, shown on hover. */
export function skipReasonDetail(reason?: string): string | undefined {
  if (!reason) return undefined;
  const r = reason.toLowerCase();
  if (r === 'price_watch') {
    return 'The price had moved past our limit when the bot arrived. Instead of dropping the trade, the bot is re-checking the price for up to 10 minutes (at 30s, 2m, 5m, 8m and 10m) and will buy if it comes back into range.';
  }
  if (r.startsWith('recheck_abandoned')) {
    if (r.includes('price_moved_against_us')) return 'During the re-check window the price rose more than 5% above where it was first seen, so the bot gave up rather than chase it.';
    if (r.includes('max_time_exceeded')) return 'The bot re-checked the price for 10 minutes but it never came back inside our slippage limit, so the trade was dropped.';
    if (r.includes('target_sold')) return 'The trader sold this market while we were waiting for the price, so the bot stopped trying to buy it.';
    if (r.includes('target_inactive')) return 'The trader was paused or removed while we were waiting for the price.';
    if (r.includes('interrupted_during_buy')) return 'The bot stopped while a late buy was in flight. It does not retry in that case \u2014 check the wallet for an untracked fill.';
    return 'The re-check ended without buying (a position or stake limit now applied, or the order was rejected).';
  }
  if (r.includes('no_liquidity_at_our_price')) {
    return 'The order was placed but nothing on the book was within our price limit \u2014 the trader\u2019s price plus the slippage allowance, capped by the maximum entry price. The bot passed rather than chase the market up.';
  }
  if (r.includes('nothing_left_to_sell')) {
    return 'The trader sold again, but our side of that position was already fully exited or settled, so there was nothing left to sell.';
  }
  if (r.includes('above_limit')) {
    return 'The market had already moved by the time the bot got there, and filling would have cost more than the allowed slippage over the trader\u2019s own price. The bot passed rather than overpay.';
  }
  if (r.includes('below_floor')) {
    return 'The bid had dropped further below the trader\u2019s exit price than the allowed slippage, so the bot held instead of dumping into a thin book.';
  }
  if (r.startsWith('buy_failed')) {
    const why = r.slice('buy_failed:'.length).replace(/[_:]/g, ' ').trim();
    return `The buy order was rejected by Polymarket${why ? ` (${why})` : ''}. Most often the funding wallet is short on USDC.`;
  }
  if (r.startsWith('sell_failed')) {
    const why = r.slice('sell_failed:'.length).replace(/[_:]/g, ' ').trim();
    return `The sell order was rejected by Polymarket${why ? ` (${why})` : ''}. The position is still open and will be retried.`;
  }
  const map: Record<string, string> = {
    below_min_price:
      'They bought cheaper than the bot\u2019s minimum price. Longshots at these odds lose too often to copy.',
    above_max_price:
      'They bought a heavy favourite, above the bot\u2019s maximum price \u2014 too much risked for too little upside.',
    convert_detected: 'This was a position conversion on Polymarket, not a new bet, so there was nothing to copy.',
    not_my_position:
      'They sold a position the bot never opened \u2014 usually because their original buy was skipped (price band, category, or a failed order), or they were already holding it before you started copying them. There was nothing on our side to sell.',
    market_closed: 'Trading on this market had already closed by the time the bot saw the trade.',
    market_resolved: 'This market had already settled, so the outcome was decided and there was nothing to copy.',
    too_far_from_resolution: 'The event settles too far in the future \u2014 the bot keeps its money working on nearer markets.',
    not_tracked_market: 'This market isn\u2019t in one of the categories the bot follows.',
    excluded_subcategory: 'This market\u2019s sub-category is on the bot\u2019s exclusion list.',
    category_mismatch: 'This trader is only copied for certain categories, and this market isn\u2019t one of them.',
    category_unknown: 'The bot couldn\u2019t work out which category this market belongs to, so it stayed out.',
    already_open_for_target: 'The bot already holds this position from this trader and doesn\u2019t double up.',
    insufficient_balance: 'The funding wallet didn\u2019t have enough USDC to place this order.',
    at_max_positions: 'The bot was already holding its maximum number of positions at once.',
    at_max_per_event:
      'We had already staked the maximum allowed on this match. Ordinary sport is capped across the whole fixture, so the moneyline, over/under and handicap on one game share a single limit.',
    at_max_per_market: 'We had already staked the maximum allowed on this market.',
  };
  return map[r];
}

export function signalStatusBadge(status: SignalStatus, skipReason?: string) {
  if (status === 'acted_on') return <StatBadge label="Copied ✓" variant="positive" dot />;
  if (status === 'pending') return <StatBadge label="Pending" variant="pending" dot />;
  return (
    <StatBadge
      label={friendlySkipReason(skipReason)}
      title={skipReasonDetail(skipReason)}
      variant="neutral"
      dot
    />
  );
}

type TargetStatus = 'active' | 'paused' | 'stopped';

export function targetStatusBadge(status: TargetStatus) {
  const map: Record<TargetStatus, { label: string; variant: BadgeVariant }> = {
    active: { label: 'Active', variant: 'positive' },
    paused: { label: 'Paused', variant: 'pending' },
    stopped: { label: 'Stopped', variant: 'neutral' },
  };
  const { label, variant } = map[status] || { label: status, variant: 'neutral' as BadgeVariant };
  return <StatBadge label={label} variant={variant} dot />;
}
