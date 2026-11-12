import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotFoundError,
  NotSupportedError,
  ProviderAuthError,
  ProviderServerError,
  RateLimitError,
} from './types.js';
import { TiingoProvider } from './tiingo.js';
import { resetRateLimits } from '../lib/http.js';

describe('TiingoProvider', () => {
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

  it('reports availability based on API key presence', () => {
    const unconfigured = new TiingoProvider();
    expect(unconfigured.isAvailable()).toBe(false);

    const configured = new TiingoProvider('test-tiingo-token');
    expect(configured.isAvailable()).toBe(true);
    expect(configured.supports('dailyCandles')).toBe(true);
    expect(configured.supports('news')).toBe(true);
    expect(configured.supports('quote')).toBe(false);
    expect(configured.supports('intradayCandles')).toBe(false);
  });

  it('sends Authorization Token header and never leaks the key into the URL', async () => {
    routes.push({
      match: /tiingo\/daily\/AAPL\/prices/,
      body: JSON.stringify([
        {
          date: '2026-11-10T00:00:00.000Z',
          close: 220.0,
          high: 222.0,
          low: 219.0,
          open: 220.5,
          volume: 40000000,
          adjClose: 220.0,
          adjHigh: 222.0,
          adjLow: 219.0,
          adjOpen: 220.5,
          adjVolume: 40000000,
        },
      ]),
    });

    const provider = new TiingoProvider('SECRET_TIINGO_KEY');
    await provider.getCandles('AAPL', '1Y');

    expect(interceptedCalls).toHaveLength(1);
    const call = interceptedCalls[0];
    expect(call.headers['Authorization']).toBe('Token SECRET_TIINGO_KEY');
    expect(call.url).not.toContain('SECRET_TIINGO_KEY');
  });

  it('maps daily candles with split- and dividend-adjusted semantics and canonicalizes to UTC midnight', async () => {
    routes.push({
      match: /tiingo\/daily\/MSFT\/prices\?startDate=.*&resampleFreq=daily/,
      body: JSON.stringify([
        {
          date: '2026-11-09T00:00:00.000Z',
          close: 420.0,
          high: 424.0,
          low: 418.0,
          open: 421.0,
          volume: 20000000,
          adjClose: 415.5, // cash dividend adjusted
          adjHigh: 419.5,
          adjLow: 413.5,
          adjOpen: 416.5,
          adjVolume: 20000000,
        },
        {
          date: '2026-11-10T00:00:00.000Z',
          close: 425.0,
          high: 428.0,
          low: 423.0,
          open: 424.0,
          volume: 25000000,
          adjClose: 420.5,
          adjHigh: 423.5,
          adjLow: 418.5,
          adjOpen: 419.5,
          adjVolume: 25000000,
        },
      ]),
    });

    const provider = new TiingoProvider('key');
    const series = await provider.getCandles('MSFT', '1Y');

    expect(series.symbol).toBe('MSFT');
    expect(series.range).toBe('1Y');
    expect(series.resolution).toBe('1day');
    expect(series.candles).toHaveLength(2);

    // Verify canonical UTC midnight timestamps
    expect(series.candles[0].time).toBe(Math.floor(Date.parse('2026-11-09T00:00:00Z') / 1000));
    expect(series.candles[1].time).toBe(Math.floor(Date.parse('2026-11-10T00:00:00Z') / 1000));

    // Verify adjusted OHLC mapping
    expect(series.candles[0].close).toBe(415.5);
    expect(series.candles[0].open).toBe(416.5);
    expect(series.candles[1].close).toBe(420.5);

    // Verify metadata provenance
    expect(series.meta.source).toBe('Tiingo');
    expect(series.meta.feed).toBe('eod');
    expect(series.meta.adjusted).toBe('all');
    expect(series.meta.latency).toBe('eod');
  });

  it('rejects unsupported intraday ranges with NotSupportedError', async () => {
    const provider = new TiingoProvider('key');
    await expect(provider.getCandles('AAPL', '1D')).rejects.toBeInstanceOf(NotSupportedError);
    await expect(provider.getCandles('AAPL', '1H')).rejects.toBeInstanceOf(NotSupportedError);
  });

  it('maps financial news rows to NewsItem format', async () => {
    routes.push({
      match: /tiingo\/news\?tickers=AAPL/,
      body: JSON.stringify([
        {
          id: 98765432,
          title: 'Apple releases new hardware lineup',
          description: 'Apple Inc announced its latest generation of devices today.',
          publishedDate: '2026-11-11T16:00:00Z',
          source: 'Bloomberg',
          url: 'https://example.com/apple-news-1',
          tickers: ['aapl'],
        },
      ]),
    });

    const provider = new TiingoProvider('key');
    const news = await provider.getNews('AAPL', Date.now() - 3 * 86400_000, Date.now());

    expect(news).toHaveLength(1);
    expect(news[0]).toEqual({
      id: '98765432',
      headline: 'Apple releases new hardware lineup',
      snippet: 'Apple Inc announced its latest generation of devices today.',
      source: 'Bloomberg',
      url: 'https://example.com/apple-news-1',
      publishedAt: '2026-11-11T16:00:00Z',
      sentiment: null,
    });
  });

  it('classifies HTTP 401 as ProviderAuthError', async () => {
    routes.push({
      match: /tiingo\/daily\/AAPL\/prices/,
      status: 401,
      body: JSON.stringify({ detail: 'Error: Unauthorized.' }),
    });

    const provider = new TiingoProvider('invalid-key');
    await expect(provider.getCandles('AAPL', '1Y')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('classifies HTTP 429 as RateLimitError', async () => {
    routes.push({
      match: /tiingo\/daily\/AAPL\/prices/,
      status: 429,
      body: JSON.stringify({ detail: 'Error: Rate limit reached.' }),
      headers: { 'retry-after': '60' },
    });

    const provider = new TiingoProvider('key');
    await expect(provider.getCandles('AAPL', '1Y')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('classifies HTTP 500 as ProviderServerError', async () => {
    routes.push({
      match: /tiingo\/daily\/AAPL\/prices/,
      status: 500,
      body: JSON.stringify({ detail: 'Internal server error' }),
    });

    const provider = new TiingoProvider('key');
    await expect(provider.getCandles('AAPL', '1Y')).rejects.toBeInstanceOf(ProviderServerError);
  });

  it('classifies 404 as NotFoundError', async () => {
    routes.push({
      match: /tiingo\/daily\/BADSYMBOL\/prices/,
      status: 404,
      body: JSON.stringify({ detail: 'Not found.' }),
    });

    const provider = new TiingoProvider('key');
    await expect(provider.getCandles('BADSYMBOL', '1Y')).rejects.toBeInstanceOf(NotFoundError);
  });
});
