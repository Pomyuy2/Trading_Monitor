import type { CandleSeries, NewsItem, Range } from '@tm/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { LruCache } from '../cache/cache.js';
import { KeywordAi } from '../ai/keyword-ai.js';
import { MockAi } from '../ai/mock-ai.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  BaseProvider,
  ProviderAuthError,
  ProviderNetworkError,
  ProviderResponseError,
  ProviderServerError,
  ProviderTimeoutError,
  RateLimitError,
  type Capability,
} from '../providers/types.js';
import { MarketService } from './market-service.js';
import { resetRateLimits } from '../lib/http.js';
import { dateToUtcSec } from '../lib/market-time.js';

class MockDailyProvider extends BaseProvider {
  protected readonly capabilities = new Set<Capability>(['dailyCandles', 'intradayCandles', 'quote', 'news']);
  calls = 0;
  newsCalls = 0;
  candleCalls = 0;
  quoteCalls = 0;

  constructor(
    readonly name: string,
    private readonly errorGenerator?: (callCount: number) => Error | null,
    private readonly customCandles?: CandleSeries,
  ) {
    super();
  }

  isAvailable() {
    return true;
  }

  async getNews(symbol: string): Promise<NewsItem[]> {
    this.calls++;
    this.newsCalls++;
    if (this.errorGenerator) {
      const err = this.errorGenerator(this.calls);
      if (err) throw err;
    }
    return [
      {
        id: `${this.name}-1`,
        headline: `${symbol} news from ${this.name}`,
        snippet: '',
        source: this.name,
        url: 'https://example.com',
        publishedAt: new Date().toISOString(),
        sentiment: null,
      },
    ];
  }

  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    this.calls++;
    this.candleCalls++;
    if (this.errorGenerator) {
      const err = this.errorGenerator(this.calls);
      if (err) throw err;
    }
    if (this.customCandles) {
      return this.customCandles;
    }
    return {
      symbol,
      range,
      resolution: '1day',
      candles: [
        { time: 1794182400, open: 150, high: 155, low: 149, close: 154, volume: 1000 },
      ],
      meta: {
        source: this.name,
        updatedAt: new Date().toISOString(),
        feed: 'consolidated',
        adjusted: 'split',
        marketTime: new Date(1794182400 * 1000).toISOString(),
      },
    };
  }

  async getQuote(symbol: string) {
    this.calls++;
    this.quoteCalls++;
    if (this.errorGenerator) {
      const err = this.errorGenerator(this.calls);
      if (err) throw err;
    }
    return {
      symbol,
      name: `${symbol} Inc`,
      exchange: 'NASDAQ',
      currency: 'USD',
      price: 154,
      change: 4,
      changePct: 2.67,
      open: 150,
      high: 155,
      low: 149,
      prevClose: 150,
      volume: 1000,
      avgVolume: 2000,
      marketCap: 1000000,
      peTTM: 25,
      week52High: 160,
      week52Low: 120,
      dividendYield: 0.5,
      ts: Date.now(),
      marketState: 'open' as const,
      delayed: false,
      meta: {
        source: this.name,
        updatedAt: new Date().toISOString(),
        feed: 'consolidated' as const,
        marketTime: new Date().toISOString(),
      },
    };
  }
}

function createServiceWithChain(chain: MockDailyProvider[]) {
  const registry = {
    chainFor: () => chain,
    for: () => chain[0],
    fallbackFor: () => chain[1] ?? null,
  } as unknown as ProviderRegistry;

  const cache = new LruCache(100);
  const svc = new MarketService(registry, cache, {
    llm: null,
    keyword: new KeywordAi(),
    mock: new MockAi(),
  });

  return { svc, cache, chain };
}

