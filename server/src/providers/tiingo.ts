import {
  RANGE_RESOLUTION,
  type Candle,
  type CandleSeries,
  type NewsItem,
  type Range,
} from '@tm/shared';
import { getJson } from '../lib/http.js';
import { dateToUtcSec } from '../lib/market-time.js';
import {
  BaseProvider,
  NotFoundError,
  NotSupportedError,
  ProviderAuthError,
  type Capability,
} from './types.js';

const BASE_API = 'https://api.tiingo.com';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface TiingoPriceRow {
  date: string; // e.g. "2026-11-10T00:00:00.000Z"
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  adjClose: number;
  adjHigh: number;
  adjLow: number;
  adjOpen: number;
  adjVolume: number;
  divCash?: number;
  splitFactor?: number;
}

export interface TiingoNewsRow {
  id: number;
  title: string;
  url: string;
  description?: string;
  publishedDate: string;
  source?: string;
  tickers?: string[];
  tags?: string[];
}

export interface TiingoTickerMeta {
  ticker: string;
  name: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  exchangeCode?: string;
}

const RANGE_DAYS: Partial<Record<Range, number>> = {
  '6M': 180,
  '1Y': 365,
  '5Y': 5 * 365,
};

export class TiingoProvider extends BaseProvider {
  readonly name = 'Tiingo';
  protected readonly capabilities = new Set<Capability>(['dailyCandles', 'news']);

  constructor(
    private readonly apiKey?: string,
    private readonly log: Logger = console,
  ) {
    super();
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) {
      throw new ProviderAuthError(this.name, 401, 'Missing TIINGO_API_KEY');
    }
    return {
      Authorization: `Token ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private meta(note?: string, lastBarTime?: number) {
    return {
      source: this.name,
      updatedAt: new Date().toISOString(),
      feed: 'eod' as const,
      adjusted: 'all' as const, // Tiingo adj* applies both split and cash dividend adjustments
      latency: 'eod' as const,
      marketTime: lastBarTime ? new Date(lastBarTime * 1000).toISOString() : undefined,
      ...(note ? { note } : {}),
    };
  }

  /**
   * Fetches historical daily/weekly OHLCV candles.
   */
  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    const days = RANGE_DAYS[range];
    if (!days) {
      throw new NotSupportedError(this.name, `getCandles(${range}) — Tiingo EOD only supports 6M, 1Y, 5Y`);
    }

    const start = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const resampleFreq = range === '5Y' ? 'weekly' : 'daily';
    const url = `${BASE_API}/tiingo/daily/${encodeURIComponent(symbol)}/prices?startDate=${start}&resampleFreq=${resampleFreq}`;

    let rows: TiingoPriceRow[];
    try {
      rows = await getJson<TiingoPriceRow[]>(this.name, url, this.headers());
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw err;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        symbol,
        range,
        resolution: range === '5Y' ? '1week' : '1day',
        candles: [],
        meta: this.meta('No data returned for symbol'),
      };
    }

    const candles: Candle[] = rows
      .map((r) => {
        const time = dateToUtcSec(r.date.slice(0, 10));
        const close = r.adjClose != null && Number.isFinite(r.adjClose) ? r.adjClose : r.close;
        const open = r.adjOpen != null && Number.isFinite(r.adjOpen) ? r.adjOpen : r.open ?? close;
        const high = r.adjHigh != null && Number.isFinite(r.adjHigh) ? r.adjHigh : r.high ?? close;
        const low = r.adjLow != null && Number.isFinite(r.adjLow) ? r.adjLow : r.low ?? close;
        const volume = r.adjVolume != null && Number.isFinite(r.adjVolume) ? r.adjVolume : r.volume ?? 0;

        return { time, open, high, low, close, volume };
      })
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);

    const lastBar = candles.length > 0 ? candles[candles.length - 1] : null;

    return {
      symbol,
      range,
      resolution: range === '5Y' ? '1week' : '1day',
      candles,
      meta: this.meta(undefined, lastBar?.time),
    };
  }

  /**
   * Fetches financial news tagged with the requested ticker.
   */
  async getNews(symbol: string, fromMs: number, toMs: number): Promise<NewsItem[]> {
    const startStr = new Date(fromMs).toISOString().slice(0, 10);
    const endStr = new Date(toMs).toISOString().slice(0, 10);
    const url = `${BASE_API}/tiingo/news?tickers=${encodeURIComponent(symbol)}&startDate=${startStr}&endDate=${endStr}&limit=50`;

    let rows: TiingoNewsRow[];
    try {
      rows = await getJson<TiingoNewsRow[]>(this.name, url, this.headers());
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        return [];
      }
      throw err;
    }

    if (!Array.isArray(rows)) return [];

    return rows.map((r) => ({
      id: String(r.id),
      headline: r.title,
      snippet: r.description ?? '',
      source: r.source || 'Tiingo',
      url: r.url,
      publishedAt: r.publishedDate,
      sentiment: null,
    }));
  }

  /**
   * Optional ticker metadata lookup.
   */
  async getTicker(symbol: string): Promise<TiingoTickerMeta> {
    const url = `${BASE_API}/tiingo/daily/${encodeURIComponent(symbol)}`;
    try {
      return await getJson<TiingoTickerMeta>(this.name, url, this.headers());
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw err;
    }
  }
}
