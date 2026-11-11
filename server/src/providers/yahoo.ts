import {
  RANGE_RESOLUTION,
  type Candle,
  type CandleSeries,
  type DividendEvent,
  type MarketState,
  type Person,
  type PriceTargets,
  type Profile,
  type Quote,
  type Range,
  type Ratings,
  type SymbolMatch,
} from '@tm/shared';
import { getJson } from '../lib/http.js';
import {
  BaseProvider,
  NotFoundError,
  NotSupportedError,
  ProviderAuthError,
  type Capability,
  type KeyStats,
} from './types.js';

const BASE_QUERY = 'https://query1.finance.yahoo.com';
const YAHOO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RANGE_MAP: Record<Range, { interval: string; range: string }> = {
  '1H': { interval: '1m', range: '1h' },
  '1D': { interval: '5m', range: '1d' },
  '1W': { interval: '30m', range: '5d' },
  '1M': { interval: '60m', range: '1mo' },
  '6M': { interval: '1d', range: '6mo' },
  '1Y': { interval: '1d', range: '1y' },
  '5Y': { interval: '1wk', range: '5y' },
};

function shortExchange(raw: string): string {
  const up = raw.toUpperCase();
  if (up.includes('NASDAQ') || up === 'NMS' || up === 'NGS' || up === 'NCM') return 'NASDAQ';
  if (up.includes('NYSE') || up === 'NYQ') return 'NYSE';
  if (up.includes('BATS') || up === 'BZX') return 'Cboe BZX';
  if (up.includes('AMEX') || up === 'ASE') return 'NYSE American';
  return raw;
}

function oneLine(s?: string | null): string | null {
  return s ? s.replace(/\s+/g, ' ').trim() : null;
}

function getMarketState(tradingPeriod?: {
  pre?: { start: number; end: number };
  regular?: { start: number; end: number };
  post?: { start: number; end: number };
}): MarketState {
  if (!tradingPeriod) return 'closed';
  const now = Math.floor(Date.now() / 1000);
  const reg = tradingPeriod.regular;
  const pre = tradingPeriod.pre;
  const post = tradingPeriod.post;
  if (reg && now >= reg.start && now < reg.end) return 'open';
  if (pre && now >= pre.start && now < pre.end) return 'pre';
  if (post && now >= post.start && now < post.end) return 'post';
  return 'closed';
}

interface YahooChartResponse {
  chart: {
    result?: Array<{
      meta: {
        currency?: string;
        symbol?: string;
        exchangeName?: string;
        fullExchangeName?: string;
        instrumentType?: string;
        firstTradeDate?: number;
        regularMarketTime?: number;
        hasPrePostMarketData?: boolean;
        gmtoffset?: number;
        timezone?: string;
        exchangeTimezoneName?: string;
        regularMarketPrice?: number;
        regularMarketChangePercent?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketVolume?: number;
        longName?: string;
        shortName?: string;
        dataGranularity?: string;
        range?: string;
        currentTradingPeriod?: {
          pre?: { start: number; end: number };
          regular?: { start: number; end: number };
          post?: { start: number; end: number };
        };
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
      events?: {
        dividends?: Record<string, { amount: number; date: number }>;
      };
    }>;
    error?: {
      code: string;
      description: string;
    } | null;
  };
}

interface CrumbSession {
  cookie: string;
  crumb: string;
  expiresAt: number;
}

export class YahooCrumbManager {
  private session: CrumbSession | null = null;
  private inFlight: Promise<CrumbSession> | null = null;

