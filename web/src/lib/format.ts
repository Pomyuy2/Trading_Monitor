import type { Lang } from '@tm/shared';

/** Thai uses the Gregorian calendar so years stay Western (2027, not 2570). */
export function intlLocale(lang: Lang): string {
  return lang === 'th' ? 'th-TH-u-ca-gregory' : 'en-US';
}

export const DASH = '—';

const ok = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function fmtNumber(n: number | null | undefined, lang: Lang, digits = 2): string {
  if (!ok(n)) return DASH;
  return new Intl.NumberFormat(intlLocale(lang), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function fmtPrice(n: number | null | undefined, lang: Lang, currency = 'USD'): string {
  if (!ok(n)) return DASH;
  return new Intl.NumberFormat(intlLocale(lang), { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/** Always shows a sign: +1.23 / −1.23 (true minus sign). */
export function fmtSigned(n: number | null | undefined, lang: Lang, opts: { currency?: string; digits?: number } = {}): string {
  if (!ok(n)) return DASH;
  const abs = Math.abs(n);
  const body = opts.currency
    ? new Intl.NumberFormat(intlLocale(lang), { style: 'currency', currency: opts.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs)
    : new Intl.NumberFormat(intlLocale(lang), { minimumFractionDigits: opts.digits ?? 2, maximumFractionDigits: opts.digits ?? 2 }).format(abs);
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${body}`;
}

export function fmtSignedPct(n: number | null | undefined, lang: Lang): string {
  if (!ok(n)) return DASH;
  return `${fmtSigned(n, lang)}%`;
}

export function fmtPct(n: number | null | undefined, lang: Lang, digits = 2): string {
  if (!ok(n)) return DASH;
  return `${fmtNumber(n, lang, digits)}%`;
}

export function fmtCompact(n: number | null | undefined, lang: Lang, currency?: string): string {
  if (!ok(n)) return DASH;
  return new Intl.NumberFormat(intlLocale(lang), {
    notation: 'compact',
    maximumFractionDigits: 2,
    ...(currency ? { style: 'currency', currency } : {}),
  }).format(n);
}

export function fmtInt(n: number | null | undefined, lang: Lang): string {
  if (!ok(n)) return DASH;
  return new Intl.NumberFormat(intlLocale(lang), { maximumFractionDigits: 0 }).format(n);
}

export function fmtTime(ts: number | string | Date, lang: Lang, seconds = true): string {
  return new Intl.DateTimeFormat(intlLocale(lang), {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(new Date(ts));
}

export function fmtDate(ts: number | string | Date, lang: Lang, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  return new Intl.DateTimeFormat(intlLocale(lang), opts).format(new Date(ts));
}

/** Date-only ISO strings (YYYY-MM-DD) are calendar dates: format in UTC so they don't shift a day. */
export function fmtIsoDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return DASH;
  return fmtDate(`${iso.slice(0, 10)}T00:00:00Z`, lang, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Updated" stamp: time only if today, otherwise date + time. */
export function fmtStamp(iso: string, lang: Lang): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? fmtTime(d, lang)
    : fmtDate(d, lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function timeAgo(iso: string, lang: Lang, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: 'auto', style: 'short' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export type Direction = 'up' | 'down' | 'flat';
export function direction(n: number | null | undefined): Direction {
  if (!ok(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}
