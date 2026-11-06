'use client';

import type { Alert } from '@tm/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAlertText } from '@/lib/alert-text';
import { applyAlertUpdate, markAlertSeen, useAlerts } from '@/lib/api';
import { fmtStamp } from '@/lib/format';
import { liveFeed } from '@/lib/live';
import { BellIcon, XIcon } from './icons';
import { useLang } from './ui';

/**
 * Shows triggered alerts: pushed live over the WebSocket, plus any that fired while
 * the page was closed. In-app toast always; a system notification when permitted.
 */
export function AlertCenter() {
  const t = useTranslations('alerts');
  const lang = useLang();
  const text = useAlertText(lang);
  const { data } = useAlerts();
  const [toasts, setToasts] = useState<Alert[]>([]);
  const shownMissed = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;

  // Live triggers.
  useEffect(
    () =>
      liveFeed().onAlert((a) => {
        applyAlertUpdate(a);
        setToasts((cur) => (cur.some((x) => x.id === a.id) ? cur : [a, ...cur]));
        notify(a, textRef.current.triggered(a));
      }),
    [],
  );

  // Triggered while the page was closed (once per page load).
  useEffect(() => {
    if (!data || shownMissed.current) return;
    shownMissed.current = true;
    const missed = data.filter((a) => a.status === 'triggered' && !a.seen);
    if (missed.length) setToasts((cur) => [...cur, ...missed.filter((m) => !cur.some((c) => c.id === m.id))]);
  }, [data]);

  const dismiss = (a: Alert) => {
    setToasts((cur) => cur.filter((x) => x.id !== a.id));
    void markAlertSeen(a.id);
  };

  if (toasts.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="fixed right-4 top-20 z-50 flex w-[min(92vw,22rem)] flex-col gap-2">
      {toasts.slice(0, 4).map((a) => (
        <div key={a.id} className="rounded-lg border border-accent/50 bg-panel p-3 shadow-2xl">
          <div className="flex items-start gap-2">
            <BellIcon className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                <Link href={`/stock/${encodeURIComponent(a.symbol)}`} className="hover:text-accent">{t('toastTitle', { symbol: a.symbol })}</Link>
              </p>
              <p className="mt-0.5 text-sm text-text">{text.triggered(a)}</p>
              {a.triggeredAt && <p className="mt-1 text-xs text-muted">{fmtStamp(a.triggeredAt, lang)}</p>}
            </div>
            <button type="button" onClick={() => dismiss(a)} aria-label={t('dismiss')} className="-m-1 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-text">
              <XIcon width={16} height={16} />
            </button>
          </div>
        </div>
      ))}
      {toasts.length > 4 && <p className="rounded bg-panel px-3 py-1 text-right text-xs text-muted">{t('more', { count: toasts.length - 4 })}</p>}
    </div>
  );
}

function notify(a: Alert, body: string) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(`${a.symbol} · Trading Monitor`, { body, tag: a.id });
    n.onclick = () => {
      window.focus();
      window.location.href = `/stock/${encodeURIComponent(a.symbol)}`;
    };
  } catch {
    // some browsers only allow notifications from a service worker
  }
}

/** Ask once, from a user gesture (e.g. saving an alert). */
export async function ensureNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}
