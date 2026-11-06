import type {
  CandleSeries,
  DividendEvent,
  EarningsReport,
  EarningsEvent,
  Estimates,
  NewsItem,
  PriceTargets,
  Profile,
  Quote,
  Range,
  Ratings,
  SourceDocument,
  SourceMeta,
  SymbolMatch,
  Transcript,
} from '@tm/shared';

export interface Tick {
  symbol: string;
  price: number;
  ts: number; // ms epoch
  volume?: number;
}

export type TickHandler = (tick: Tick) => void;

export type KeyStats = Partial<
  Pick<Quote, 'volume' | 'avgVolume' | 'marketCap' | 'peTTM' | 'week52High' | 'week52Low' | 'dividendYield' | 'open' | 'high' | 'low' | 'prevClose'>
> & { meta: SourceMeta };

/**
 * Everything the app needs from a market-data vendor. Each concrete provider
 * implements the subset it supports and throws `NotSupportedError` for the rest;
 * `config/providers.ts` decides which provider serves which capability.
 */
export interface MarketDataProvider {
  readonly name: string;
  /** True when the provider has what it needs (API key etc.) to serve requests. */
  isAvailable(): boolean;
  /** True when the provider is available AND implements this capability. */
  supports(cap: Capability): boolean;

  searchSymbols(query: string): Promise<SymbolMatch[]>;
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, range: Range): Promise<CandleSeries>;
  /** Extra quote fields another provider may lack (e.g. today's volume). */
  getKeyStats(symbol: string): Promise<KeyStats>;

  /** Realtime: start/stop streaming trades for these symbols. Ticks go to `onTick` handlers. */
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  onTick(handler: TickHandler): () => void;

  getProfile(symbol: string): Promise<Profile>;
  getNews(symbol: string, fromMs: number, toMs: number): Promise<NewsItem[]>;
  getEstimates(symbol: string): Promise<Estimates>;
  getPriceTargets(symbol: string): Promise<PriceTargets>;
  getRatings(symbol: string): Promise<Ratings>;
  getEarningsCalendar(symbol: string): Promise<EarningsEvent>;
  getLatestTranscript(symbol: string): Promise<Transcript | null>;
  /**
   * Documents to extract guidance from (capability 'transcripts'): the latest earnings-call
   * transcript and/or filings such as an 8-K earnings release and the 10-K. Default: the transcript.
   */
  getGuidanceDocuments(symbol: string): Promise<SourceDocument[]>;
  /** Past and upcoming earnings reports in a date window (chart markers). */
  getEarningsHistory(symbol: string, fromMs: number, toMs: number): Promise<EarningsReport[]>;
  /** Dividend history (ex-dates). */
  getDividends(symbol: string): Promise<DividendEvent[]>;
}

export type Capability =
  | 'search'
  | 'quote'
  | 'intradayCandles'
  | 'dailyCandles'
  | 'keyStats'
  | 'realtime'
  | 'profile'
  | 'news'
  | 'estimates'
  | 'priceTargets'
  | 'ratings'
  | 'earningsCalendar'
  | 'transcripts'
  | 'earningsHistory'
  | 'dividends';

export class NotSupportedError extends Error {
  constructor(provider: string, method: string) {
    super(`${provider} does not support ${method}`);
    this.name = 'NotSupportedError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** Bad / missing API key or plan doesn't include the endpoint (HTTP 401/402/403). */
export class ProviderAuthError extends Error {
  constructor(provider: string, public readonly status: number, detail?: string) {
    super(`${provider} refused the request (HTTP ${status})${detail ? ': ' + detail : ''}`);
    this.name = 'ProviderAuthError';
  }
}

/** Thrown on HTTP 429 so callers can back off and serve stale data. */
export class RateLimitError extends Error {
  constructor(provider: string, public readonly retryAfterMs?: number) {
    super(`${provider} rate limit hit`);
    this.name = 'RateLimitError';
  }
}

/** Base class: every method unsupported by default. */
export abstract class BaseProvider implements MarketDataProvider {
  abstract readonly name: string;
  /** Capabilities this provider implements. */
  protected abstract readonly capabilities: ReadonlySet<Capability>;
  protected tickHandlers = new Set<TickHandler>();

  abstract isAvailable(): boolean;

  supports(cap: Capability): boolean {
    return this.isAvailable() && this.capabilities.has(cap);
  }

  protected unsupported(method: string): never {
    throw new NotSupportedError(this.name, method);
  }

  async searchSymbols(_q: string): Promise<SymbolMatch[]> {
    return this.unsupported('searchSymbols');
  }
  async getQuote(_s: string): Promise<Quote> {
    return this.unsupported('getQuote');
  }
  async getCandles(_s: string, _r: Range): Promise<CandleSeries> {
    return this.unsupported('getCandles');
  }
  async getKeyStats(_s: string): Promise<KeyStats> {
    return this.unsupported('getKeyStats');
  }
  subscribe(_symbols: string[]): void {
    this.unsupported('subscribe');
  }
  unsubscribe(_symbols: string[]): void {
    this.unsupported('unsubscribe');
  }
  onTick(handler: TickHandler): () => void {
    this.tickHandlers.add(handler);
    return () => this.tickHandlers.delete(handler);
  }
  protected emitTick(tick: Tick) {
    for (const h of this.tickHandlers) h(tick);
  }
  async getProfile(_s: string): Promise<Profile> {
    return this.unsupported('getProfile');
  }
  async getNews(_s: string, _f: number, _t: number): Promise<NewsItem[]> {
    return this.unsupported('getNews');
  }
  async getEstimates(_s: string): Promise<Estimates> {
    return this.unsupported('getEstimates');
  }
  async getPriceTargets(_s: string): Promise<PriceTargets> {
    return this.unsupported('getPriceTargets');
  }
  async getRatings(_s: string): Promise<Ratings> {
    return this.unsupported('getRatings');
  }
  async getEarningsCalendar(_s: string): Promise<EarningsEvent> {
    return this.unsupported('getEarningsCalendar');
  }
  async getLatestTranscript(_s: string): Promise<Transcript | null> {
    return this.unsupported('getLatestTranscript');
  }
  async getEarningsHistory(_s: string, _f: number, _t: number): Promise<EarningsReport[]> {
    return this.unsupported('getEarningsHistory');
  }
  async getDividends(_s: string): Promise<DividendEvent[]> {
    return this.unsupported('getDividends');
  }
  async getGuidanceDocuments(symbol: string): Promise<SourceDocument[]> {
    const t = await this.getLatestTranscript(symbol);
    return t ? [{ title: t.title, date: t.date, url: '', text: t.text }] : [];
  }
}
