'use client';

/** Running as an installed app (home screen / desktop app window)? */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * When installed and notifications are allowed, subscribe to Web Push so alerts arrive
 * even when the app is closed. Safe to call repeatedly.
 */
export async function ensurePushSubscription(lang: 'en' | 'th'): Promise<'subscribed' | 'skipped' | 'failed'> {
  try {
    if (!isInstalled() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return 'skipped';
    if (!('PushManager' in window)) return 'skipped';
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = (await (await fetch('/api/push/key')).json()) as { publicKey: string };
      if (!publicKey) return 'failed';
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
    }
    const json = sub.toJSON();
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, lang }),
    });
    return res.ok ? 'subscribed' : 'failed';
  } catch {
    return 'failed';
  }
}
