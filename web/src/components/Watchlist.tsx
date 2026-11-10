'use client';

import { MAX_GROUP_NAME, type Quote, type WatchlistItem } from '@tm/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addToWatchlist, removeFromWatchlist, reorderWatchlist, setWatchlistGroup, useSparklines, useWatchlist } from '@/lib/api';
import { fmtPrice, fmtSignedPct } from '@/lib/format';
import { loadPref, savePref } from '@/lib/prefs';
import { useLiveQuotes } from '@/lib/use-live-quote';
import { PlusIcon } from './icons';
import { Sparkline } from './Sparkline';
import { Change, cx, ErrorState, Skeleton, useLang } from './ui';

type SortKey = 'manual' | 'change' | 'name' | 'price';
const SORTS: SortKey[] = ['manual', 'change', 'name', 'price'];
const NO_GROUP = '\u0000none';
const COLLAPSED_KEY = 'tm.wlCollapsed';

interface Section {
  key: string;
  name: string | null;
  items: WatchlistItem[];
}

export function Watchlist({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  const t = useTranslations('watchlist');
  const lang = useLang();
  const { data, error, isLoading, mutate } = useWatchlist();
  const items = useMemo(() => data ?? [], [data]);
  const symbols = useMemo(() => items.map((i) => i.symbol), [items]);
  const quotes = useLiveQuotes(symbols);
  const { data: sparks } = useSparklines(symbols);
  const sparkMap = useMemo(() => new Map((sparks ?? []).map((s) => [s.symbol, s.points.map((p) => p.close)])), [sparks]);

  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<SortKey>('manual');
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // Remembered preferences.
  useEffect(() => {
    const s = loadPref('wlSort') as SortKey | null;
    if (s && SORTS.includes(s)) setSort(s);
    try {
      setCollapsed(new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')));
    } catch {}
  }, []);
  const changeSort = (s: SortKey) => {
    setSort(s);
    savePref('wlSort', s);
    if (s !== 'manual') setEditing(false);
  };
  const toggleGroup = (key: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      next.has(key) ? next.delete(key) : next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });

  // Order: the server's "My order", or the in-progress drag.
  const manualOrder = dragOrder ?? symbols;
  const bySymbol = useMemo(() => new Map(items.map((i) => [i.symbol, i])), [items]);
  const groupNames = useMemo(() => [...new Set(items.map((i) => i.group).filter((g): g is string => !!g))], [items]);

  const sortItems = useCallback(
    (list: WatchlistItem[]) => {
      const q = (s: string) => quotes.get(s);
      const byNum = (f: (x?: Quote) => number | null | undefined) => (a: WatchlistItem, b: WatchlistItem) =>
        (f(q(b.symbol)) ?? -Infinity) - (f(q(a.symbol)) ?? -Infinity);
      switch (sort) {
        case 'change':
          return [...list].sort(byNum((x) => x?.changePct));
        case 'price':
          return [...list].sort(byNum((x) => x?.price));
        case 'name':
          return [...list].sort((a, b) => a.symbol.localeCompare(b.symbol));
        default:
          return [...list].sort((a, b) => manualOrder.indexOf(a.symbol) - manualOrder.indexOf(b.symbol));
      }
    },
    [sort, quotes, manualOrder],
  );

  // Sections: ungrouped first, then groups in the order they first appear in "My order".
  const sections = useMemo<Section[]>(() => {
    const ordered = [...items].sort((a, b) => manualOrder.indexOf(a.symbol) - manualOrder.indexOf(b.symbol));
    const keys: string[] = [];
    for (const i of ordered) {
      const k = i.group ?? NO_GROUP;
      if (!keys.includes(k)) keys.push(k);
    }
    keys.sort((a, b) => (a === NO_GROUP ? -1 : b === NO_GROUP ? 1 : 0));
    return keys.map((k) => ({ key: k, name: k === NO_GROUP ? null : k, items: sortItems(ordered.filter((i) => (i.group ?? NO_GROUP) === k)) }));
  }, [items, manualOrder, sortItems]);
  const grouped = groupNames.length > 0;

  // Summary: up / down / unchanged today, average % change.
  const summary = useMemo(() => {
    const pcts = symbols.map((s) => quotes.get(s)?.changePct).filter((p): p is number => typeof p === 'number');
    const up = pcts.filter((p) => p > 0).length;
    const down = pcts.filter((p) => p < 0).length;
    const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
    return { up, down, flat: pcts.length - up - down, avg, n: pcts.length };
  }, [symbols, quotes]);

  // ---- reordering (manual sort only) ----
  const sameGroup = (a: string, b: string) => (bySymbol.get(a)?.group ?? null) === (bySymbol.get(b)?.group ?? null);

  const moveBy = async (symbol: string, dir: -1 | 1) => {
    const order = [...manualOrder];
    const idx = order.indexOf(symbol);
    let j = idx + dir;
    while (j >= 0 && j < order.length && !sameGroup(order[j], symbol)) j += dir;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    const section = order.filter((s) => sameGroup(s, symbol));
    setAnnounce(t('moved', { symbol, position: section.indexOf(symbol) + 1, total: section.length }));
    await reorderWatchlist(order);
  };

  const startDrag = (symbol: string, e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(symbol);
    setDragOrder([...symbols]);
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!dragging || !dragOrder) return;
    const others = dragOrder.filter((s) => s !== dragging && sameGroup(s, dragging));
    // Insert before the first same-group row whose middle is below the pointer.
    let before: string | null = null;
    for (const s of others) {
      const r = rowRefs.current.get(s)?.getBoundingClientRect();
      if (r && e.clientY < r.top + r.height / 2) {
        before = s;
        break;
      }
    }
    const without = dragOrder.filter((s) => s !== dragging);
    let at: number;
    if (before) at = without.indexOf(before);
    else {
      const lastSame = [...without].reverse().find((s) => sameGroup(s, dragging));
      at = lastSame ? without.indexOf(lastSame) + 1 : without.length;
    }
    const next = [...without.slice(0, at), dragging, ...without.slice(at)];
    if (next.join() !== dragOrder.join()) setDragOrder(next);
  };

  const endDrag = async () => {
    if (!dragging || !dragOrder) return;
    const order = dragOrder;
    const symbol = dragging;
    setDragging(null);
    if (order.join() !== symbols.join()) {
      const section = order.filter((s) => sameGroup(s, symbol));
      setAnnounce(t('moved', { symbol, position: section.indexOf(symbol) + 1, total: section.length }));
      await reorderWatchlist(order);
    }
    setDragOrder(null);
  };

  const inList = items.some((i) => i.symbol === current);
  const addCurrent = async () => {
    setBusy(true);
    try {
      await addToWatchlist(current);
    } finally {
      setBusy(false);
    }
  };

  const avgOf = (list: WatchlistItem[]) => {
    const p = list.map((i) => quotes.get(i.symbol)?.changePct).filter((x): x is number => typeof x === 'number');
    return p.length ? p.reduce((a, b) => a + b, 0) / p.length : null;
  };

  return (
    <section aria-labelledby="watchlist-title" className="rounded-xl border border-border bg-panel">
      <header className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 id="watchlist-title" className="text-sm font-semibold">
          {t('title')}
          {items.length > 0 && <span className="ml-1.5 font-normal text-muted">· {items.length}</span>}
        </h2>
        {data && !inList && (
          <button type="button" disabled={busy} onClick={addCurrent} className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-accent hover:bg-panel-2" aria-label={t('add', { symbol: current })}>
            <PlusIcon width={14} height={14} /> {t('addCurrent', { symbol: current })}
          </button>
        )}
      </header>

      {error ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={() => mutate()} />
        </div>
      ) : isLoading ? (
        <ul className="space-y-2 p-3">{Array.from({ length: 5 }, (_, i) => <li key={i}><Skeleton className="h-12" /></li>)}</ul>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-muted">{t('empty')}</p>
      ) : (
        <>
          {/* Summary + sort */}
          <div className="space-y-2 border-b border-border px-4 py-2">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums" aria-label={t('summaryLabel', { up: summary.up, down: summary.down, flat: summary.flat })}>
              <span className="text-up"><span aria-hidden>▲ </span>{summary.up}</span>
              <span className="text-down"><span aria-hidden>▼ </span>{summary.down}</span>
              <span className="text-muted"><span aria-hidden>■ </span>{summary.flat}</span>
              {summary.avg != null && (
                <span className="ml-auto font-sans text-muted">
                  {t('avg')} <span className={cx('font-mono', summary.avg > 0 ? 'text-up' : summary.avg < 0 ? 'text-down' : 'text-muted')}>{fmtSignedPct(summary.avg, lang)}</span>
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <label htmlFor="wl-sort" className="text-xs text-muted">{t('sortBy')}</label>
              <select
                id="wl-sort"
                value={sort}
                onChange={(e) => changeSort(e.target.value as SortKey)}
                className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-panel px-2 text-xs text-text focus:border-accent focus:outline-none"
              >
                {SORTS.map((s) => (
                  <option key={s} value={s}>{t(`sort.${s}`)}</option>
                ))}
              </select>
              {sort === 'manual' && (
                <button
                  type="button"
                  aria-pressed={editing}
                  onClick={() => setEditing((v) => !v)}
                  className={cx('min-h-11 shrink-0 rounded-md border px-2 text-xs', editing ? 'border-accent bg-accent/10 text-text' : 'border-border text-muted hover:text-text')}
                >
                  {editing ? t('doneOrder') : t('editOrder')}
                </button>
              )}
            </div>
            {editing && <p className="text-[11px] text-muted">{t('editHint')}</p>}
          </div>

          <p role="status" aria-live="polite" className="sr-only">{announce}</p>

          <div onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
            {sections.map((sec) => {
              const isCollapsed = collapsed.has(sec.key);
              const avg = avgOf(sec.items);
              return (
                <div key={sec.key}>
                  {grouped && (
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleGroup(sec.key)}
                      className="flex min-h-11 w-full items-center gap-2 border-b border-border bg-panel-2/60 px-4 text-left text-xs font-semibold"
                    >
                      <span aria-hidden className={cx('transition-transform', !isCollapsed && 'rotate-90')}>›</span>
                      <span className="min-w-0 flex-1 truncate">{sec.name ?? t('noGroup')}</span>
                      <span className="font-normal text-muted">{sec.items.length}</span>
                      {avg != null && <Change pct={avg} className="text-[11px]" />}
                    </button>
                  )}
                  {!isCollapsed && (
                    <ul className="divide-y divide-border">
                      {sec.items.map((i) => (
                        <Row
                          key={i.symbol}
                          item={i}
                          quote={quotes.get(i.symbol)}
                          closes={sparkMap.get(i.symbol)}
                          active={i.symbol === current}
                          editing={editing && sort === 'manual'}
                          dragging={dragging === i.symbol}
                          groups={groupNames}
                          menuOpen={menuFor === i.symbol}
                          onMenu={(open) => setMenuFor(open ? i.symbol : null)}
                          onNavigate={onNavigate}
                          onDragStart={(e) => startDrag(i.symbol, e)}
                          onMove={(dir) => moveBy(i.symbol, dir)}
                          rowRef={(el) => (el ? rowRefs.current.set(i.symbol, el) : rowRefs.current.delete(i.symbol))}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function Row({
  item,
  quote: q,
  closes,
  active,
  editing,
  dragging,
  groups,
  menuOpen,
  onMenu,
  onNavigate,
  onDragStart,
  onMove,
  rowRef,
}: {
  item: WatchlistItem;
  quote: Quote | undefined;
  closes: number[] | undefined;
  active: boolean;
  editing: boolean;
  dragging: boolean;
  groups: string[];
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onNavigate?: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  onMove: (dir: -1 | 1) => void;
  rowRef: (el: HTMLLIElement | null) => void;
}) {
  const t = useTranslations('watchlist');
  const lang = useLang();
  const symbol = item.symbol;
  return (
    <li ref={rowRef} data-symbol={symbol} className={cx('group relative flex items-center', active && 'bg-panel-2', dragging && 'z-10 bg-panel-2 shadow-lg ring-1 ring-accent')}>
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      {editing && (
        <button
          type="button"
          aria-label={t('reorder', { symbol })}
          aria-roledescription={t('reorderRole')}
          onPointerDown={onDragStart}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              onMove(e.key === 'ArrowUp' ? -1 : 1);
            }
          }}
          className="ml-1 inline-flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted hover:bg-panel hover:text-text active:cursor-grabbing"
        >
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
        </button>
      )}
      <Link
        href={`/stock/${encodeURIComponent(symbol)}`}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        className={cx('flex min-h-14 min-w-0 flex-1 items-center gap-2 py-2 pr-1 hover:bg-panel-2', editing ? 'pl-1' : 'pl-4')}
      >
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-sm font-semibold">{symbol}</span>
          <span className="block truncate text-xs text-muted">{q?.name ?? ' '}</span>
        </span>
        {!editing && <Sparkline closes={closes ?? []} livePrice={q?.price} />}
        <span className="flex w-[4.5rem] shrink-0 flex-col items-end">
          <span className="font-mono text-sm tabular-nums">{q ? fmtPrice(q.price, lang, q.currency) : '—'}</span>
          {q ? <Change pct={q.changePct} className="text-xs" /> : <span className="text-xs text-muted">—</span>}
        </span>
      </Link>
      <RowMenu symbol={symbol} group={item.group} groups={groups} open={menuOpen} onOpen={onMenu} />
    </li>
  );
}

/** ⋯ menu: move to a group (existing or new), or remove from the watchlist. */
function RowMenu({ symbol, group, groups, open, onOpen }: { symbol: string; group: string | null; groups: string[]; open: boolean; onOpen: (open: boolean) => void }) {
  const t = useTranslations('watchlist');
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpen]);

  const choose = async (g: string | null) => {
    onOpen(false);
    setName('');
    await setWatchlistGroup(symbol, g);
  };

  return (
    <div ref={ref} className="relative mr-1 shrink-0">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('actions', { symbol })}
        onClick={() => onOpen(!open)}
        className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel hover:text-text"
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && (
        <div role="dialog" aria-label={t('actions', { symbol })} className="absolute right-0 top-11 z-30 w-56 rounded-lg border border-border bg-panel p-2 text-sm shadow-2xl">
          <p className="px-2 pb-1 text-xs text-muted">{t('moveToGroup')}</p>
          <ul>
            {groups.map((g) => (
              <li key={g}>
                <button type="button" onClick={() => choose(g)} aria-pressed={group === g} className={cx('flex min-h-11 w-full items-center rounded-md px-2 text-left hover:bg-panel-2', group === g && 'font-semibold text-accent')}>
                  {group === g && <span aria-hidden className="mr-1">✓</span>}
                  {g}
                </button>
              </li>
            ))}
            {group && (
              <li>
                <button type="button" onClick={() => choose(null)} className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-muted hover:bg-panel-2">
                  {t('removeFromGroup')}
                </button>
              </li>
            )}
          </ul>
          <form
            className="mt-1 flex gap-1 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void choose(name.trim());
            }}
          >
            <label htmlFor={`grp-${symbol}`} className="sr-only">{t('newGroup')}</label>
            <input
              id={`grp-${symbol}`}
              value={name}
              maxLength={MAX_GROUP_NAME}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('newGroupPlaceholder')}
              className="h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button type="submit" disabled={!name.trim()} className="min-h-11 rounded-md bg-button px-3 text-xs font-medium text-white disabled:opacity-50">
              {t('addGroup')}
            </button>
          </form>
          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              onClick={() => {
                onOpen(false);
                void removeFromWatchlist(symbol);
              }}
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-down hover:bg-panel-2"
            >
              {t('remove', { symbol })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
