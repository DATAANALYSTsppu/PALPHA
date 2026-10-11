'use client';

import { useEffect, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SectionHeader } from '@/components/ui/section-header';
import { PlainSummary } from '@/components/ui/plain-summary';
import { StatBadge } from '@/components/ui/stat-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { CopyAddress } from '@/components/ui/copy-address';
import { Users, Trophy, AlertCircle, Pause, Play, Trash2, Plus, Pencil } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { targetsApi, type Trader, type CopyTarget } from '@/lib/api';

const CATEGORIES = ['sports', 'weather'] as const;
type Category = (typeof CATEGORIES)[number];

// What a copy target can be scoped to — a superset of the leaderboard tabs: a
// wallet can be copied on esports without us ranking esports traders yet. Any
// combination is allowed; the bot comma-splits copy_targets.category and copies
// a trade only when the market's category is in the list.
const TARGET_CATEGORIES = ['sports', 'esports', 'weather'] as const;
type TargetCategory = (typeof TARGET_CATEGORIES)[number];

/** Selected chips in TARGET_CATEGORIES order, so the stored string is stable. */
function catList(value: Set<TargetCategory>): TargetCategory[] {
  return TARGET_CATEGORIES.filter((c) => value.has(c));
}

/** "sports,esports" -> Set. Unknown values are dropped. */
function parseCats(raw?: string | null): Set<TargetCategory> {
  const parts = (raw ?? '').split(',').map((x) => x.trim().toLowerCase());
  return new Set(TARGET_CATEGORIES.filter((c) => parts.includes(c)));
}

// Minimum resolved-in-window markets before we trust (and show) a trader's
// cash-flow P/L. Matches the leaderboard's min_markets default; below this the
// number is small-sample noise.
const MIN_PNL_MARKETS = 20;

interface TradersResponse {
  traders: Trader[];
  targets: CopyTarget[];
}

