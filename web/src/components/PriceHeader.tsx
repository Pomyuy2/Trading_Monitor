'use client';

import type { Quote } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { ApiError, addToWatchlist, useWatchlist } from '@/lib/api';
import { direction, fmtPrice, fmtTime } from '@/lib/format';
import { useConnState } from '@/lib/live';
import { BellIcon, CheckIcon, CompareIcon, PlusIcon, XIcon } from './icons';
import { btn, Change, cx, ErrorState, Skeleton, SourceLine, useLang } from './ui';

interface Props {
  symbol: string;
  quote: Quote | undefined;
  error: unknown;
  streaming: boolean;
  onRetry: () => void;
  compare: string | null;
  onAlert: () => void;
  onCompare: () => void;
  onStopCompare: () => void;
}

export function PriceHeader({ symbol, quote, error, streaming, onRetry, compare, onAlert, onCompare, onStopCompare }: Props) {
  const t = useTranslations();
  const lang = useLang();

  if (error && !quote) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <section className="rounded-xl border border-border bg-panel p-4">
        <h1 className="font-mono text-2xl font-semibold">{symbol}</h1>
        <div className="mt-2">
          <ErrorState message={notFound ? t('price.notFound') : undefined} onRetry={notFound ? undefined : onRetry} />
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="price-title" className="rounded-xl border border-border bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 id="price-title" className="font-mono text-2xl font-semibold">{symbol}</h1>
            {quote ? (
              <span className="truncate text-sm text-muted">
                {quote.name}
                {quote.exchange && <> · {quote.exchange}</>}
                {' · '}
                {quote.currency}
              </span>
            ) : (
              <Skeleton className="h-4 w-40" />
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {quote ? (
              <>
                <FlashPrice price={quote.price} currency={quote.currency} />
                <Change value={quote.change} pct={quote.changePct} currency={quote.currency} size="lg" />
                <span className="text-xs text-muted">{t('price.today')}</span>
              </>
            ) : (
              <Skeleton className="h-10 w-64" />
            )}
          </div>
          <div className="mt-2 min-h-5">{quote && <StatusBadge quote={quote} streaming={streaming} />}</div>
        </div>

        <div className="flex flex-wrap gap-2">
          <WatchButton symbol={symbol} />
          <button type="button" className={btn.ghost} onClick={onAlert} disabled={!quote}>
            <BellIcon /> {t('price.setAlert')}
          </button>
          {compare ? (
            <button type="button" className={cx(btn.ghost, 'border-compare/60')} onClick={onStopCompare}>
              <XIcon /> {t('price.stopCompare', { symbol: compare })}
            </button>
          ) : (
            <button type="button" className={btn.primary} onClick={onCompare} disabled={!quote}>
              <CompareIcon /> {t('price.compare')}
            </button>
          )}
        </div>
      </div>
      {quote && (
        <div className="mt-3 border-t border-border pt-2">
          <SourceLine meta={quote.meta} />
        </div>
      )}
    </section>
  );
}

function FlashPrice({ price, currency }: { price: number | null; currency: string }) {
  const lang = useLang();
  const prev = useRef(price);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down'; key: number } | null>(null);
  useEffect(() => {
    if (price != null && prev.current != null && price !== prev.current) {
      setFlash({ dir: direction(price - prev.current) === 'up' ? 'up' : 'down', key: Date.now() });
    }
    prev.current = price;
  }, [price]);
  return (
    <span key={flash?.key} className={cx('rounded px-1 -mx-1 font-mono text-4xl font-semibold tabular-nums', flash && `flash-${flash.dir}`)} aria-live="off">
      {fmtPrice(price, lang, currency)}
    </span>
  );
}

function StatusBadge({ quote, streaming }: { quote: Quote; streaming: boolean }) {
  const t = useTranslations('price');
  const lang = useLang();
  const conn = useConnState();
  const time = fmtTime(quote.ts, lang);

  if (quote.marketState === 'closed') {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted">
        <span aria-hidden className="size-2 rounded-full bg-muted" />
        {t('closed')}
      </span>
    );
  }
  if (streaming && conn !== 'open') {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-warn" role="status">
        <span aria-hidden className="size-2 rounded-full bg-warn" />
        {t('reconnecting')}
      </span>
    );
  }
  if (quote.delayed) {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="rounded border border-warn/60 px-1.5 py-0.5 font-medium text-warn">{t('delayed')}</span>
        <span className="font-mono text-muted">{t('updated', { time })}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span aria-hidden className="live-dot size-2 rounded-full bg-up" />
      <span className="font-medium text-up">{t('live')}</span>
      {(quote.marketState === 'pre' || quote.marketState === 'post') && (
        <span className="rounded border border-border px-1.5 py-0.5 text-muted">{t(quote.marketState === 'pre' ? 'preMarket' : 'afterHours')}</span>
      )}
      <span className="text-muted">·</span>
      <span className="font-mono text-muted">{t('updated', { time })}</span>
    </span>
  );
}

function WatchButton({ symbol }: { symbol: string }) {
  const t = useTranslations('watchlist');
  const { data } = useWatchlist();
  const [busy, setBusy] = useState(false);
  const inList = data?.some((i) => i.symbol === symbol);
  if (!data) return null;
  if (inList) {
    return (
      <span className="inline-flex min-h-11 items-center gap-2 px-2 text-sm text-muted">
        <CheckIcon /> {t('inList')}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={btn.ghost}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await addToWatchlist(symbol);
        } finally {
          setBusy(false);
        }
      }}
    >
      <PlusIcon /> {t('addCurrent', { symbol })}
    </button>
  );
}
