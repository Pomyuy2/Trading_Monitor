'use client';

import { RANGES, type Quote, type Range } from '@tm/shared';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { useCandles, useEvents, useLevels } from '@/lib/api';
import { fmtSignedPct } from '@/lib/format';
import { useTheme } from '@/lib/prefs';
import { XIcon } from './icons';
import type { Zone } from './level-zones';
import type { ChartLine, ChartType, CompareSeries } from './PriceChart';
import { Change, cx, ErrorState, Skeleton, SourceLine, useLang } from './ui';

const PriceChart = dynamic(() => import('./PriceChart').then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <Skeleton className="chart-h w-full" />,
});

interface Props {
  symbol: string;
  range: Range;
  onRange: (r: Range) => void;
  quote: Quote | undefined;
  streaming: boolean;
  compares: string[];
  onRemoveCompare: (s: string) => void;
  showLevels: boolean;
  showPivots: boolean;
  onToggleLevels: () => void;
  onTogglePivots: () => void;
}

const STRENGTH_ALPHA = { weak: 0.07, medium: 0.14, strong: 0.24 } as const;

/** Theme colors the chart needs from CSS variables (client only). */
function cssColors(theme: string) {
  void theme; // re-read when the theme changes
  if (typeof window === 'undefined') return { support: '76,141,255', resist: '242,153,74', pivot: '#9aa4b2', cmp: ['#f5c45e', '#c4a1ff'] };
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    support: v('--chart-support-rgb').replace(/\s/g, ''),
    resist: v('--chart-resist-rgb').replace(/\s/g, ''),
    pivot: v('--color-muted'),
    cmp: [v('--color-compare'), v('--color-compare-2')],
  };
}

