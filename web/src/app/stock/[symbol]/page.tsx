import { isRange, isValidSymbol, normalizeSymbol } from '@tm/shared';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { Dashboard } from '@/components/Dashboard';

export default async function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: raw } = await params;
  const symbol = normalizeSymbol(decodeURIComponent(raw));
  if (!isValidSymbol(symbol)) notFound();
  // Saved preferences arrive as cookies, so the first render already uses them.
  const c = await cookies();
  const range = c.get('tm_range')?.value;
  const initial = {
    range: range && isRange(range) ? range : ('1D' as const),
    levels: c.get('tm_levels')?.value !== '0',
    pivots: c.get('tm_pivots')?.value === '1',
  };
  return <Dashboard symbol={symbol} initial={initial} />;
}
