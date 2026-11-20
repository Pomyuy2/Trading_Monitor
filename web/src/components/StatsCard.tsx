'use client';

import type { Quote } from '@tm/shared';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { fmtCompact, fmtNumber, fmtPct, fmtPrice } from '@/lib/format';
import { Card, Missing, Skeleton, SourceLine, useLang } from './ui';

export function StatsCard({ quote }: { quote: Quote | undefined }) {
  const t = useTranslations('stats');
  const lang = useLang();
  const cur = quote?.currency ?? 'USD';
  const p = (n: number | null | undefined) => (n == null ? null : fmtPrice(n, lang, cur));

  const rows: { label: string; value: ReactNode | null }[] = quote
    ? [
        { label: t('open'), value: p(quote.open) },
        { label: t('dayRange'), value: quote.high != null && quote.low != null ? `${p(quote.high)} / ${p(quote.low)}` : null },
        { label: t('prevClose'), value: p(quote.prevClose) },
        { label: t('volume'), value: quote.volume != null ? fmtCompact(quote.volume, lang) : null },
        { label: t('avgVolume'), value: quote.avgVolume != null ? fmtCompact(quote.avgVolume, lang) : null },
        { label: t('marketCap'), value: quote.marketCap != null ? fmtCompact(quote.marketCap, lang, cur) : null },
        { label: t('pe'), value: quote.peTTM != null ? fmtNumber(quote.peTTM, lang) : null },
        {
          label: t('week52'),
          value:
            quote.week52Low != null && quote.week52High != null ? (
              <RangeBar low={quote.week52Low} high={quote.week52High} value={quote.price} format={(n) => p(n) ?? ''} />
            ) : null,
        },
        { label: t('dividendYield'), value: quote.dividendYield != null ? fmtPct(quote.dividendYield, lang) : null },
      ]
    : [];

  return (
    <Card id="stats" title={t('title')} footer={<SourceLine meta={quote?.meta} />}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-5">
        {quote
          ? rows.map((r) => (
              <div key={r.label} className="min-w-0">
                <dt className="text-xs text-muted">{r.label}</dt>
                <dd className="mt-1 font-mono text-sm tabular-nums">{r.value ?? <Missing />}</dd>
              </div>
            ))
          : Array.from({ length: 9 }, (_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-4 w-24" />
              </div>
            ))}
      </dl>
    </Card>
  );
}

function RangeBar({ low, high, value, format }: { low: number; high: number; value: number | null; format: (n: number) => string }) {
  const pos = value != null && high > low ? Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100)) : null;
  return (
    <span className="block">
      <span className="flex justify-between gap-2 text-xs">
        <span>{format(low)}</span>
        <span>{format(high)}</span>
      </span>
      <span aria-hidden className="relative mt-1.5 block h-1 rounded bg-border">
        {pos != null && <span className="absolute -top-1 size-3 -translate-x-1/2 rounded-full border-2 border-panel bg-accent" style={{ left: `${pos}%` }} />}
      </span>
    </span>
  );
}