  async getCredentials(): Promise<{ cookie: string; crumb: string }> {
    if (this.session && Date.now() < this.session.expiresAt) {
      return { cookie: this.session.cookie, crumb: this.session.crumb };
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refreshCredentials().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  clear() {
    this.session = null;
  }

  private async refreshCredentials(): Promise<CrumbSession> {
    const res1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YAHOO_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    const rawCookie = res1?.headers.get('set-cookie') || '';
    const cookie = rawCookie.split(';')[0]?.trim() || '';

    const res2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': YAHOO_UA,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res2.ok) {
      throw new Error(`Failed to obtain Yahoo crumb: HTTP ${res2.status}`);
    }
    const crumb = (await res2.text()).trim();
    if (!crumb || crumb.includes('{') || crumb.includes('<html')) {
      throw new Error('Failed to obtain valid Yahoo crumb');
    }

    this.session = {
      cookie,
      crumb,
      expiresAt: Date.now() + 6 * 3600_000,
    };
    return this.session;
  }
}

/**
 * Yahoo Finance provider.
 * Free, requires no API key, and provides reliable US market data:
 * - Intraday & daily candles via v8/finance/chart
 * - Real-time quotes and key stats
 * - Symbol search via v1/finance/search
 * - Fundamentals (profile, price targets, analyst ratings) via v10/finance/quoteSummary
 */
export class YahooProvider extends BaseProvider {
  readonly name = 'Yahoo Finance';
  protected readonly capabilities = new Set<Capability>([
    'intradayCandles',
    'dailyCandles',
    'quote',
    'keyStats',
    'search',
    'profile',
    'priceTargets',
    'ratings',
    'dividends',
  ]);
  private readonly crumbManager: YahooCrumbManager;

  constructor(crumbManager?: YahooCrumbManager) {
    super();
    this.crumbManager = crumbManager ?? new YahooCrumbManager();
  }

  isAvailable(): boolean {
    return true; // Yahoo Finance requires no API key
  }

