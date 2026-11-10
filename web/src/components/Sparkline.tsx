'use client';

import { useTranslations } from 'next-intl';
import { fmtSignedPct } from '@/lib/format';
import { cx, useLang } from './ui';

/**
 * Tiny trend line: ~1 month of daily closes, with today's point following the live price.
 * Colour follows the direction, and the label states it, so it isn't shown by colour alone.
 */
export function Sparkline({ closes, livePrice, width = 52, height = 24 }: { closes: number[]; livePrice?: number | null; width?: number; height?: number }) {
  const t = useTranslations('watchlist');
  const lang = useLang();
  const values = livePrice != null && closes.length ? [...closes.slice(0, -1), livePrice] : closes;
  if (values.length < 2) return <span aria-hidden className="inline-block" style={{ width, height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const pts = values
    .map((v, i) => `${(pad + (i / (values.length - 1)) * (width - pad * 2)).toFixed(1)},${(pad + (1 - (v - min) / span) * (height - pad * 2)).toFixed(1)}`)
    .join(' ');
  const pct = ((values[values.length - 1] - values[0]) / values[0]) * 100;
  const up = pct >= 0;
  const [lx, ly] = pts.split(' ').at(-1)!.split(',');
  return (
    <svg
      role="img"
      aria-label={t('trend', { change: fmtSignedPct(pct, lang) })}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cx('shrink-0', up ? 'text-up' : 'text-down')}
    >
      <title>{t('trend', { change: fmtSignedPct(pct, lang) })}</title>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={1.8} fill="currentColor" />
    </svg>
  );
}
