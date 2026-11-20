'use client';

import { marketStatus, type MarketStatus } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { intlLocale } from '@/lib/format';
import { cx, useLang } from './ui';

/** "Open · closes in 2h 15m" etc. US hours, holidays and DST from shared/market-hours; times in the viewer's zone. */
export function MarketStatusBar() {
  const t = useTranslations('status');
  const lang = useLang();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const h = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(h);
  }, []);

  if (now == null) return <div className="h-9 border-b border-border bg-panel" aria-hidden />;
  const s = marketStatus(now);
  const loc = intlLocale(lang);
  const tz = new Intl.DateTimeFormat(loc, { timeZoneName: 'short' }).formatToParts(new Date(now)).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const sameDay = (ms: number) => new Date(ms).toDateString() === new Date(now).toDateString();
  const at = (ms: number) =>
    new Intl.DateTimeFormat(loc, sameDay(ms) ? { hour: '2-digit', minute: '2-digit', hour12: false } : { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const dur = (ms: number) => duration(ms - now, lang);

  const text = describe(s, t, dur, at);
  const dot = s.phase === 'open' ? 'bg-up live-dot' : s.phase === 'closed' ? 'bg-muted' : 'bg-warn';
  return (
    <div className="border-b border-border bg-panel">
      <p role="status" className="page-width flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2 text-xs">
        <span aria-hidden className={cx('size-2 shrink-0 rounded-full', dot)} />
        <span className="font-medium text-text">{t('label')}:</span>
        <span className="text-text">{text}</span>
        {s.today?.earlyClose && s.phase !== 'closed' && <span className="rounded border border-warn/50 px-1.5 text-warn">{t('earlyClose')}</span>}
        {s.holiday && <span className="rounded border border-border px-1.5 text-muted">{t('holiday', { name: t(`holidays.${s.holiday}`) })}</span>}
        <span className="ml-auto text-muted">{t('yourTime', { tz })}</span>
      </p>
    </div>
  );
}

function describe(s: MarketStatus, t: ReturnType<typeof useTranslations<'status'>>, dur: (ms: number) => string, at: (ms: number) => string): string {
  switch (s.phase) {
    case 'open':
      return t('open', { in: dur(s.phaseEnds!), time: at(s.phaseEnds!) });
    case 'pre':
      return t('pre', { in: dur(s.nextOpen), time: at(s.nextOpen) });
    case 'post':
      return t('post', { in: dur(s.phaseEnds!), next: at(s.nextOpen) });
    default:
      return t('closed', { in: dur(s.nextOpen), time: at(s.nextOpen) });
  }
}

/** "2h 15m", "45m", "1d 3h" (EN) / "2 ชม. 15 นาที" (TH). Rounds up to the minute. */
export function duration(ms: number, lang: 'en' | 'th'): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (lang === 'th') {
    if (d) return `${d} วัน${h ? ` ${h} ชม.` : ''}`;
    if (h) return `${h} ชม.${m ? ` ${m} นาที` : ''}`;
    return `${m} นาที`;
  }
  if (d) return `${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `${h}h${m ? ` ${m}m` : ''}`;
  return `${m}m`;
}
