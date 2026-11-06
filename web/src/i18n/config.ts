import type { Lang } from '@tm/shared';

export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function resolveLang(v: string | undefined | null): Lang {
  return v === 'th' ? 'th' : 'en';
}
