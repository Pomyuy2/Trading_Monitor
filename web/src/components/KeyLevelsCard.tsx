'use client';

import type { LevelStrength, PriceLevel, Quote, Range } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { useLevels } from '@/lib/api';
import { fmtDate, fmtIsoDate, fmtNumber, fmtPrice, fmtSignedPct } from '@/lib/format';
import { Card, cx, ErrorState, Missing, Skeleton, SourceLine, useLang } from './ui';

const KIND_TEXT = { support: 'text-accent', resistance: 'text-[#F2994A]' } as const;
const KIND_BAR = { support: 'bg-accent', resistance: 'bg-[#F2994A]' } as const;
const DOTS: Record<LevelStrength, number> = { weak: 1, medium: 2, strong: 3 };

/** Nearest supports / resistances for the selected range. Descriptive only — no buy/sell wording. */
export function KeyLevelsCard({ symbol, range, quote }: { symbol: string; range: Range; quote: Quote | undefined }) {
  const t = useTranslations('levels');
  const tc = useTranslations('chart');
  const lang = useLang();
  const hintId = useId();
  const { data, error, isLoading, mutate } = useLevels(symbol, range);
  const lv = data && data.symbol === symbol && data.range === range ? data : undefined;

  const cur = quote?.currency ?? 'USD';
  const price = quote?.price ?? lv?.price ?? null;
  const resistances = (lv?.resistances ?? []).filter((l) => price == null || l.price > price).slice(0, 2);
  const supports = (lv?.supports ?? []).filter((l) => price == null || l.price < price).slice(0, 2);
  const intraday = lv ? !['1day', '1week'].includes(lv.resolution) : true;

  return (
    <Card
      id="levels"
      title={t('title')}
      actions={
        <span
          className="inline-flex size-11 items-center justify-center rounded-md text-muted"
          title={t('disclaimer')}
          aria-describedby={hintId}
        >
          <span aria-hidden className="grid size-5 place-items-center rounded-full border border-muted text-[11px] font-semibold">i</span>
          <span className="sr-only">{t('aboutLevels')}</span>
        </span>
      }
      footer={
        <div className="space-y-1">
          <SourceLine meta={lv?.meta} />
          <p id={hintId} className="text-[11px] text-muted">{t('disclaimer')}</p>
        </div>
      }
    >
      {error && !lv ? (
        <ErrorState onRetry={() => mutate()} />
      ) : isLoading || !lv ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {t('basis', { range: tc(`rangeNames.${range}`), size: tc(`sizes.${lv.resolution}`), count: lv.candleCount })}
          </p>

          <ol className="space-y-1.5" aria-label={t('ladder')}>
            {resistances.length === 0 && <li><Missing inline note={t('noResistance')} /></li>}
            {[...resistances].reverse().map((l, i) => (
              <LevelRow key={`r${l.price}`} level={l} label={`R${resistances.length - i}`} price={price} currency={cur} intraday={intraday} />
            ))}
            <li className="flex items-center gap-2 py-1" aria-label={t('currentPrice')}>
              <span className="h-px flex-1 bg-text/40" aria-hidden />
              <span className="font-mono text-xs text-text">
                {t('current')} {fmtPrice(price, lang, cur)}
              </span>
              <span className="h-px flex-1 bg-text/40" aria-hidden />
            </li>
            {supports.map((l, i) => (
              <LevelRow key={`s${l.price}`} level={l} label={`S${i + 1}`} price={price} currency={cur} intraday={intraday} />
            ))}
            {supports.length === 0 && <li><Missing inline note={t('noSupport')} /></li>}
          </ol>

          <div className="border-t border-border pt-3">
            <h3 className="text-xs text-muted">
              {t('pivots')}
              {lv.pivots && <> · {t('pivotsFrom', { date: fmtIsoDate(lv.pivots.sessionDate, lang) })}</>}
            </h3>
            {lv.pivots ? (
              <dl className="mt-2 grid grid-cols-5 gap-1 text-center">
                {(['S2', 'S1', 'P', 'R1', 'R2'] as const).map((k) => (
                  <div key={k} className="rounded bg-panel-2 px-1 py-1.5">
                    <dt className="text-[11px] text-muted">{k}</dt>
                    <dd className="font-mono text-xs tabular-nums">{fmtNumber(lv.pivots![k], lang)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="mt-1"><Missing /></div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function LevelRow({ level, label, price, currency, intraday }: { level: PriceLevel; label: string; price: number | null; currency: string; intraday: boolean }) {
  const t = useTranslations('levels');
  const lang = useLang();
  const dist = price ? ((level.price - price) / price) * 100 : null;
  const touched = intraday
    ? fmtDate(level.lastTouched, lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : fmtDate(level.lastTouched, lang, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <li className="relative rounded-md bg-panel-2 py-2 pl-3 pr-2">
      <span aria-hidden className={cx('absolute inset-y-1 left-0 w-1 rounded', KIND_BAR[level.kind])} style={{ opacity: 0.35 + DOTS[level.strength] * 0.2 }} />
      <div className="flex items-baseline gap-2">
        <span className={cx('w-7 font-mono text-xs font-semibold', KIND_TEXT[level.kind])}>{label}</span>
        <span className="text-xs text-muted">{t(level.kind)}</span>
        <span className="ml-auto font-mono text-sm tabular-nums">{fmtPrice(level.price, lang, currency)}</span>
        <span className="w-[4.75rem] shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums text-muted" title={t('distance')}>
          <span aria-hidden>{dist != null && dist > 0 ? '▲' : '▼'}</span> {fmtSignedPct(dist, lang)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-9 text-[11px] text-muted">
        <span className="font-mono">
          {fmtNumber(level.zoneLow, lang)}–{fmtNumber(level.zoneHigh, lang)}
        </span>
        <span aria-hidden>·</span>
        <span>{t('touches', { count: level.touches })}</span>
        <span aria-hidden>·</span>
        <span>{t('lastTouched', { date: touched })}</span>
        <span className="ml-auto inline-flex items-center gap-1" title={t(`strength.${level.strength}`)}>
          <span aria-hidden className="tracking-tighter">{'●'.repeat(DOTS[level.strength])}{'○'.repeat(3 - DOTS[level.strength])}</span>
          {t(`strength.${level.strength}`)}
        </span>
      </div>
    </li>
  );
}
