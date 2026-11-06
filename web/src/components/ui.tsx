'use client';

import type { Lang, SourceMeta } from '@tm/shared';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { DASH, direction, fmtSigned, fmtSignedPct, fmtStamp } from '@/lib/format';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function useLang(): Lang {
  return useLocale() === 'th' ? 'th' : 'en';
}

export function Card({ title, children, className, bodyClassName, actions, id, footer }: { title?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; actions?: ReactNode; id?: string; footer?: ReactNode }) {
  return (
    <section aria-labelledby={id && title ? `${id}-title` : undefined} className={cx('flex flex-col rounded-xl border border-border bg-panel', className)}>
      {(title || actions) && (
        <header className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-4 py-2">
          {title && (
            <h2 id={id ? `${id}-title` : undefined} className="text-sm font-semibold tracking-wide text-text">
              {title}
            </h2>
          )}
          {actions}
        </header>
      )}
      <div className={cx('flex-1 p-4', bodyClassName)}>{children}</div>
      {footer && <footer className="border-t border-border px-4 py-2">{footer}</footer>}
    </section>
  );
}

/** "Source: X · Updated HH:MM:SS" plus a stale badge / note. */
export function SourceLine({ meta, extra }: { meta: SourceMeta | null | undefined; extra?: ReactNode }) {
  const t = useTranslations('common');
  const lang = useLang();
  if (!meta) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span>{t('source', { source: meta.source })}</span>
      <span aria-hidden>·</span>
      <span>{t('updated', { time: fmtStamp(meta.updatedAt, lang) })}</span>
      {meta.stale && (
        <>
          <span className="rounded border border-warn/50 px-1.5 text-warn">{t('stale')}</span>
          <span className="basis-full text-warn">{t('staleNote')}</span>
        </>
      )}
      {extra}
    </p>
  );
}

/** Missing value: "—" with a short note. */
export function Missing({ note, inline }: { note?: string; inline?: boolean }) {
  const t = useTranslations('common');
  const text = note ?? t('notAvailable');
  return (
    <span className={cx('text-muted', inline ? '' : 'flex flex-col')}>
      <span aria-hidden className="font-mono">{DASH}</span>
      <span className={cx('text-[11px] leading-tight', inline ? 'ml-1' : '')}>{text}</span>
    </span>
  );
}

const ARROW = { up: '▲', down: '▼', flat: '■' } as const;

/** Signed change with arrow + colour (direction never shown by colour alone). */
export function Change({ value, pct, currency, className, size = 'sm' }: { value?: number | null; pct?: number | null; currency?: string; className?: string; size?: 'sm' | 'lg' }) {
  const lang = useLang();
  const d = direction(pct ?? value);
  const color = d === 'up' ? 'text-up' : d === 'down' ? 'text-down' : 'text-muted';
  const hasValue = value !== undefined;
  return (
    <span className={cx('inline-flex items-baseline gap-1.5 font-mono tabular-nums', color, size === 'lg' ? 'text-lg' : 'text-sm', className)}>
      <span aria-hidden className={size === 'lg' ? 'text-sm' : 'text-[10px]'}>{ARROW[d]}</span>
      {hasValue && <span>{fmtSigned(value, lang, { currency })}</span>}
      {pct !== undefined && <span>{hasValue ? `(${fmtSignedPct(pct, lang)})` : fmtSignedPct(pct, lang)}</span>}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton', className)} />;
}

export function ErrorState({ onRetry, message }: { onRetry?: () => void; message?: string }) {
  const t = useTranslations('common');
  return (
    <div role="alert" className="flex flex-col items-start gap-2 text-sm text-muted">
      <p>{message ?? t('loadError')}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="min-h-11 rounded-md border border-border px-3 text-text hover:bg-panel-2">
          {t('retry')}
        </button>
      )}
    </div>
  );
}

export const btn = {
  primary: 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-button px-4 text-sm font-medium text-white hover:bg-button-hover disabled:opacity-50',
  ghost: 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm text-text hover:bg-panel-2 disabled:opacity-50',
  icon: 'inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-text',
};
