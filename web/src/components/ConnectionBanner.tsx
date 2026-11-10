'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import useSWR, { mutate } from 'swr';
import { fetchJson } from '@/lib/api';

/**
 * Explains app-wide failures in one place:
 * - offline (browser has no network)
 * - the data server (Fastify, port 4000) is unreachable — e.g. it crashed or `pnpm dev` isn't running
 * When the server comes back, every section is reloaded automatically.
 */
export function ConnectionBanner() {
  const t = useTranslations('connection');
  const [online, setOnline] = useState(true);
  const { error, data } = useSWR<{ ok: boolean }>('/api/health', fetchJson, {
    refreshInterval: (latest) => (latest ? 30_000 : 5_000),
    errorRetryInterval: 5_000,
    errorRetryCount: Infinity,
    revalidateOnFocus: true,
    dedupingInterval: 2_000,
  });
  const wasDown = useRef(false);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const down = !!error && !data;
  useEffect(() => {
    if (down) wasDown.current = true;
    else if (wasDown.current && data) {
      wasDown.current = false;
      void mutate(() => true); // server is back: reload every section
    }
  }, [down, data]);

  if (!online) {
    return (
      <div role="alert" className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-center text-sm text-warn">
        {t('offline')}
      </div>
    );
  }
  if (!down) return null;
  return (
    <div role="alert" className="border-b border-down/40 bg-down/10 px-4 py-2 text-center text-sm text-down">
      <strong>{t('serverDownTitle')}</strong> {t('serverDown')}
    </div>
  );
}