  private meta(note?: string) {
    return {
      source: this.name,
      updatedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
  }

  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    const config = RANGE_MAP[range];
    if (!config) throw new NotSupportedError(this.name, `getCandles(${range})`);

    const url = `${BASE_QUERY}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${config.interval}&range=${config.range}`;
    let res: YahooChartResponse;
    try {
      res = await getJson<YahooChartResponse>(this.name, url, { 'User-Agent': YAHOO_UA });
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw err;
    }

    if (res.chart.error) {
      if (res.chart.error.code === 'Not Found' || res.chart.error.description?.includes('No data found')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw new Error(`${this.name}: ${res.chart.error.description || res.chart.error.code}`);
    }

    const r = res.chart.result?.[0];
    if (!r) throw new NotFoundError(`Symbol ${symbol}`);

    const timestamps = r.timestamp ?? [];
    const quote = r.indicators?.quote?.[0] ?? {};
    const opens = quote.open ?? [];
    const highs = quote.high ?? [];
    const lows = quote.low ?? [];
    const closes = quote.close ?? [];
    const volumes = quote.volume ?? [];

    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const time = timestamps[i];
      const close = closes[i];
      if (time == null || close == null || !Number.isFinite(close)) continue;
      const open = opens[i];
      const high = highs[i];
      const low = lows[i];
      const volume = volumes[i];

      candles.push({
        time,
        open: open != null && Number.isFinite(open) ? open : close,
        high: high != null && Number.isFinite(high) ? high : close,
        low: low != null && Number.isFinite(low) ? low : close,
        close,
        volume: volume != null && Number.isFinite(volume) ? volume : 0,
      });
    }

    candles.sort((a, b) => a.time - b.time);

    return {
      symbol,
      range,
      resolution: RANGE_RESOLUTION[range],
      candles,
      meta: this.meta(),
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    const url = `${BASE_QUERY}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
    let res: YahooChartResponse;
    try {
      res = await getJson<YahooChartResponse>(this.name, url, { 'User-Agent': YAHOO_UA });
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw err;
    }

    if (res.chart.error) {
      if (res.chart.error.code === 'Not Found' || res.chart.error.description?.includes('No data found')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw new Error(`${this.name}: ${res.chart.error.description || res.chart.error.code}`);
    }

    const r = res.chart.result?.[0];
    const meta = r?.meta;
    if (!meta || meta.regularMarketPrice == null) {
      throw new NotFoundError(`Symbol ${symbol}`);
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change = prevClose != null ? +(price - prevClose).toFixed(4) : null;
    const changePct =
      meta.regularMarketChangePercent != null
        ? +meta.regularMarketChangePercent.toFixed(4)
        : prevClose && prevClose !== 0
        ? +(((price - prevClose) / prevClose) * 100).toFixed(4)
        : null;

    const firstCandleOpen = r.indicators?.quote?.[0]?.open?.find((o) => o != null && Number.isFinite(o)) ?? null;

    return {
      symbol,
      name: meta.longName || meta.shortName || null,
      exchange: meta.exchangeName ? shortExchange(meta.exchangeName) : null,
      currency: meta.currency || 'USD',
      price,
      change,
      changePct,
      open: firstCandleOpen,
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      prevClose,
      volume: meta.regularMarketVolume ?? null,
      avgVolume: null,
      marketCap: null,
      peTTM: null,
      week52High: meta.fiftyTwoWeekHigh ?? null,
      week52Low: meta.fiftyTwoWeekLow ?? null,
      dividendYield: null,
      ts: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
      marketState: getMarketState(meta.currentTradingPeriod),
      delayed: false,
      meta: this.meta(),
    };
  }

  async getKeyStats(symbol: string): Promise<KeyStats> {
    const url = `${BASE_QUERY}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    let res: YahooChartResponse;
    try {
      res = await getJson<YahooChartResponse>(this.name, url, { 'User-Agent': YAHOO_UA });
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw err;
    }

    const meta = res.chart.result?.[0]?.meta;
    if (!meta) throw new NotFoundError(`Symbol ${symbol}`);

    return {
      volume: meta.regularMarketVolume ?? null,
      open: null,
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      week52High: meta.fiftyTwoWeekHigh ?? null,
      week52Low: meta.fiftyTwoWeekLow ?? null,
      meta: this.meta(),
    };
  }

  async searchSymbols(query: string): Promise<SymbolMatch[]> {
    const url = `${BASE_QUERY}/v1/finance/search?q=${encodeURIComponent(query)}`;
    const r = await getJson<{
      quotes?: Array<{
        symbol?: string;
        longname?: string;
        shortname?: string;
        exchDisp?: string;
        exchange?: string;
        typeDisp?: string;
        quoteType?: string;
      }>;
    }>(this.name, url, { 'User-Agent': YAHOO_UA });

    return (r.quotes ?? [])
      .filter(
        (q) =>
          q.symbol &&
          (q.quoteType === 'EQUITY' ||
            q.quoteType === 'ETF' ||
            q.typeDisp === 'Equity' ||
            q.typeDisp === 'ETF'),
      )
      .slice(0, 10)
      .map((q) => ({
        symbol: q.symbol!,
        name: q.longname || q.shortname || q.symbol!,
        exchange: q.exchDisp || q.exchange || 'US',
        type: q.typeDisp || (q.quoteType === 'ETF' ? 'ETP' : 'Common Stock'),
      }));
  }

  private async getQuoteSummary<T>(symbol: string, modules: string[]): Promise<T> {
    const doFetch = async () => {
      const creds = await this.crumbManager.getCredentials();
      const url = `${BASE_QUERY}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules.join(',')}&crumb=${encodeURIComponent(creds.crumb)}`;
      return await getJson<T>(this.name, url, {
        'User-Agent': YAHOO_UA,
        ...(creds.cookie ? { Cookie: creds.cookie } : {}),
      });
    };

    try {
      return await doFetch();
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        this.crumbManager.clear();
        return await doFetch();
      }
      if (err instanceof Error && err.message.includes('404')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw err;
    }
  }

  async getProfile(symbol: string): Promise<Profile> {
    const res = await this.getQuoteSummary<{
      quoteSummary: {
        result?: Array<{
          assetProfile?: {
            city?: string;
            state?: string;
            country?: string;
            website?: string;
            fullTimeEmployees?: number;
            longBusinessSummary?: string;
            companyOfficers?: Array<{
              name?: string;
              title?: string;
              yearBorn?: number;
            }>;
          };
          price?: {
            longName?: string;
            shortName?: string;
          };
        }>;
      };
    }>(symbol, ['assetProfile', 'price']);

    const item = res.quoteSummary.result?.[0];
    const asset = item?.assetProfile;
    const price = item?.price;
    const name = price?.longName || price?.shortName;
    if (!name && !asset) throw new NotFoundError(`Profile for ${symbol}`);

    const officers = (asset?.companyOfficers ?? []).filter((o) => o.name && o.title);
    const findOfficer = (re: RegExp) => officers.find((o) => o.title && re.test(o.title));
    const ceoOfficer = findOfficer(/chief executive officer|\bceo\b/i);
    const cfoOfficer = findOfficer(/chief financial officer|\bcfo\b/i);

    const ceo: Person | null = ceoOfficer ? { name: ceoOfficer.name!, since: null } : null;
    const cfo: Person | null = cfoOfficer ? { name: cfoOfficer.name!, since: null } : null;
    const hq = [asset?.city, asset?.state, asset?.country].filter((x) => x && String(x).trim()).join(', ') || null;
    const employees =
      typeof asset?.fullTimeEmployees === 'number' && asset.fullTimeEmployees > 0 ? asset.fullTimeEmployees : null;

    return {
      symbol,
      name: name || symbol,
      description: oneLine(asset?.longBusinessSummary),
      ceo,
      cfo,
      hq,
      founded: null,
      employees,
      website: asset?.website || null,
      meta: this.meta(),
    };
  }

  async getPriceTargets(symbol: string): Promise<PriceTargets> {
    const res = await this.getQuoteSummary<{
      quoteSummary: {
        result?: Array<{
          financialData?: {
            targetLowPrice?: { raw?: number };
            targetMeanPrice?: { raw?: number };
            targetMedianPrice?: { raw?: number };
            targetHighPrice?: { raw?: number };
          };
        }>;
      };
    }>(symbol, ['financialData']);

    const fd = res.quoteSummary.result?.[0]?.financialData;
    const low = fd?.targetLowPrice?.raw ?? null;
    const avg = fd?.targetMeanPrice?.raw ?? fd?.targetMedianPrice?.raw ?? null;
    const high = fd?.targetHighPrice?.raw ?? null;

    if (low == null && avg == null && high == null) {
      return { low: null, avg: null, high: null, meta: this.meta('No price targets from source') };
    }

    return { low, avg, high, meta: this.meta() };
  }

  async getRatings(symbol: string): Promise<Ratings> {
    const res = await this.getQuoteSummary<{
      quoteSummary: {
        result?: Array<{
          recommendationTrend?: {
            trend?: Array<{
              strongBuy?: number;
              buy?: number;
              hold?: number;
              sell?: number;
              strongSell?: number;
            }>;
          };
        }>;
      };
    }>(symbol, ['recommendationTrend']);

    const trend = res.quoteSummary.result?.[0]?.recommendationTrend?.trend?.[0];
    if (!trend) {
      return { buy: null, hold: null, sell: null, meta: this.meta('No ratings from source') };
    }

    return {
      buy: (trend.strongBuy ?? 0) + (trend.buy ?? 0),
      hold: trend.hold ?? 0,
      sell: (trend.sell ?? 0) + (trend.strongSell ?? 0),
      meta: this.meta(),
    };
  }

  async getDividends(symbol: string): Promise<DividendEvent[]> {
    const url = `${BASE_QUERY}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y&events=div`;
    let res: YahooChartResponse;
    try {
      res = await getJson<YahooChartResponse>(this.name, url, { 'User-Agent': YAHOO_UA });
    } catch {
      return [];
    }

    const divs = res.chart.result?.[0]?.events?.dividends;
    if (!divs) return [];

    return Object.values(divs)
      .filter((d) => d && typeof d.amount === 'number' && d.amount > 0 && d.date)
      .map((d) => ({
        exDate: new Date(d.date * 1000).toISOString().slice(0, 10),
        amount: d.amount,
        paymentDate: null,
      }))
      .sort((a, b) => a.exDate.localeCompare(b.exDate));
  }
}
