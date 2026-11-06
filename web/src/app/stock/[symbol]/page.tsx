import { isValidSymbol, normalizeSymbol } from '@tm/shared';
import { notFound } from 'next/navigation';
import { Dashboard } from '@/components/Dashboard';

export default async function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: raw } = await params;
  const symbol = normalizeSymbol(decodeURIComponent(raw));
  if (!isValidSymbol(symbol)) notFound();
  return <Dashboard symbol={symbol} />;
}
