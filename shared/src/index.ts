// Types and constants shared by the server and the web app.

export type Lang = 'en' | 'th';
export const LANGS: Lang[] = ['en', 'th'];

export type Range = '1H' | '1D' | '1W' | '1M' | '6M' | '1Y' | '5Y';
export const RANGES: Range[] = ['1H', '1D', '1W', '1M', '6M', '1Y', '5Y'];

export type Resolution = '1min' | '5min' | '30min' | '1hour' | '1day' | '1week';

/** Range → candle size (see spec table). */
export const RANGE_RESOLUTION: Record<Range, Resolution> = {
  '1H': '1min',
  '1D': '5min',
  '1W': '30min',
  '1M': '1hour',
  '6M': '1day',
  '1Y': '1day',
  '5Y': '1week',
};

export const RESOLUTION_SECONDS: Record<Resolution, number> = {
  '1min': 60,
  '5min': 300,
  '30min': 1800,
  '1hour': 3600,
  '1day': 86400,
  '1week': 604800,
};

/** Approximate span of each range in seconds (calendar time). */
export const RANGE_SECONDS: Record<Range, number> = {
  '1H': 3600,
  '1D': 86400,
  '1W': 7 * 86400,
  '1M': 30 * 86400,
  '6M': 182 * 86400,
  '1Y': 365 * 86400,
  '5Y': 5 * 365 * 86400,
};

const WEEK_OFFSET = 4 * 86400; // 1970-01-01 was a Thursday; shift so weeks start Monday 00:00 UTC

/** Start (unix seconds) of the candle bucket that contains `tsSec`. */
export function bucketStart(tsSec: number, resolution: Resolution): number {
  const size = RESOLUTION_SECONDS[resolution];
  if (resolution === '1week') {
    return Math.floor((tsSec - WEEK_OFFSET) / size) * size + WEEK_OFFSET;
  }
  return Math.floor(tsSec / size) * size;
}

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && (RANGES as string[]).includes(v);
}

export function isIntradayRange(r: Range): boolean {
  return RESOLUTION_SECONDS[RANGE_RESOLUTION[r]] < 86400;
}

/** Where a value came from and how fresh it is. Attached to every card / dataset. */
export interface SourceMeta {
  source: string;
  updatedAt: string; // ISO timestamp
  stale?: boolean; // served from cache after an upstream failure
  note?: string;
}

export type MarketState = 'open' | 'closed' | 'pre' | 'post';

export interface Quote {
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  peTTM: number | null;
  week52High: number | null;
  week52Low: number | null;
  dividendYield: number | null; // percent, e.g. 0.52 = 0.52 %
  ts: number; // ms epoch of the price
  marketState: MarketState;
  delayed: boolean; // true if the provider plan only gives delayed data
  meta: SourceMeta;
}

export interface Candle {
  time: number; // unix seconds (bucket start)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries {
  symbol: string;
  range: Range;
  resolution: Resolution;
  candles: Candle[];
  meta: SourceMeta;
}

