'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { addToWatchlist, removeFromWatchlist, useWatchlist } from '@/lib/api';
import { fmtPrice } from '@/lib/format';
import { useLiveQuote } from '@/lib/use-live-quote';
import { PlusIcon, XIcon } from './icons';
import { Change, cx, ErrorState, Skeleton, useLang } from './ui';

export function Watchlist({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  const t = useTranslations('watchlist');
  const { data, error, isLoading, mutate } = useWatchlist();
  const [busy, setBusy] = useState(false);
  const inList = data?.some((i) => i.symbol === current);

  const addCurrent = async () => {
    setBusy(true);
    try {
      await addToWatchlist(current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="watchlist-title" className="rounded-xl border border-border bg-panel">
      <header className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 id="watchlist-title" className="text-sm font-semibold">
          {t('title')}
        </h2>
        {data && !inList && (
          <button type="button" disabled={busy} onClick={addCurrent} className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium text-accent hover:bg-panel-2" aria-label={t('add', { symbol: current })}>
            <PlusIcon width={14} height={14} /> {t('addCurrent', { symbol: current })}
          </button>
        )}
      </header>
      {error ? (
        <div className="p-4">
          <ErrorState onRetry={() => mutate()} />
        </div>
      ) : isLoading ? (
        <ul className="space-y-2 p-3">{Array.from({ length: 5 }, (_, i) => <li key={i}><Skeleton className="h-12" /></li>)}</ul>
      ) : data && data.length === 0 ? (
        <p className="p-4 text-sm text-muted">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data?.map((i) => <Row key={i.symbol} symbol={i.symbol} active={i.symbol === current} onNavigate={onNavigate} />)}
        </ul>
      )}
    </section>
  );
}

function Row({ symbol, active, onNavigate }: { symbol: string; active: boolean; onNavigate?: () => void }) {
  const t = useTranslations('watchlist');
  const lang = useLang();
  const { data: q } = useLiveQuote(symbol);
  return (
    <li className={cx('group relative flex items-center', active && 'bg-panel-2')}>
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <Link
        href={`/stock/${encodeURIComponent(symbol)}`}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-2 py-2 pl-4 pr-1 hover:bg-panel-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-sm font-semibold">{symbol}</span>
          <span className="block truncate text-xs text-muted">{q?.name ?? ' '}</span>
        </span>
        <span className="flex flex-col items-end">
          <span className="font-mono text-sm tabular-nums">{q ? fmtPrice(q.price, lang, q.currency) : '—'}</span>
          {q ? <Change pct={q.changePct} className="text-xs" /> : <span className="text-xs text-muted">—</span>}
        </span>
      </Link>
      <button
        type="button"
        onClick={() => removeFromWatchlist(symbol)}
        aria-label={t('remove', { symbol })}
        className="mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted opacity-70 hover:bg-panel hover:text-down group-hover:opacity-100 focus-visible:opacity-100"
      >
        <XIcon width={16} height={16} />
      </button>
    </li>
  );
}
