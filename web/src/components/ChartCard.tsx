'use client';

import { RANGES, type Quote, type Range } from '@tm/shared';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { useCandles } from '@/lib/api';
import { fmtSignedPct } from '@/lib/format';
import type { ChartType } from './PriceChart';
import { Change, cx, ErrorState, Skeleton, SourceLine, useLang } from './ui';

const PriceChart = dynamic(() => import('./PriceChart').then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[320px] w-full sm:h-[380px] xl:h-[420px]" />,
});

interface Props {
  symbol: string;
  range: Range;
  onRange: (r: Range) => void;
  quote: Quote | undefined;
  streaming: boolean;
  compare: string | null;
}

export function ChartCard({ symbol, range, onRange, quote, streaming, compare }: Props) {
  const t = useTranslations('chart');
  const lang = useLang();
  const [type, setType] = useState<ChartType>('line');
  const { data, error, isLoading, isValidating, mutate } = useCandles(symbol, range);
  const cmp = useCandles(compare, range);

  // keepPreviousData may hand back another symbol's series briefly; ignore it.
  const series = data && data.symbol === symbol ? data : undefined;
  const candles = series?.candles ?? [];
  const compareData = useMemo(
    () => (compare && cmp.data && cmp.data.symbol === compare && cmp.data.range === range ? { symbol: compare, candles: cmp.data.candles } : null),
    [compare, cmp.data, range],
  );

  // Change over range → latest official price from the quote (live-merged), falling back to the last close.
  // 1D is measured from the previous close (matches the header's "Today"); other ranges from the first candle.
  const first = range === '1D' && quote?.prevClose != null ? quote.prevClose : (candles[0]?.open ?? null);
  const lastPrice = quote?.price ?? candles[candles.length - 1]?.close ?? null;
  const change = first != null && lastPrice != null ? lastPrice - first : null;
  const changePct = change != null && first ? (change / first) * 100 : null;

  const cmpPct = useMemo(() => {
    const c = compareData?.candles.filter((k) => k.time >= (candles[0]?.time ?? 0));
    if (!c || c.length < 2) return null;
    return ((c[c.length - 1].close - c[0].open) / c[0].open) * 100;
  }, [compareData, candles]);

  const rangeName = t(`rangeNames.${range}`);
  const ariaLabel = `${t('label', { symbol })} · ${rangeName} · ${fmtSignedPct(changePct, lang)}`;

  return (
    <section aria-label={t('label', { symbol })} className="flex flex-col rounded-xl border border-border bg-panel">
      {/* On phones the range buttons sit under the chart (order-2); on desktop they are the toolbar on top. */}
      <div className="order-2 flex flex-wrap items-center justify-between gap-2 border-t border-border px-2 py-2 lg:order-none lg:border-b lg:border-t-0 lg:px-4">
        <div role="group" aria-label={t('rangesLabel')} className="flex w-full gap-1 overflow-x-auto lg:w-auto">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              aria-label={t(`rangeNames.${r}`)}
              onClick={() => onRange(r)}
              className={cx(
                'min-h-11 min-w-11 flex-1 rounded-md px-2 text-sm font-medium whitespace-nowrap lg:flex-none lg:px-3',
                r === range ? 'bg-button text-white' : 'text-muted hover:bg-panel-2 hover:text-text',
              )}
            >
              {t(`ranges.${r}`)}
            </button>
          ))}
        </div>
        <div role="group" aria-label={t('chartType')} className="hidden rounded-md border border-border p-0.5 lg:flex">
          {(['line', 'candles'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={type === k}
              onClick={() => setType(k)}
              disabled={!!compareData && k === 'candles'}
              className={cx('min-h-10 rounded px-3 text-xs font-medium disabled:opacity-40', type === k ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}
            >
              {t(k)}
            </button>
          ))}
        </div>
      </div>

      <div className="order-0 flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pt-3 lg:order-none">
        <span className="text-xs text-muted">{t('changeOver', { range: rangeName })}</span>
        {series ? <Change value={change} pct={changePct} currency={quote?.currency ?? 'USD'} /> : <Skeleton className="h-4 w-32" />}
        {compareData && (
          <span className="flex items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 bg-accent" />{symbol} <Change pct={changePct} className="text-xs" /></span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 bg-compare" />{compare} <Change pct={cmpPct} className="text-xs" /></span>
          </span>
        )}
        {series && <span className="ml-auto text-xs text-muted">{t('candleSize', { size: t(`sizes.${series.resolution}`) })}</span>}
      </div>

      <div className="relative order-1 px-1 pt-2 lg:order-none">
        {error && !series ? (
          <div className="grid h-[320px] place-items-center"><ErrorState onRetry={() => mutate()} /></div>
        ) : !series && isLoading ? (
          <Skeleton className="mx-3 h-[320px] sm:h-[380px] xl:h-[420px]" />
        ) : series && candles.length === 0 ? (
          <p className="grid h-[320px] place-items-center text-sm text-muted">{t('noData')}</p>
        ) : series ? (
          <PriceChart
            symbol={symbol}
            candles={candles}
            resolution={series.resolution}
            type={type}
            live={streaming && quote?.marketState === 'open'}
            compare={compareData}
            ariaLabel={ariaLabel}
          />
        ) : null}
        {isValidating && series && series.range !== range && (
          <div aria-hidden className="absolute inset-x-4 top-2 h-0.5 overflow-hidden rounded bg-panel-2"><div className="skeleton h-full w-full" /></div>
        )}
      </div>

      <div className="order-3 px-4 pb-3 pt-1 lg:order-none">
        <SourceLine meta={series?.meta} />
      </div>
    </section>
  );
}
