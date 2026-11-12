import type { Capability } from '../providers/types.js';

export type ProviderName = 'finnhub' | 'fmp' | 'twelvedata' | 'sec' | 'mock' | 'set' | 'yahoo' | 'alpaca' | 'tiingo';

/**
 * Ordered fallback chains per capability.
 * Providers are attempted in sequence. Unavailable providers (e.g. missing API keys)
 * or rate-limited providers are skipped automatically.
 */
export const CAPABILITY_CHAINS: Record<Capability, ProviderName[]> = {
  search: ['finnhub', 'yahoo'],
  quote: ['finnhub', 'alpaca', 'yahoo'],
  realtime: ['finnhub'],
  profile: ['fmp', 'yahoo'],
  news: ['finnhub', 'tiingo'],
  keyStats: ['fmp', 'yahoo'],
  dailyCandles: ['yahoo', 'alpaca', 'tiingo', 'fmp', 'twelvedata'],
  intradayCandles: ['yahoo', 'alpaca', 'twelvedata'],
  estimates: ['fmp'],
  priceTargets: ['fmp', 'yahoo'],
  ratings: ['fmp', 'yahoo'],
  earningsCalendar: ['fmp'],
  transcripts: ['sec'],
  earningsHistory: ['fmp'],
  dividends: ['fmp', 'yahoo'],
  companyFacts: ['sec'],
};

/**
 * Which provider serves each capability as the primary choice.
 */
export const CAPABILITY_PROVIDERS: Record<Capability, ProviderName> = {
  search: 'finnhub',
  quote: 'finnhub',
  realtime: 'finnhub',
  profile: 'fmp',
  news: 'finnhub',
  keyStats: 'fmp',
  dailyCandles: 'yahoo',
  intradayCandles: 'yahoo',
  estimates: 'fmp',
  priceTargets: 'fmp',
  ratings: 'fmp',
  earningsCalendar: 'fmp',
  transcripts: 'sec',
  earningsHistory: 'fmp',
  dividends: 'fmp',
  companyFacts: 'sec',
};

/**
 * Second choice when the main provider fails or rate-limits.
 * Maintained for backward compatibility.
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