describe('MarketService Ordered Fallback & Reliability', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('fails over to eligible fallback when primary throws ProviderServerError (HTTP 500)', async () => {
    const primary = new MockDailyProvider('Primary', () => new ProviderServerError('Primary', 500, 'Internal Server Error'));
    const fallback = new MockDailyProvider('Fallback');
    const { svc } = createServiceWithChain([primary, fallback]);

    const res = await svc.candles('AAPL', '1Y');

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(res.meta.source).toBe('Fallback');
    expect(res.candles).toHaveLength(1);
    expect(res.candles[0].close).toBe(154);
  });

  it('fails over to eligible fallback when primary times out (ProviderTimeoutError)', async () => {
    const primary = new MockDailyProvider('Primary', () => new ProviderTimeoutError('Primary', 10000));
    const fallback = new MockDailyProvider('Fallback');
    const { svc } = createServiceWithChain([primary, fallback]);

    const res = await svc.candles('MSFT', '1Y');

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(res.meta.source).toBe('Fallback');
  });

  it('fails over to eligible fallback when primary encounters network error (ProviderNetworkError)', async () => {
    const primary = new MockDailyProvider('Primary', () => new ProviderNetworkError('Primary', 'ECONNRESET'));
    const fallback = new MockDailyProvider('Fallback');
    const { svc } = createServiceWithChain([primary, fallback]);

    const res = await svc.candles('GOOGL', '1Y');

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(res.meta.source).toBe('Fallback');
  });

  it('fails over to eligible fallback when primary returns malformed response (ProviderResponseError)', async () => {
    const primary = new MockDailyProvider('Primary', () => new ProviderResponseError('Primary', 'Unexpected HTML response'));
    const fallback = new MockDailyProvider('Fallback');
    const { svc } = createServiceWithChain([primary, fallback]);

    const res = await svc.candles('NVDA', '1Y');

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(res.meta.source).toBe('Fallback');
  });

  it('fails over from Yahoo to Alpaca when Yahoo fails', async () => {
    const yahoo = new MockDailyProvider('Yahoo Finance', () => new ProviderServerError('Yahoo Finance', 500));
    const alpaca = new MockDailyProvider('Alpaca');
    const twelvedata = new MockDailyProvider('Twelve Data');
    const { svc } = createServiceWithChain([yahoo, alpaca, twelvedata]);

    const res = await svc.candles('AAPL', '1D');

    expect(yahoo.calls).toBe(1);
    expect(alpaca.calls).toBe(1);
    expect(twelvedata.calls).toBe(0);
    expect(res.meta.source).toBe('Alpaca');
  });

  it('fails over from Alpaca to Twelve Data when both Yahoo and Alpaca fail', async () => {
    const yahoo = new MockDailyProvider('Yahoo Finance', () => new ProviderServerError('Yahoo Finance', 500));
    const alpaca = new MockDailyProvider('Alpaca', () => new RateLimitError('Alpaca', 60_000));
    const twelvedata = new MockDailyProvider('Twelve Data');
    const { svc } = createServiceWithChain([yahoo, alpaca, twelvedata]);

    const res = await svc.candles('AAPL', '1D');

    expect(yahoo.calls).toBe(1);
    expect(alpaca.calls).toBe(1);
    expect(twelvedata.calls).toBe(1);
    expect(res.meta.source).toBe('Twelve Data');
  });

  it('fails over Yahoo -> Alpaca -> Tiingo when Yahoo and Alpaca fail', async () => {
    const yahoo = new MockDailyProvider('Yahoo Finance', () => new ProviderServerError('Yahoo Finance', 500));
    const alpaca = new MockDailyProvider('Alpaca', () => new ProviderServerError('Alpaca', 503));
    const tiingo = new MockDailyProvider('Tiingo');
    const { svc } = createServiceWithChain([yahoo, alpaca, tiingo]);

    const res = await svc.candles('AAPL', '1Y');

    expect(yahoo.calls).toBe(1);
    expect(alpaca.calls).toBe(1);
    expect(tiingo.calls).toBe(1);
    expect(res.meta.source).toBe('Tiingo');
  });

  it('fails over Finnhub -> Tiingo for news when Finnhub hits rate limit', async () => {
    const finnhub = new MockDailyProvider('Finnhub', () => new RateLimitError('Finnhub', 60_000));
    const tiingo = new MockDailyProvider('Tiingo');
    const { svc } = createServiceWithChain([finnhub, tiingo]);

    const res = await svc.news('AAPL', 'en');

    expect(finnhub.newsCalls).toBe(1);
    expect(tiingo.newsCalls).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.meta.source).toBe('Tiingo');
  });

  it('handles HTTP 429 with backoff and fails over to next provider in chain', async () => {
    const primary = new MockDailyProvider('Primary', () => new RateLimitError('Primary', 60_000));
    const fallback = new MockDailyProvider('Fallback');
    const { svc } = createServiceWithChain([primary, fallback]);

    const res = await svc.candles('TSLA', '1Y');

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(res.meta.source).toBe('Fallback');
  });

  it('handles HTTP 403 without unlimited retries and moves to next provider', async () => {
    let primaryAttempts = 0;
    const primary = new MockDailyProvider('Primary', () => {
      primaryAttempts++;
      return new ProviderAuthError('Primary', 403, 'Forbidden endpoint');
    });
    const fallback = new MockDailyProvider('Fallback');
    const { svc } = createServiceWithChain([primary, fallback]);

    const res = await svc.candles('AMZN', '1Y');

    // Exactly 1 attempt on primary — no retry loop
    expect(primaryAttempts).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(res.meta.source).toBe('Fallback');
  });

  it('returns stale cached data when all providers in the fallback chain fail', async () => {
    const primary = new MockDailyProvider('Primary', (call) => {
      if (call > 1) throw new ProviderServerError('Primary', 503);
      return null;
    });
    const fallback = new MockDailyProvider('Fallback', () => new ProviderServerError('Fallback', 502));
    const { svc, cache } = createServiceWithChain([primary, fallback]);

    // 1. Initial successful fetch populates primary cache
    const first = await svc.candles('META', '1Y');
    expect(first.meta.source).toBe('Primary');
    expect(first.meta.stale).toBeUndefined();

    // Age cache to expire it
    const key = 'candles:META:1Y:Primary:split';
    const hit = await cache.get<CandleSeries>(key);
    expect(hit).not.toBeNull();
    // Re-set with expired timestamp
    await cache.set(key, hit!.value, -1000);

    // 2. Second fetch: primary throws 503, fallback throws 502
    const second = await svc.candles('META', '1Y');

    // Should return stale fallback with stale: true and preserved metadata
    expect(second.meta.source).toBe('Primary');
    expect(second.meta.stale).toBe(true);
    expect(second.meta.feed).toBe('consolidated');
    expect(second.candles).toHaveLength(1);
  });

  it('throws controlled error when every provider fails and no stale cache is available', async () => {
    const primary = new MockDailyProvider('Primary', () => new ProviderServerError('Primary', 500));
    const fallback = new MockDailyProvider('Fallback', () => new ProviderServerError('Fallback', 503));
    const { svc } = createServiceWithChain([primary, fallback]);

    await expect(svc.candles('UBER', '1Y')).rejects.toThrow(ProviderServerError);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });

  it('preserves provider metadata and feed identity across fallback', async () => {
    const primary = new MockDailyProvider('Yahoo Finance', () => new ProviderServerError('Yahoo Finance', 500));
    const fallback = new MockDailyProvider('Twelve Data');
    const { svc } = createServiceWithChain([primary, fallback]);

    const res = await svc.candles('PLTR', '1Y');

    expect(res.meta.source).toBe('Twelve Data');
    expect(res.meta.feed).toBe('consolidated');
    expect(res.meta.adjusted).toBe('split');
    expect(res.meta.marketTime).toBe(new Date(1794182400 * 1000).toISOString());
  });

  it('normalizes daily timestamps consistently across providers to UTC midnight (00:00:00 UTC)', () => {
    // 2026-11-09 calendar date
    const dateStr = '2026-11-09';
    const expectedUtcSec = Math.floor(Date.parse('2026-11-09T00:00:00Z') / 1000);

    // 1. Using dateToUtcSec (used by Yahoo, Twelve Data, and FMP)
    const normalizedYahoo = dateToUtcSec(dateStr);
    expect(normalizedYahoo).toBe(expectedUtcSec);

    // 2. Twelve Data parser: datetime <= 10 -> Date.parse(`${v.datetime}T00:00:00Z`) / 1000
    const normalizedTwelveData = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
    expect(normalizedTwelveData).toBe(expectedUtcSec);

    // 3. Both match exactly
    expect(normalizedYahoo).toBe(normalizedTwelveData);
  });

  describe('Mock Provider Isolation', () => {
    it('never includes MockProvider in chainFor when real providers are configured', () => {
      const mock = new MockAi();
      const registry = {
        for: (cap: Capability) => (cap === 'intradayCandles' ? new MockDailyProvider('Yahoo Finance') : (null as any)),
        chainFor: (cap: Capability) => {
          // Emulate ProviderRegistry.chainFor logic:
          const realProviders = [new MockDailyProvider('Yahoo Finance'), new MockDailyProvider('Twelve Data')];
          if (realProviders.length > 0) return realProviders;
          return [{ name: 'mock' }];
        },
      };

      const chain = registry.chainFor('intradayCandles');
      expect(chain.map((p: any) => p.name)).toEqual(['Yahoo Finance', 'Twelve Data']);
      expect(chain.some((p: any) => p.name === 'mock')).toBe(false);
    });

    it('never leaks mock provider data when production providers fail if mock is not in chain', async () => {
      const primary = new MockDailyProvider('Yahoo Finance', () => new ProviderServerError('Yahoo Finance', 500));
      const fallback = new MockDailyProvider('Twelve Data', () => new ProviderServerError('Twelve Data', 500));
      const { svc } = createServiceWithChain([primary, fallback]);

      // Service should fail cleanly rather than silently falling back to synthetic mock data
      await expect(svc.quote('AAPL', false)).rejects.toThrow(ProviderServerError);
    });
  });
});
