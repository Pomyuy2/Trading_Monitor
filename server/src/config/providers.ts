import type { Capability } from '../providers/types.js';

export type ProviderName = 'finnhub' | 'fmp' | 'twelvedata' | 'mock' | 'set';

/**
 * Which provider serves each capability. Change providers here — UI code
 * never needs to change. If the chosen provider is unavailable (no API key)
 * or doesn't implement the capability yet, the registry falls back to `mock`.
 */
export const CAPABILITY_PROVIDERS: Record<Capability, ProviderName> = {
  search: 'finnhub',
  quote: 'finnhub',
  realtime: 'finnhub',
  profile: 'finnhub',
  news: 'finnhub',
  keyStats: 'fmp', // today's volume (not in Finnhub's quote)
  dailyCandles: 'fmp', // 6M, 1Y, 5Y
  intradayCandles: 'twelvedata', // 1H, 1D, 1W, 1M (FMP intraday is paid)
  estimates: 'fmp',
  priceTargets: 'fmp',
  ratings: 'fmp',
  earningsCalendar: 'fmp',
  transcripts: 'fmp',
};
