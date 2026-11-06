'use client';

import { useLocale } from 'next-intl';
import { useEffect } from 'react';
import { ensurePushSubscription, registerServiceWorker } from '@/lib/pwa';

/** Registers the service worker; in the installed app, keeps the push subscription (and its language) current. */
export function PwaSetup() {
  const locale = useLocale();
  useEffect(() => {
    void registerServiceWorker().then(() => ensurePushSubscription(locale === 'th' ? 'th' : 'en'));
  }, [locale]);
  return null;
}
