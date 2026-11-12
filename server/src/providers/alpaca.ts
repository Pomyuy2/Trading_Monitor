import {
  RANGE_RESOLUTION,
  type Candle,
  type CandleSeries,
  type MarketState,
  type Quote,
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

const BASE_DATA = 'https://data.alpaca.markets';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

interface AlpacaBar {
  t: string; // RFC3339 timestamp, e.g. "2026-11-11T14:30:00Z"
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
}

interface AlpacaBarsResponse {
  bars: AlpacaBar[] | null;
  symbol: string;
  next_page_token: string | null;
}

interface AlpacaMultiBarsResponse {
  bars: Record<string, AlpacaBar[]> | null;
  next_page_token: string | null;
}

interface AlpacaTrade {
  t: string;
  p: number;
  s: number;
}

interface AlpacaSnapshot {
  latestTrade?: AlpacaTrade | null;
  latestQuote?: {
    t: string;
    ap: number;
    bp: number;
  } | null;
  minuteBar?: AlpacaBar | null;
  dailyBar?: AlpacaBar | null;
  prevDailyBar?: AlpacaBar | null;
}

interface AlpacaMultiSnapshotResponse {
  [symbol: string]: AlpacaSnapshot;
}

interface RangeConfig {
  timeframe: string;
  durationMs: number;
  feed: 'iex' | 'sip';
  isDailyOrWeekly: boolean;
}

const RANGE_CONFIG: Record<Range, RangeConfig> = {
  '1H': { timeframe: '1Min', durationMs: 3600_000, feed: 'iex', isDailyOrWeekly: false },
  '1D': { timeframe: '5Min', durationMs: 86400_000, feed: 'iex', isDailyOrWeekly: false },
  '1W': { timeframe: '30Min', durationMs: 7 * 86400_000, feed: 'iex', isDailyOrWeekly: false },
  '1M': { timeframe: '1Hour', durationMs: 30 * 86400_000, feed: 'iex', isDailyOrWeekly: false },
  '6M': { timeframe: '1Day', durationMs: 180 * 86400_000, feed: 'sip', isDailyOrWeekly: true },
  '1Y': { timeframe: '1Day', durationMs: 365 * 86400_000, feed: 'sip', isDailyOrWeekly: true },
  '5Y': { timeframe: '1Week', durationMs: 5 * 365 * 86400_000, feed: 'sip', isDailyOrWeekly: true },
};

export class AlpacaProvider extends BaseProvider {
  readonly name = 'Alpaca';
  protected readonly capabilities = new Set<Capability>([
    'dailyCandles',
    'intradayCandles',
    'quote',
  ]);

  constructor(
    private readonly keyId?: string,
    private readonly secretKey?: string,
    private readonly log: Logger = console,
  ) {
    super();
  }

  isAvailable(): boolean {
    return Boolean(this.keyId && this.secretKey);
  }

  private headers(): Record<string, string> {
    if (!this.keyId || !this.secretKey) {
      throw new ProviderAuthError(this.name, 401, 'Missing API credentials');
    }
    return {
      'APCA-API-KEY-ID': this.keyId,
      'APCA-API-SECRET-KEY': this.secretKey,
    };
  }

  private meta(feed: 'iex' | 'consolidated', adjusted: 'split', lastBarTime?: number) {
    return {
      source: this.name,
      updatedAt: new Date().toISOString(),
      feed,
      adjusted,
      latency: feed === 'iex' ? ('realtime' as const) : ('eod' as const),
      marketTime: lastBarTime ? new Date(lastBarTime * 1000).toISOString() : undefined,
    };
  }

  private convertBars(rawBars: AlpacaBar[], isDailyOrWeekly: boolean): Candle[] {
    const candles: Candle[] = [];
    for (const b of rawBars) {
      if (b.c == null || !Number.isFinite(b.c)) continue;
      const rawSec = Math.floor(Date.parse(b.t) / 1000);
      if (!Number.isFinite(rawSec)) continue;

      // Canonicalize daily/weekly bars to UTC midnight (00:00:00 UTC)
      const time = isDailyOrWeekly ? dateToUtcSec(b.t.slice(0, 10)) : rawSec;
      candles.push({
        time,
        open: b.o != null && Number.isFinite(b.o) ? b.o : b.c,
        high: b.h != null && Number.isFinite(b.h) ? b.h : b.c,
        low: b.l != null && Number.isFinite(b.l) ? b.l : b.c,
        close: b.c,
        volume: b.v != null && Number.isFinite(b.v) ? b.v : 0,
      });
    }

    return candles.sort((a, b) => a.time - b.time);
  }

  /**
   * Fetches historical OHLCV bars for a single symbol.
   * Handles pagination up to 5 pages.
   */
  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    const cfg = RANGE_CONFIG[range];
    if (!cfg) throw new NotSupportedError(this.name, `getCandles(${range})`);

    const now = Date.now();
    const startIso = new Date(now - cfg.durationMs).toISOString();

    // On the Basic plan, historical SIP data is restricted to > 15 minutes old.
    // Set `end` safely 16 minutes in the past when querying SIP to prevent HTTP 403.
    const endIso =
      cfg.feed === 'sip'
        ? new Date(now - 16 * 60_000).toISOString()
        : new Date(now).toISOString();

    let pageToken: string | null = null;
    const allBars: AlpacaBar[] = [];
    let pageCount = 0;
    const maxPages = 5;

    do {
      pageCount++;
      const url = new URL(`${BASE_DATA}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
      url.searchParams.set('timeframe', cfg.timeframe);
      url.searchParams.set('start', startIso);
      url.searchParams.set('end', endIso);
      url.searchParams.set('limit', '1000');
      url.searchParams.set('adjustment', 'split');
      url.searchParams.set('feed', cfg.feed);
      if (pageToken) {
        url.searchParams.set('page_token', pageToken);
      }

      let res: AlpacaBarsResponse;
      try {
        res = await getJson<AlpacaBarsResponse>(this.name, url.toString(), this.headers());
      } catch (err) {
        if (err instanceof Error && err.message.includes('404')) {
          throw new NotFoundError(`Symbol ${symbol}`);
        }
        throw err;
      }

      if (res.bars && Array.isArray(res.bars)) {
        allBars.push(...res.bars);
      }
      pageToken = res.next_page_token ?? null;
    } while (pageToken && pageCount < maxPages);

    if (allBars.length === 0) {
      return {
        symbol,
        range,
        resolution: RANGE_RESOLUTION[range],
        candles: [],
        meta: this.meta(cfg.feed === 'sip' ? 'consolidated' : 'iex', 'split'),
      };
    }

    const candles = this.convertBars(allBars, cfg.isDailyOrWeekly);
    const lastBar = candles.length > 0 ? candles[candles.length - 1] : null;

    return {
      symbol,
      range,
      resolution: RANGE_RESOLUTION[range],
      candles,
      meta: this.meta(
        cfg.feed === 'sip' ? 'consolidated' : 'iex',
        'split',
        lastBar?.time,
      ),
    };
  }

  /**
   * Multi-symbol historical bars fetch.
   */
  async getBars(symbols: string[], range: Range): Promise<Record<string, CandleSeries>> {
    if (symbols.length === 0) return {};
    const cfg = RANGE_CONFIG[range];
    if (!cfg) throw new NotSupportedError(this.name, `getBars(${range})`);

    const now = Date.now();
    const startIso = new Date(now - cfg.durationMs).toISOString();
    const endIso =
      cfg.feed === 'sip'
        ? new Date(now - 16 * 60_000).toISOString()
        : new Date(now).toISOString();

    const url = new URL(`${BASE_DATA}/v2/stocks/bars`);
    url.searchParams.set('symbols', symbols.join(','));
    url.searchParams.set('timeframe', cfg.timeframe);
    url.searchParams.set('start', startIso);
    url.searchParams.set('end', endIso);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('adjustment', 'split');
    url.searchParams.set('feed', cfg.feed);

    const res = await getJson<AlpacaMultiBarsResponse>(this.name, url.toString(), this.headers());
    const result: Record<string, CandleSeries> = {};

    const rawMap = res.bars ?? {};
    for (const sym of symbols) {
      const bars = rawMap[sym] ?? [];
      const candles = this.convertBars(bars, cfg.isDailyOrWeekly);
      const lastBar = candles.length > 0 ? candles[candles.length - 1] : null;

      result[sym] = {
        symbol: sym,
        range,
        resolution: RANGE_RESOLUTION[range],
        candles,
        meta: this.meta(
          cfg.feed === 'sip' ? 'consolidated' : 'iex',
          'split',
          lastBar?.time,
        ),
      };
    }

    return result;
  }

  /**
   * Latest snapshot for a single symbol using real-time IEX feed.
   */
  async getQuote(symbol: string): Promise<Quote> {
    const url = `${BASE_DATA}/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=iex`;
    let res: AlpacaSnapshot;
    try {
      res = await getJson<AlpacaSnapshot>(this.name, url, this.headers());
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        throw new NotFoundError(`Symbol ${symbol}`);
      }
      throw err;
    }

    const price = res.latestTrade?.p ?? res.minuteBar?.c ?? res.dailyBar?.c;
    if (price == null || !Number.isFinite(price)) {
      throw new NotFoundError(`Symbol ${symbol}`);
    }

    const prevClose = res.prevDailyBar?.c ?? null;
    const change = prevClose != null ? +(price - prevClose).toFixed(4) : null;
    const changePct =
      prevClose != null && prevClose !== 0
        ? +(((price - prevClose) / prevClose) * 100).toFixed(4)
        : null;

    const ts = res.latestTrade?.t ? Date.parse(res.latestTrade.t) : Date.now();

    return {
      symbol,
      name: null,
      exchange: 'IEX',
      currency: 'USD',
      price,
      change,
      changePct,
      open: res.dailyBar?.o ?? res.minuteBar?.o ?? null,
      high: res.dailyBar?.h ?? null,
      low: res.dailyBar?.l ?? null,
      prevClose,
      volume: res.dailyBar?.v ?? null,
      avgVolume: null,
      marketCap: null,
      peTTM: null,
      week52High: null,
      week52Low: null,
      dividendYield: null,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      marketState: 'open' as MarketState,
      delayed: false, // IEX snapshots are real-time on the Basic plan
      meta: {
        source: this.name,
        updatedAt: new Date().toISOString(),
        feed: 'iex',
        latency: 'realtime',
        marketTime: res.latestTrade?.t ?? undefined,
      },
    };
  }

  /**
   * Multi-symbol latest snapshots via IEX feed.
   */
  async getSnapshots(symbols: string[]): Promise<Record<string, Quote>> {
    if (symbols.length === 0) return {};
    const url = `${BASE_DATA}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=iex`;
    const res = await getJson<AlpacaMultiSnapshotResponse>(this.name, url, this.headers());

    const result: Record<string, Quote> = {};
    for (const [sym, snap] of Object.entries(res)) {
      const price = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c;
      if (price == null) continue;
      const prevClose = snap.prevDailyBar?.c ?? null;
      const change = prevClose != null ? +(price - prevClose).toFixed(4) : null;
      const changePct =
        prevClose != null && prevClose !== 0
          ? +(((price - prevClose) / prevClose) * 100).toFixed(4)
          : null;
      const ts = snap.latestTrade?.t ? Date.parse(snap.latestTrade.t) : Date.now();

      result[sym] = {
        symbol: sym,
        name: null,
        exchange: 'IEX',
        currency: 'USD',
        price,
        change,
        changePct,
        open: snap.dailyBar?.o ?? snap.minuteBar?.o ?? null,
        high: snap.dailyBar?.h ?? null,
        low: snap.dailyBar?.l ?? null,
        prevClose,
        volume: snap.dailyBar?.v ?? null,
        avgVolume: null,
        marketCap: null,
        peTTM: null,
        week52High: null,
        week52Low: null,
        dividendYield: null,
        ts: Number.isFinite(ts) ? ts : Date.now(),
        marketState: 'open' as MarketState,
        delayed: false,
        meta: {
          source: this.name,
          updatedAt: new Date().toISOString(),
          feed: 'iex',
          latency: 'realtime',
          marketTime: snap.latestTrade?.t ?? undefined,
        },
      };
    }

    return result;
  }
}
