'use client';

import { useSyncExternalStore } from 'react';

/**
 * UI preferences, saved in BOTH localStorage and a cookie:
 * - the cookie lets the server render the page with your settings (no flash on load);
 * - localStorage restores them if cookies were cleared.
 * Language keeps next-intl's own cookie (NEXT_LOCALE) and is mirrored here.
 */
export const PREF_COOKIE = {
  symbol: 'tm_symbol',
  range: 'tm_range',
  levels: 'tm_levels',
  pivots: 'tm_pivots',
  theme: 'tm_theme',
  lang: 'NEXT_LOCALE',
} as const;
export type PrefKey = keyof typeof PREF_COOKIE;

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function savePref(key: PrefKey, value: string) {
  try {
    localStorage.setItem(`tm.${key}`, value);
  } catch {}
  document.cookie = `${PREF_COOKIE[key]}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
}

export function loadPref(key: PrefKey): string | null {
  let v: string | null = null;
  try {
    v = localStorage.getItem(`tm.${key}`);
  } catch {}
  return v ?? readCookie(PREF_COOKIE[key]);
}

/** If the cookie is missing but localStorage has a value, put the cookie back. Returns true if restored. */
export function restoreCookie(key: PrefKey): boolean {
  let v: string | null = null;
  try {
    v = localStorage.getItem(`tm.${key}`);
  } catch {}
  if (v != null && readCookie(PREF_COOKIE[key]) == null) {
    document.cookie = `${PREF_COOKIE[key]}=${encodeURIComponent(v)}; path=/; max-age=31536000; samesite=lax`;
    return true;
  }
  return false;
}

// ---------- theme ----------
export type Theme = 'dark' | 'light';

const themeListeners = new Set<() => void>();
function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#F4F6F9' : '#0B0E13');
  savePref('theme', theme);
  themeListeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      themeListeners.add(l);
      return () => themeListeners.delete(l);
    },
    currentTheme,
    () => 'dark',
  );
}
