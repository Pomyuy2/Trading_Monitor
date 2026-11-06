import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, resolveLang } from './config';

export default getRequestConfig(async () => {
  const store = await cookies();
  const locale = resolveLang(store.get(LOCALE_COOKIE)?.value);
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
