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
  levels: 24 * HOUR, // keyed by the latest candle, so new candles trigger a recompute anyway
  sentiment: 7 * 24 * HOUR, // per headline; a headline's tag doesn't change
  profile: 24 * HOUR,
  estimates: 12 * HOUR,
  events: 12 * HOUR, // earnings + dividend markers
  search: 1 * HOUR,
  guidanceDocs: 12 * HOUR, // filing list / text; guidance itself lives until the next earnings date
  guidanceFallback: 7 * 24 * HOUR, // used when the next earnings date is unknown
} as const;
