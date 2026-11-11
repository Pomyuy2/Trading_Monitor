import type { Capability } from '../providers/types.js';

export type ProviderName = 'finnhub' | 'fmp' | 'twelvedata' | 'sec' | 'mock' | 'set' | 'yahoo';

/**
 * Which provider serves each capability. Change providers here — UI code
 * never needs to change. If the chosen provider is unavailable (no API key)
 * or doesn't implement the capability yet, the registry falls back to `mock`.
 */
export const CAPABILITY_PROVIDERS: Record<Capability, ProviderName> = {
  search: 'finnhub',
  quote: 'finnhub',
  realtime: 'finnhub',
  profile: 'fmp', // Finnhub's executives endpoint is paid; FMP's profile + key-executives are free
  news: 'finnhub',
  keyStats: 'fmp', // today's volume (not in Finnhub's quote)
  dailyCandles: 'yahoo', // 6M, 1Y, 5Y (free, no daily cap, no RKLB/FLNC exclusions)
  intradayCandles: 'yahoo', // 1H, 1D, 1W, 1M (free, eliminates Twelve Data 8 req/min crash)
  estimates: 'fmp',
  priceTargets: 'fmp',
  ratings: 'fmp',
  earningsCalendar: 'fmp',
  transcripts: 'sec',
  earningsHistory: 'fmp', // last 4 reports + next (free plan: 5 rows); Finnhub's free calendar returns only ~2
  dividends: 'fmp', // free SEC filings (8-K earnings release + 10-K MD&A); FMP transcripts are paid
};

/**
 * Second choice when the main provider refuses a symbol on the free plan (HTTP 401/402/403)
 * or runs out of calls (HTTP 429).
 */
export const CAPABILITY_FALLBACKS: Partial<Record<Capability, ProviderName>> = {
  quote: 'yahoo',
  search: 'yahoo',
  profile: 'yahoo',
  priceTargets: 'yahoo',
  ratings: 'yahoo',
  keyStats: 'yahoo',
  dividends: 'yahoo',
  dailyCandles: 'twelvedata',
  intradayCandles: 'twelvedata',
};