export interface SymbolMatch {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

export type Sentiment = 'positive' | 'negative' | 'neutral';

export interface NewsItem {
  id: string;
  headline: string;
  snippet: string;
  source: string;
  url: string;
  publishedAt: string; // ISO
  sentiment: Sentiment | null;
}

export interface NewsSummary {
  text: string;
  articleCount: number;
  lang: Lang;
  meta: SourceMeta;
}

/** Why there is (or isn't) a summary. */
export type SummaryStatus = 'ok' | 'disabled' | 'no-recent' | 'error' | 'pending';
/** How sentiment tags were produced. */
export type SentimentMethod = 'ai' | 'keywords' | 'mock';

export interface NewsResponse {
  symbol: string;
  lang: Lang;
  summary: NewsSummary | null;
  summaryStatus: SummaryStatus;
  /** Headlines + snippets are from the provider, in their original language. */
  items: NewsItem[];
  sentimentMethod: SentimentMethod | null;
  sentimentSource: string | null;
  /** The AI is still working on tags or the summary (shown meanwhile: keyword tags / "writing…"); ask again soon. */
  aiPending?: boolean;
  /** The summary shown is the previous one; a new one (with newer articles) is being written. */
  summaryUpdating?: boolean;
  meta: SourceMeta;
}

export interface Person {
  name: string;
  since: number | null;
}

export interface Profile {
  symbol: string;
  name: string;
  description: string | null;
  ceo: Person | null;
  cfo: Person | null;
  hq: string | null;
  founded: number | null;
  employees: number | null;
  website: string | null;
  meta: SourceMeta;
}

/** One extracted guidance value with the quote that supports it. */
export interface GuidanceField {
  value: string;
  quote: string;
}

export interface Guidance {
  fiscalYear: number | null;
  revenueGuidance: GuidanceField | null;
  epsGuidance: GuidanceField | null;
  capexBudget: GuidanceField | null;
  rndBudget: GuidanceField | null;
  priorities: (GuidanceField | null)[]; // always length 3
  sourceTitle: string | null;
  sourceDate: string | null;
  meta: SourceMeta;
}

export interface Estimates {
  fiscalYear: number | null;
  revenueAvg: number | null;
  epsAvg: number | null;
  analystCount: number | null;
  meta: SourceMeta;
}

export interface PriceTargets {
  low: number | null;
  avg: number | null;
  high: number | null;
  meta: SourceMeta;
}

export interface Ratings {
  buy: number | null;
  hold: number | null;
  sell: number | null;
  meta: SourceMeta;
}

export interface EarningsEvent {
  date: string | null; // ISO date (YYYY-MM-DD)
  meta: SourceMeta;
}

export interface Transcript {
  symbol: string;
  title: string;
  date: string;
  text: string;
  meta: SourceMeta;
}

/** A filing / document guidance can be extracted from (e.g. SEC 8-K earnings release, 10-K). */
export interface SourceDocument {
  title: string;
  date: string; // YYYY-MM-DD
  url: string;
  text: string;
}

export type GuidanceStatus = 'ok' | 'disabled' | 'no-source' | 'error' | 'pending';

export interface InsightResponse {
  symbol: string;
  lang: Lang;
  profile: Profile | null;
  guidance: Guidance | null;
  /** Why guidance is (or isn't) present. 'disabled' = no AI key. */
  guidanceStatus: GuidanceStatus;
  /** Documents the guidance was (or would be) extracted from — linkable even when AI is off. */
  guidanceSources: { title: string; date: string; url: string }[];
  estimates: Estimates | null;
  priceTargets: PriceTargets | null;
  ratings: Ratings | null;
  earnings: EarningsEvent | null;
}

// ---- Chart events ----
export interface EarningsReport {
  date: string; // YYYY-MM-DD
  hour: 'bmo' | 'amc' | 'dmh' | null; // before open / after close / during market hours
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}

export interface DividendEvent {
  exDate: string; // YYYY-MM-DD
  amount: number;
  paymentDate: string | null;
}

export interface EventsResponse {
  symbol: string;
  earnings: EarningsReport[];
  dividends: DividendEvent[];
  meta: { earnings: SourceMeta | null; dividends: SourceMeta | null };
}

// ---- Support & resistance ----
export type LevelStrength = 'weak' | 'medium' | 'strong';

export interface PriceLevel {
  kind: 'support' | 'resistance';
  price: number;
  zoneLow: number;
  zoneHigh: number;
  touches: number;
  lastTouched: string; // ISO timestamp of the most recent swing in this zone
  strength: LevelStrength;
  score: number; // 0..1
}

export interface Pivots {
  P: number;
  R1: number;
  R2: number;
  S1: number;
  S2: number;
  sessionDate: string; // YYYY-MM-DD of the session the pivots were computed from
  meta: SourceMeta;
}

export interface LevelsResponse {
  symbol: string;
  range: Range;
  resolution: Resolution;
  price: number | null; // price used to split supports / resistances
  supports: PriceLevel[]; // up to 3, nearest first
  resistances: PriceLevel[]; // up to 3, nearest first
  pivots: Pivots | null;
  candleCount: number;
  meta: SourceMeta;
}

export interface WatchlistItem {
  symbol: string;
  addedAt: string;
  position: number; // "My order"
  group: string | null; // optional group name
}

export const MAX_GROUP_NAME = 24;

/** ~1 month of daily closes for a watchlist trend line. */
export interface Sparkline {
  symbol: string;
  points: { time: number; close: number }[]; // oldest first; daily bars (unix seconds, 00:00 UTC)
  meta: SourceMeta;
}

export interface MetaResponse {
  providers: string[];
  /** true when at least one capability is served by mock data */
  mock: boolean;
  mockCapabilities: string[];
}

// ---- Alerts ----
export type AlertKind = 'price_above' | 'price_below' | 'near_level' | 'breakout';
export const NEAR_LEVEL_PCT = 1; // "price within 1% of a level"

export interface AlertLevel {
  kind: 'support' | 'resistance';
  price: number;
  zoneLow: number;
  zoneHigh: number;
  range: Range; // chart range the level came from
}

export interface Alert {
  id: string;
  userId?: string;
  symbol: string;
  kind: AlertKind;
  targetPrice: number | null;
  level: AlertLevel | null;
  status: 'active' | 'triggered';
  createdAt: string;
  triggeredAt: string | null;
  triggerPrice: number | null;
  seen: boolean;
}

export type NewAlert =
  | { symbol: string; kind: 'price_above' | 'price_below'; targetPrice: number }
  | { symbol: string; kind: 'near_level' | 'breakout'; level: AlertLevel };

// ---- WebSocket protocol ----
export type ClientMessage =
  | { type: 'subscribe'; symbols: string[] }
  | { type: 'unsubscribe'; symbols: string[] };

export type ServerMessage =
  | { type: 'tick'; symbol: string; price: number; ts: number; volume?: number }
  | { type: 'alert'; alert: Alert }
  | { type: 'error'; message: string };

export function normalizeSymbol(s: string): string {
  return s.trim().toUpperCase();
}

export function isValidSymbol(s: string): boolean {
  return /^[A-Z0-9.\-^=]{1,15}$/.test(s);
}

// ---- Ask AI ----
export interface AskSource {
  id: string;
  label: string;
  type: 'news' | 'price' | 'levels' | 'guidance' | 'analyst' | 'general';
  url?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: AskSource[];
  ts: number;
}

export interface AskAiRequest {
  symbol: string;
  question: string;
  lang: Lang;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface AskAiResponse {
  answer: string;
  sources: AskSource[];
  model: string;
}

export * from './market-hours';