export function ChartCard({ symbol, range, onRange, quote, streaming, compares, onRemoveCompare, showLevels, showPivots, onToggleLevels, onTogglePivots }: Props) {
  const t = useTranslations('chart');
  const lang = useLang();
  const theme = useTheme();
  const [type, setType] = useState<ChartType>('line');
  const { data, error, isLoading, isValidating, mutate } = useCandles(symbol, range);
  const c1 = useCandles(compares[0] ?? null, range);
  const c2 = useCandles(compares[1] ?? null, range);
  const lv = useLevels(symbol, range);
  const ev = useEvents(symbol);
  const levels = lv.data && lv.data.symbol === symbol && lv.data.range === range ? lv.data : undefined;
  const colors = useMemo(() => cssColors(theme), [theme]);

  // keepPreviousData may hand back another symbol's series briefly; ignore it.
  const series = data && data.symbol === symbol ? data : undefined;
  const candles = series?.candles ?? [];
  const compareSeries = useMemo<CompareSeries[]>(
    () =>
      [c1.data, c2.data]
        .map((d, i) => (d && d.symbol === compares[i] && d.range === range ? { symbol: d.symbol, candles: d.candles, color: colors.cmp[i] } : null))
        .filter((x): x is CompareSeries => !!x),
    [c1.data, c2.data, compares, range, colors],
  );
  const comparing = compares.length > 0;

  // Change over range → latest official price (live-merged). 1D from the previous close; other ranges from the first candle.
  const first = range === '1D' && quote?.prevClose != null ? quote.prevClose : (candles[0]?.open ?? null);
  const lastPrice = quote?.price ?? candles[candles.length - 1]?.close ?? null;
  const change = first != null && lastPrice != null ? lastPrice - first : null;
  const changePct = change != null && first ? (change / first) * 100 : null;
  // Compare mode: every line uses the chart's % baseline — the first candle's close in the range.
  const pctFrom = (bars: { time: number; close: number }[]) => {
    const c = bars.filter((k) => k.time >= (candles[0]?.time ?? 0));
    return c.length < 2 ? null : ((c[c.length - 1].close - c[0].close) / c[0].close) * 100;
  };
  const pctOf = (cs: CompareSeries) => pctFrom(cs.candles);

  // Levels / pivots are hidden while comparing (the chart is on a % scale then).
  const zones = useMemo<Zone[]>(() => {
    if (!showLevels || !levels || comparing) return [];
    return [...levels.supports, ...levels.resistances].map((l) => ({
      low: l.zoneLow,
      high: l.zoneHigh,
      rgb: l.kind === 'support' ? colors.support : colors.resist,
      alpha: STRENGTH_ALPHA[l.strength],
    }));
  }, [showLevels, levels, comparing, colors]);
  const lines = useMemo<ChartLine[]>(() => {
    if (!showPivots || !levels?.pivots || comparing) return [];
    const p = levels.pivots;
    return (['R2', 'R1', 'P', 'S1', 'S2'] as const).map((k) => ({ price: p[k], title: k, color: colors.pivot, dashed: true }));
  }, [showPivots, levels, comparing, colors]);
  const events = ev.data && ev.data.symbol === symbol ? ev.data : null;

  const rangeName = t(`rangeNames.${range}`);
  const ariaLabel = `${t('label', { symbol })} · ${rangeName} · ${fmtSignedPct(changePct, lang)}`;

  return (
    <section aria-label={t('label', { symbol })} className="flex flex-col rounded-xl border border-border bg-panel">
      {/* On phones the range buttons sit under the chart (order-2); on desktop they are the toolbar on top. */}
      <div className="order-2 flex flex-wrap items-center justify-between gap-2 border-t border-border px-2 py-2 lg:order-none lg:border-b lg:border-t-0 lg:px-4">
        <div role="group" aria-label={t('rangesLabel')} className="flex w-full gap-1 overflow-x-auto lg:w-auto">
          {RANGES.map((r, i) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              aria-label={t(`rangeNames.${r}`)}
              aria-keyshortcuts={String(i + 1)}
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
              disabled={comparing && k === 'candles'}
              className={cx('min-h-10 rounded px-3 text-xs font-medium disabled:opacity-40', type === k ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}
            >
              {t(k)}
            </button>
          ))}
        </div>
      </div>

      <div className="order-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 lg:order-none">
        <span className="text-xs text-muted">{t('changeOver', { range: rangeName })}</span>
        {series ? <Change value={change} pct={changePct} currency={quote?.currency ?? 'USD'} /> : <Skeleton className="h-4 w-32" />}
        <span className="ml-auto flex items-center gap-3">
          {series && <span className="hidden text-xs text-muted sm:inline">{t('candleSize', { size: t(`sizes.${series.resolution}`) })}</span>}
          <span role="group" aria-label={t('overlays')} className="flex gap-1">
            <OverlayToggle on={showLevels} onClick={onToggleLevels} disabled={comparing} title={`${t('levelsHint')} (L)`} swatch="levels" shortcut="L">
              {t('levels')}
            </OverlayToggle>
            <OverlayToggle on={showPivots} onClick={onTogglePivots} disabled={comparing} title={`${t('levelsHint')} (P)`} swatch="pivots" shortcut="P">
              {t('pivots')}
            </OverlayToggle>
          </span>
        </span>
      </div>

      {comparing && (
        <ul aria-label={t('compareLegend')} className="order-0 flex flex-wrap items-center gap-2 px-4 pt-2 text-xs lg:order-none">
          <li className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border px-2.5">
            <span aria-hidden className="h-0.5 w-4 rounded bg-accent" />
            <span className="font-mono font-semibold">{symbol}</span>
            <Change pct={pctFrom(candles)} className="text-xs" />
          </li>
          {compares.map((s, i) => {
            const cs = compareSeries.find((x) => x.symbol === s);
            return (
              <li key={s} className="inline-flex items-center gap-1.5 rounded-full border border-border pl-2.5">
                <span aria-hidden className="h-0.5 w-4 rounded" style={{ background: colors.cmp[i] }} />
                <span className="font-mono font-semibold">{s}</span>
                {cs ? <Change pct={pctOf(cs)} className="text-xs" /> : <Skeleton className="h-3 w-12" />}
                <button
                  type="button"
                  onClick={() => onRemoveCompare(s)}
                  aria-label={t('removeCompare', { symbol: s })}
                  className="inline-flex size-11 items-center justify-center rounded-full text-muted hover:text-down"
                >
                  <XIcon width={14} height={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="relative order-1 px-1 pt-2 lg:order-none">
        {error && !series ? (
          <div className="grid h-[320px] place-items-center"><ErrorState error={error} onRetry={() => mutate()} /></div>
        ) : !series && isLoading ? (
          <Skeleton className="chart-h mx-3" />
        ) : series && candles.length === 0 ? (
          <p className="grid h-[320px] place-items-center text-sm text-muted">{t('noData')}</p>
        ) : series ? (
          <PriceChart
            symbol={symbol}
            candles={candles}
            resolution={series.resolution}
            type={type}
            live={streaming && quote?.marketState === 'open'}
            compares={compareSeries}
            zones={zones}
            lines={lines}
            events={events}
            theme={theme}
            currency={quote?.currency ?? 'USD'}
            ariaLabel={ariaLabel}
          />
        ) : null}
        {isValidating && series && series.range !== range && (
          <div aria-hidden className="absolute inset-x-4 top-2 h-0.5 overflow-hidden rounded bg-panel-2"><div className="skeleton h-full w-full" /></div>
        )}
      </div>

      <div className="order-3 flex flex-wrap items-center gap-x-4 px-4 pb-3 pt-1 lg:order-none">
        <SourceLine meta={series?.meta} />
        {events && (events.earnings.length > 0 || events.dividends.length > 0) && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <span className="inline-grid size-4 place-items-center rounded-full bg-accent text-[10px] font-bold text-panel" aria-hidden>E</span>
            {t('events.earnings')}
            <span className="inline-grid size-4 place-items-center rounded-sm bg-up text-[10px] font-bold text-panel" aria-hidden>D</span>
            {t('events.dividend')}
            <span>· {[...new Set([events.meta.earnings?.source, events.meta.dividends?.source].filter(Boolean))].join(', ')}</span>
          </p>
        )}
      </div>
    </section>
  );
}

function OverlayToggle({ on, onClick, disabled, title, swatch, shortcut, children }: { on: boolean; onClick: () => void; disabled?: boolean; title: string; swatch: 'levels' | 'pivots'; shortcut: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        'inline-flex min-h-11 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium disabled:opacity-40',
        on ? 'border-accent/60 bg-accent/10 text-text' : 'border-border text-muted hover:text-text',
      )}
    >
      {swatch === 'levels' ? (
        <span aria-hidden className="flex flex-col gap-0.5">
          <span className="h-1 w-3 rounded-sm bg-resist/70" />
          <span className="h-1 w-3 rounded-sm bg-accent/70" />
        </span>
      ) : (
        <span aria-hidden className="w-3 border-t border-dotted border-muted" />
      )}
      {children}
    </button>
  );
}