export default function TradersPage() {
  const [category, setCategory] = useState<Category>('sports');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CopyTarget | null>(null);
  const [busyTargetId, setBusyTargetId] = useState<number | null>(null);

  const { data, loading, error, refresh } = useApi<TradersResponse>(
    `/traders?category=${category}&limit=50&min_markets=20`
  );

  // ── Target actions ───────────────────────────────────────────
  async function toggleStatus(t: CopyTarget) {
    setBusyTargetId(t.id);
    try {
      const next = t.status === 'active' ? 'paused' : 'active';
      await targetsApi.setStatus(t.id, next);
      refresh();
    } catch (err) {
      alert(`Failed to update target: ${(err as Error).message}`);
    } finally {
      setBusyTargetId(null);
    }
  }

  async function removeTarget(t: CopyTarget) {
    if (!confirm(`Stop copying ${t.display_name || t.trader_id}?`)) return;
    setBusyTargetId(t.id);
    try {
      await targetsApi.remove(t.id);
      refresh();
    } catch (err) {
      alert(`Failed to remove target: ${(err as Error).message}`);
    } finally {
      setBusyTargetId(null);
    }
  }

  // ── Copy Targets table ───────────────────────────────────────
  const targetColumns: Column<CopyTarget>[] = [
    {
      key: 'status',
      header: 'Status',
      cell: (t) => {
        const variant =
          t.status === 'active' ? 'positive' : t.status === 'paused' ? 'pending' : 'neutral';
        const label = t.status.charAt(0).toUpperCase() + t.status.slice(1);
        return <StatBadge label={label} variant={variant} dot />;
      },
    },
    {
      key: 'name',
      header: 'Name / Wallet',
      cell: (t) => (
        <div>
          <p className="font-medium text-foreground">{t.display_name || 'Anonymous'}</p>
          {/* Manually-added targets (SIMPLE_TARGET_WALLETS) don't have a
              trader_id link — show the wallet via CopyAddress in that case so
              users can identify and copy it. Targets with a trader_id keep
              the existing # display. */}
          {t.proxy_wallet ? (
            <CopyAddress address={t.proxy_wallet} />
          ) : t.trader_id ? (
            <p className="text-xs text-muted-foreground tabular-nums">#{t.trader_id}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      cell: (t) => (
        <button
          type="button"
          onClick={() => setEditTarget(t)}
          title="Change which markets we copy from this wallet"
          className="rounded-full focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <StatBadge
            label={t.category ? t.category.split(',').join(' + ') : 'all markets'}
            variant="neutral"
            className="cursor-pointer hover:text-foreground"
          />
        </button>
      ),
    },
    {
      key: 'alpha_score',
      header: 'Skill score',
      cell: (t) => (
        <span className="font-medium tabular-nums text-primary">
          {t.alpha_score?.toFixed(2) ?? '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'trader_pnl',
      header: 'Trader P/L',
      // Our trader_pnl is a cash-flow estimate over markets that resolved inside
      // our scan window. Below MIN_PNL_MARKETS that's too small a sample to mean
      // anything (e.g. a freshly-added, actively-trading wallet with mostly open
      // positions), so show a muted placeholder instead of a misleading number.
      cell: (t) => {
        const enoughData = (t.trader_markets ?? 0) >= MIN_PNL_MARKETS && t.trader_pnl != null;
        if (!enoughData) {
          return (
            <span
              className="tabular-nums text-muted-foreground"
              title={`Not enough resolved markets (<${MIN_PNL_MARKETS}) to estimate P/L reliably`}
            >
              —
            </span>
          );
        }
        return (
          <span
            className={cn(
              'tabular-nums',
              t.trader_pnl! > 0 ? 'text-positive' : t.trader_pnl! < 0 ? 'text-negative' : 'text-muted-foreground'
            )}
          >
            {formatCurrency(t.trader_pnl!, true)}
          </span>
        );
      },
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'actions',
      header: '',
      cell: (t) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEditTarget(t)}
            disabled={busyTargetId === t.id}
            aria-label="Edit categories"
            title="Change categories"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => toggleStatus(t)}
            disabled={busyTargetId === t.id || t.status === 'stopped'}
            aria-label={t.status === 'active' ? 'Pause' : 'Resume'}
            title={t.status === 'active' ? 'Pause' : 'Resume'}
          >
            {t.status === 'active' ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => removeTarget(t)}
            disabled={busyTargetId === t.id}
            aria-label="Remove"
            title="Stop copying"
            className="text-negative hover:text-negative"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
  ];

  // ── Leaderboard table ───────────────────────────────────────
  const leaderboardColumns: Column<Trader & { rank: number }>[] = [
    {
      key: 'rank',
      header: '#',
      cell: (t) => <span className="text-muted-foreground tabular-nums">{t.rank}</span>,
      className: 'w-12',
    },
    {
      key: 'wallet',
      header: 'Trader',
      cell: (t) => (
        <div>
          <p className="font-medium text-foreground">{t.display_name || 'Anonymous'}</p>
          <CopyAddress address={t.proxy_wallet} />
        </div>
      ),
    },
    {
      key: 'score',
      header: 'Score',
      cell: (t) => (
        <span className="font-semibold tabular-nums text-primary">
          {(t.composite_score ?? t.alpha_score ?? 0).toFixed(3)}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'win_rate',
      header: 'Win Rate',
      cell: (t) => (
        <span className="tabular-nums text-foreground">
          {t.win_rate != null ? `${(t.win_rate * 100).toFixed(1)}%` : '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'roi',
      header: 'ROI',
      cell: (t) => (
        <span
          className={cn(
            'tabular-nums',
            (t.roi ?? 0) > 0 ? 'text-positive' : (t.roi ?? 0) < 0 ? 'text-negative' : 'text-muted-foreground'
          )}
        >
          {t.roi != null ? `${(t.roi * 100).toFixed(0)}%` : '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'pnl',
      header: 'P/L',
      cell: (t) => (
        <span
          className={cn(
            'tabular-nums',
            (t.total_pnl ?? 0) > 0 ? 'text-positive' : (t.total_pnl ?? 0) < 0 ? 'text-negative' : 'text-muted-foreground'
          )}
        >
          {t.total_pnl != null ? formatCurrency(t.total_pnl, true) : '—'}
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'markets',
      header: 'Markets',
      cell: (t) => (
        <span className="tabular-nums text-muted-foreground">{t.total_markets}</span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
    {
      key: 'wl',
      header: 'W / L',
      cell: (t) => (
        <span className="tabular-nums text-sm">
          <span className="text-positive">{t.wins ?? 0}</span>
          <span className="text-muted-foreground"> / </span>
          <span className="text-negative">{t.losses ?? 0}</span>
        </span>
      ),
      className: 'text-right',
      headerClassName: 'text-right',
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <SectionHeader title="Traders" size="lg" />
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load traders"
          description={error}
        />
      </div>
    );
  }

  const targets = data?.targets ?? [];
  const traders = (data?.traders ?? []).map((t, i) => ({ ...t, rank: i + 1 }));

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Traders"
        subtitle="The traders you're copying, and a leaderboard of the best ones"
        size="lg"
        actions={
          <div className="flex items-center gap-1 bg-muted rounded-md p-1">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded transition-colors capitalize',
                  category === c
                    ? 'bg-surface text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {c}
              </button>
            ))}
          </div>
        }
      />

      <PlainSummary>
        “Copy targets” are the traders the bot mirrors — green “Active” ones are live, the rest are
        paused. The “Skill score” (0–100) rates how good a trader has been historically; higher is
        better. The leaderboard below ranks the strongest traders we’ve found in each category.
      </PlainSummary>

      {/* Copy targets */}
      <section className="space-y-3">
        <SectionHeader
          title="Copy targets"
          subtitle={`${targets.length} wallets configured`}
          actions={
            <Button variant="outline" size="sm" onClick={() => setAddModalOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add target
            </Button>
          }
        />
        {targets.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No copy targets yet"
            description="Pick from the leaderboard below or add a wallet manually."
            action={
              <Button size="sm" onClick={() => setAddModalOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add target
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={targetColumns}
            data={targets}
            keyExtractor={(t) => String(t.id)}
            isLoading={loading}
          />
        )}
      </section>

      <AddTargetDialog
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        defaultCategory={category}
        onAdded={() => {
          setAddModalOpen(false);
          refresh();
        }}
      />

      <EditCategoryDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          refresh();
        }}
      />

      {/* Leaderboard */}
      <section className="space-y-3">
        <SectionHeader
          title="Alpha leaderboard"
          subtitle={`Top traders in ${category} · min. 20 markets`}
        />
        {traders.length === 0 && !loading ? (
          <EmptyState
            icon={Trophy}
            title="No traders scored yet"
            description="Run the scoring job after the trader_id backfill completes."
          />
        ) : (
          <DataTable
            columns={leaderboardColumns}
            data={traders}
            keyExtractor={(t) => String(t.id)}
            isLoading={loading}
            pageSize={20}
          />
        )}
      </section>
    </div>
  );
}

// ─── Category picker ────────────────────────────────────────────────

/** Multi-select category chips, shared by the add and edit dialogs. */
function CategoryPicker({
  value,
  onChange,
}: {
  value: Set<TargetCategory>;
  onChange: (next: Set<TargetCategory>) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
        Category <span className="font-normal">(pick one or more)</span>
      </label>
      <div className="flex items-center gap-1 bg-muted rounded-md p-1 w-fit">
        {TARGET_CATEGORIES.map((c) => {
          const on = value.has(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = new Set(value);
                if (next.has(c)) next.delete(c);
                else next.add(c);
                onChange(next);
              }}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded transition-colors capitalize',
                on
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {c}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {value.size === 0
          ? 'Pick at least one — the bot only copies markets in the chosen categories.'
          : `Copies ${catList(value).join(' + ')} trades only.`}
      </p>
    </div>
  );
}

// ─── Edit Category Dialog ───────────────────────────────────────────

interface EditCategoryDialogProps {
  target: CopyTarget | null;
  onClose: () => void;
  onSaved: () => void;
}

function EditCategoryDialog({ target, onClose, onSaved }: EditCategoryDialogProps) {
  const [cats, setCats] = useState<Set<TargetCategory>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reseed whenever a different target is opened.
  useEffect(() => {
    if (target) {
      setCats(parseCats(target.category));
      setErr(null);
    }
  }, [target]);

  async function save() {
    if (!target) return;
    if (cats.size === 0) {
      setErr('Pick at least one category.');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await targetsApi.setCategory(target.id, catList(cats).join(','));
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title="Change categories"
      description="Which markets the bot copies from this wallet. Applies on the next polling cycle."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {target && (
          <p className="text-sm text-foreground">
            {target.display_name || target.proxy_wallet || `Target #${target.id}`}
          </p>
        )}
        <CategoryPicker value={cats} onChange={setCats} />
        {err && <p className="text-sm text-negative">{err}</p>}
      </div>
    </Dialog>
  );
}

// ─── Add Target Dialog ──────────────────────────────────────────────

interface AddTargetDialogProps {
  open: boolean;
  onClose: () => void;
  defaultCategory: Category;
  onAdded: () => void;
}

function AddTargetDialog({ open, onClose, defaultCategory, onAdded }: AddTargetDialogProps) {
  const [wallet, setWallet] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [cats, setCats] = useState<Set<TargetCategory>>(new Set([defaultCategory]));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Follow the leaderboard tab the dialog was opened from, and reset a
  // half-finished selection when it's reopened.
  useEffect(() => {
    if (open) setCats(new Set([defaultCategory]));
  }, [open, defaultCategory]);

  async function submit() {
    setErr(null);
    const w = wallet.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(w)) {
      setErr('Wallet must be a 0x-prefixed 40-hex Ethereum address.');
      return;
    }
    if (cats.size === 0) {
      setErr('Pick at least one category.');
      return;
    }
    setSubmitting(true);
    try {
      await targetsApi.add({
        wallet: w,
        displayName: displayName.trim() || undefined,
        category: catList(cats).join(','),
      });
      setWallet('');
      setDisplayName('');
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add copy target"
      description="The bot will start copying this wallet's trades on the next polling cycle."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add target'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            Wallet address
          </label>
          <input
            type="text"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x..."
            spellCheck={false}
            className="w-full h-9 px-3 rounded-md border border-input bg-surface text-foreground text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            Display name (optional)
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Alice"
            className="w-full h-9 px-3 rounded-md border border-input bg-surface text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
          />
        </div>

        <CategoryPicker value={cats} onChange={setCats} />

        {err && <p className="text-sm text-negative">{err}</p>}
      </div>
    </Dialog>
  );
}
