const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Cache lifetimes (ms). Guidance is cached until the next earnings date (computed at call time). */
export const TTL = {
  quote: 5 * SEC,
  intradayCandles: 1 * MIN,
  intradayIdle: 30 * MIN, // intraday candles when the market isn't trading
  dailyCandles: 1 * HOUR,
  sparkline: 12 * HOUR, // watchlist trend lines (daily closes); today's point comes from the live price
  keyStats: 5 * MIN,
  notInPlan: 12 * HOUR, // remember 'not in your free plan' answers so we don't ask again on every refresh
  news: 2 * MIN, // headline list; new articles show up within ~2 min
  newsSummary: 1 * HOUR, // keyed by the set of articles, so new articles trigger a new summary at once
  newsSummaryLast: 24 * HOUR, // previous summary, shown while a new one is being written
  levels: 24 * HOUR, // keyed by the latest candle, so new candles trigger a recompute anyway
  sentiment: 7 * 24 * HOUR, // per headline; a headline's tag doesn't change
  profile: 24 * HOUR,
  estimates: 12 * HOUR,
  events: 12 * HOUR, // earnings + dividend markers
  search: 1 * HOUR,
  guidanceDocs: 12 * HOUR, // filing list / text; guidance itself lives until the next earnings date
  guidanceFallback: 7 * 24 * HOUR, // used when the next earnings date is unknown
} as const;
