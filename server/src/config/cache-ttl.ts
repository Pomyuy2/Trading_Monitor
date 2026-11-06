const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Cache lifetimes (ms). Guidance is cached until the next earnings date (computed at call time). */
export const TTL = {
  quote: 5 * SEC,
  intradayCandles: 1 * MIN,
  intradayIdle: 30 * MIN, // intraday candles when the market isn't trading
  dailyCandles: 1 * HOUR,
  keyStats: 5 * MIN,
  news: 5 * MIN,
  newsSummary: 15 * MIN,
  sentiment: 7 * 24 * HOUR, // per headline; a headline's tag doesn't change
  profile: 24 * HOUR,
  estimates: 12 * HOUR,
  search: 1 * HOUR,
  guidanceFallback: 7 * 24 * HOUR, // used when the next earnings date is unknown
} as const;
