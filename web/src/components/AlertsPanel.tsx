'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useAlertText } from '@/lib/alert-text';
import { deleteAlert, useAlerts } from '@/lib/api';
import { fmtPrice, fmtStamp } from '@/lib/format';
import { XIcon } from './icons';
import { cx, ErrorState, Skeleton, useLang } from './ui';

/** Sidebar list of all alerts: active first, then triggered. */
export function AlertsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations('alerts');
  const lang = useLang();
  const text = useAlertText(lang);
  const { data, error, isLoading, mutate } = useAlerts();
  const list = [...(data ?? [])].sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));

  return (
    <section aria-labelledby="alerts-title" className="rounded-xl border border-border bg-panel">
      <header className="flex min-h-12 items-center justify-between border-b border-border px-4 py-2">
        <h2 id="alerts-title" className="text-sm font-semibold">{t('title')}</h2>
        {data && <span className="text-xs text-muted">{t('activeCount', { count: data.filter((a) => a.status === 'active').length })}</span>}
      </header>
      {error ? (
        <div className="p-4"><ErrorState error={error} onRetry={() => mutate()} /></div>
      ) : isLoading ? (
        <div className="space-y-2 p-3"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
      ) : list.length === 0 ? (
        <p className="p-4 text-sm text-muted">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((a) => (
            <li key={a.id} className="flex items-start gap-1 py-2 pl-4 pr-1">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/stock/${encodeURIComponent(a.symbol)}`} onClick={onNavigate} className="font-mono text-sm font-semibold hover:text-accent">
                    {a.symbol}
                  </Link>
                  <span
                    className={cx(
                      'rounded border px-1.5 text-[11px]',
                      a.status === 'active' ? 'border-accent/50 text-accent' : 'border-warn/50 text-warn',
                    )}
                  >
                    {a.status === 'active' ? t('statusActive') : t('statusTriggered')}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted">{text.condition(a)}</p>
                {a.status === 'triggered' && a.triggeredAt && (
                  <p className="mt-0.5 text-xs text-warn">
                    {t('firedAt', { price: fmtPrice(a.triggerPrice, lang), time: fmtStamp(a.triggeredAt, lang) })}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => deleteAlert(a.id)}
                aria-label={t('delete', { condition: `${a.symbol} ${text.condition(a)}` })}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-down"
              >
                <XIcon width={16} height={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
