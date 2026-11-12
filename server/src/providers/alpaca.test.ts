import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotFoundError,
  ProviderAuthError,
  ProviderServerError,
  ProviderTimeoutError,
  RateLimitError,
} from './types.js';
import { AlpacaProvider } from './alpaca.js';
import { resetRateLimits } from '../lib/http.js';

describe('AlpacaProvider', () => {
  let routes: Array<{ match: RegExp; status?: number; body: string; headers?: Record<string, string> }> = [];
  let interceptedCalls: Array<{ url: string; headers: Record<string, string> }> = [];

  beforeEach(() => {
    resetRateLimits();
    routes = [];
    interceptedCalls = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const reqHeaders = (init?.headers as Record<string, string>) ?? {};
      interceptedCalls.push({ url, headers: reqHeaders });

      const r = routes.find((x) => x.match.test(url));
      if (!r) throw new Error(`Unexpected network call: ${url}`);
      return new Response(r.body, {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports availability based on credentials', () => {
    const unconfigured = new AlpacaProvider();
    expect(unconfigured.isAvailable()).toBe(false);

    const partial = new AlpacaProvider('key-id', '');
    expect(partial.isAvailable()).toBe(false);

    const configured = new AlpacaProvider('test-key-id', 'test-secret-key');
    expect(configured.isAvailable()).toBe(true);
    expect(configured.supports('dailyCandles')).toBe(true);
    expect(configured.supports('intradayCandles')).toBe(true);
    expect(configured.supports('quote')).toBe(true);
    expect(configured.supports('news')).toBe(false);
  });

  it('sends credentials as headers, never in the URL', async () => {
    routes.push({
      match: /v2\/stocks\/AAPL\/snapshot\?feed=iex/,
      body: JSON.stringify({
        latestTrade: { t: '2026-11-11T20:00:00Z', p: 225.5, s: 100 },
        prevDailyBar: { c: 220.0 },
      }),
    });

    const provider = new AlpacaProvider('MY_KEY_ID', 'MY_SECRET_KEY');
    await provider.getQuote('AAPL');

    expect(interceptedCalls).toHaveLength(1);
    const call = interceptedCalls[0];
    expect(call.headers['APCA-API-KEY-ID']).toBe('MY_KEY_ID');
    expect(call.headers['APCA-API-SECRET-KEY']).toBe('MY_SECRET_KEY');
    expect(call.url).not.toContain('MY_KEY_ID');
    expect(call.url).not.toContain('MY_SECRET_KEY');
  });

  it('queries historical daily SIP bars with end safely >15 min in the past and canonicalizes timestamps', async () => {
    routes.push({
      match: /v2\/stocks\/AAPL\/bars\?/,
      body: JSON.stringify({
        bars: [
          {
            t: '2026-11-10T05:00:00Z',
            o: 220,
            h: 225,
            l: 219,
            c: 224,
            v: 45000000,
          },
          {
            t: '2026-11-11T05:00:00Z',
            o: 224,
            h: 228,
            l: 223,
            c: 226,
            v: 50000000,
          },
        ],
        symbol: 'AAPL',
        next_page_token: null,
      }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    const series = await provider.getCandles('AAPL', '1Y');

    expect(series.symbol).toBe('AAPL');
    expect(series.range).toBe('1Y');
    expect(series.resolution).toBe('1day');
    expect(series.candles).toHaveLength(2);

    // Canonical UTC midnight timestamps
    expect(series.candles[0].time).toBe(Math.floor(Date.parse('2026-11-10T00:00:00Z') / 1000));
    expect(series.candles[1].time).toBe(Math.floor(Date.parse('2026-11-11T00:00:00Z') / 1000));

    // Provenance verification
    expect(series.meta.source).toBe('Alpaca');
    expect(series.meta.feed).toBe('consolidated');
    expect(series.meta.adjusted).toBe('split');
    expect(series.meta.latency).toBe('eod');

    // Safe end window verification (> 15m old for SIP)
    const url = new URL(interceptedCalls[0].url);
    expect(url.searchParams.get('feed')).toBe('sip');
    expect(url.searchParams.get('adjustment')).toBe('split');
    const endMs = Date.parse(url.searchParams.get('end')!);
    const nowMs = Date.now();
    expect(nowMs - endMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('queries intraday bars with real-time IEX feed up to the current minute', async () => {
    routes.push({
      match: /v2\/stocks\/MSFT\/bars\?/,
      body: JSON.stringify({
        bars: [
          {
            t: '2026-11-11T14:30:00Z',
            o: 420,
            h: 422,
            l: 419,
            c: 421.5,
            v: 12000,
          },
        ],
        symbol: 'MSFT',
        next_page_token: null,
      }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    const series = await provider.getCandles('MSFT', '1D');

    expect(series.symbol).toBe('MSFT');
    expect(series.range).toBe('1D');
    expect(series.resolution).toBe('5min');
    expect(series.candles).toHaveLength(1);
    expect(series.candles[0].time).toBe(Math.floor(Date.parse('2026-11-11T14:30:00Z') / 1000));

    expect(series.meta.feed).toBe('iex');
    expect(series.meta.latency).toBe('realtime');
    expect(series.meta.adjusted).toBe('split');

    const url = new URL(interceptedCalls[0].url);
    expect(url.searchParams.get('feed')).toBe('iex');
    expect(url.searchParams.get('timeframe')).toBe('5Min');
  });

  it('handles multi-page pagination seamlessly', async () => {
    routes.push({
      match: {
        test: (u: string) => u.includes('/NVDA/bars') && u.includes('page_token=page_two_token'),
      } as RegExp,
      body: JSON.stringify({
        bars: [{ t: '2026-11-10T14:05:00Z', o: 130.5, h: 132, l: 130, c: 131.5, v: 7000 }],
        symbol: 'NVDA',
        next_page_token: null,
      }),
    });
    routes.push({
      match: {
        test: (u: string) => u.includes('/NVDA/bars') && !u.includes('page_token'),
      } as RegExp,
      body: JSON.stringify({
        bars: [{ t: '2026-11-10T14:00:00Z', o: 130, h: 131, l: 129, c: 130.5, v: 5000 }],
        symbol: 'NVDA',
        next_page_token: 'page_two_token',
      }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    const series = await provider.getCandles('NVDA', '1D');

    expect(series.candles).toHaveLength(2);
    expect(interceptedCalls).toHaveLength(2);
    expect(series.candles[0].close).toBe(130.5);
    expect(series.candles[1].close).toBe(131.5);
  });

  it('fetches multi-symbol bars efficiently', async () => {
    routes.push({
      match: /v2\/stocks\/bars\?symbols=AAPL%2CMSFT/,
      body: JSON.stringify({
        bars: {
          AAPL: [{ t: '2026-11-11T14:30:00Z', o: 220, h: 225, l: 219, c: 224, v: 10000 }],
          MSFT: [{ t: '2026-11-11T14:30:00Z', o: 420, h: 422, l: 419, c: 421, v: 8000 }],
        },
      }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    const map = await provider.getBars(['AAPL', 'MSFT'], '1D');

    expect(map['AAPL']).toBeDefined();
    expect(map['MSFT']).toBeDefined();
    expect(map['AAPL'].candles[0].close).toBe(224);
    expect(map['MSFT'].candles[0].close).toBe(421);
  });

  it('maps real-time IEX snapshot to Quote structure', async () => {
    routes.push({
      match: /v2\/stocks\/TSLA\/snapshot\?feed=iex/,
      body: JSON.stringify({
        latestTrade: { t: '2026-11-11T19:55:00Z', p: 255.4, s: 200 },
        minuteBar: { t: '2026-11-11T19:55:00Z', o: 255.0, h: 255.6, l: 254.8, c: 255.4, v: 5000 },
        dailyBar: { t: '2026-11-11T05:00:00Z', o: 250.0, h: 257.0, l: 249.5, c: 255.4, v: 65000000 },
        prevDailyBar: { t: '2026-11-10T05:00:00Z', o: 245.0, h: 251.0, l: 244.0, c: 250.0, v: 70000000 },
      }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    const q = await provider.getQuote('TSLA');

    expect(q.symbol).toBe('TSLA');
    expect(q.price).toBe(255.4);
    expect(q.prevClose).toBe(250.0);
    expect(q.change).toBe(5.4);
    expect(q.changePct).toBe(2.16);
    expect(q.open).toBe(250.0);
    expect(q.high).toBe(257.0);
    expect(q.low).toBe(249.5);
    expect(q.volume).toBe(65000000);
    expect(q.delayed).toBe(false);
    expect(q.meta.source).toBe('Alpaca');
    expect(q.meta.feed).toBe('iex');
    expect(q.meta.latency).toBe('realtime');
  });

  it('maps multi-symbol snapshots dictionary', async () => {
    routes.push({
      match: /v2\/stocks\/snapshots\?symbols=AAPL%2CMSFT&feed=iex/,
      body: JSON.stringify({
        AAPL: {
          latestTrade: { t: '2026-11-11T19:55:00Z', p: 225.0, s: 100 },
          prevDailyBar: { c: 220.0 },
        },
        MSFT: {
          latestTrade: { t: '2026-11-11T19:55:00Z', p: 425.0, s: 50 },
          prevDailyBar: { c: 420.0 },
        },
      }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    const map = await provider.getSnapshots(['AAPL', 'MSFT']);

    expect(map['AAPL']?.price).toBe(225.0);
    expect(map['AAPL']?.change).toBe(5.0);
    expect(map['MSFT']?.price).toBe(425.0);
    expect(map['MSFT']?.change).toBe(5.0);
  });

  it('classifies HTTP 403 (unauthorized or restricted SIP) as ProviderAuthError', async () => {
    routes.push({
      match: /v2\/stocks\/AAPL\/snapshot/,
      status: 403,
      body: JSON.stringify({ message: 'subscription does not permit querying recent SIP data' }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    await expect(provider.getQuote('AAPL')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('classifies HTTP 429 as RateLimitError', async () => {
    routes.push({
      match: /v2\/stocks\/AAPL\/bars/,
      status: 429,
      body: JSON.stringify({ message: 'too many requests' }),
      headers: { 'retry-after': '30' },
    });

    const provider = new AlpacaProvider('key', 'sec');
    await expect(provider.getCandles('AAPL', '1D')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('classifies HTTP 500 as ProviderServerError', async () => {
    routes.push({
      match: /v2\/stocks\/AAPL\/bars/,
      status: 500,
      body: JSON.stringify({ message: 'internal server error' }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    await expect(provider.getCandles('AAPL', '1D')).rejects.toBeInstanceOf(ProviderServerError);
  });

  it('classifies HTTP 404 as NotFoundError', async () => {
    routes.push({
      match: /v2\/stocks\/UNKNOWN\/bars/,
      status: 404,
      body: JSON.stringify({ message: 'symbol not found' }),
    });

    const provider = new AlpacaProvider('key', 'sec');
    await expect(provider.getCandles('UNKNOWN', '1D')).rejects.toBeInstanceOf(NotFoundError);
  });
});
