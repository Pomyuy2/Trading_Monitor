import { isValidSymbol, normalizeSymbol } from '@tm/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/** Open the last symbol you viewed (cookie), else AAPL. */
export default async function Home() {
  const last = normalizeSymbol(decodeURIComponent((await cookies()).get('tm_symbol')?.value ?? ''));
  redirect(`/stock/${isValidSymbol(last) ? encodeURIComponent(last) : 'AAPL'}`);
}
