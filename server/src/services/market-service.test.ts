import type { CandleSeries, NewsItem, Range } from '@tm/shared';
import type { AiService } from '../ai/ai-service.js';
import { describe, expect, it, vi } from 'vitest';
import { LruCache } from '../cache/cache.js';
import { KeywordAi } from '../ai/keyword-ai.js';
import { MockAi } from '../ai/mock-ai.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BaseProvider, ProviderAuthError, RateLimitError, type Capability } from '../providers/types.js';
import { MarketService, NOT_IN_PLAN } from './market-service.js';

/** A provider whose daily candles either work or are refused by the plan. */
class FakeDaily extends BaseProvider {
  protected readonly capabilities = new Set<Capability>(['dailyCandles', 'estimates', 'priceTargets', 'ratings', 'earningsCalendar', 'profile']);
  calls = 0;
  constructor(readonly name: string, private readonly refuse: boolean, private readonly error?: Error) {
    super();
  }
  isAvailable() {
    return true;
  }
  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    this.calls++;
    if (this.error) throw this.error;
    if (this.refuse) throw new ProviderAuthError(this.name, 402);
    const candles = Array.from({ length: 40 }, (_, i) => ({ time: 1_790_000_000 + i * 86400, open: 10, high: 11, low: 9, close: 10 + i, volume: 1 }));
    return { symbol, range, resolution: '1day', candles, meta: { source: this.name, updatedAt: new Date().toISOString() } };
  }
  async getEstimates(): Promise<never> {
    throw new ProviderAuthError(this.name, 402);
  }
}

function service(primary: FakeDaily, fallback: FakeDaily | null) {
  const registry = {
    for: () => primary,
    fallbackFor: () => fallback,
  } as unknown as ProviderRegistry;
  return new MarketService(registry, new LruCache(), { llm: null, keyword: new KeywordAi(), mock: new MockAi() });
}

describe('provider fallback (free plan refuses a symbol)', () => {
  it('serves daily candles from the fallback when the main provider says "not in your plan"', async () => {
    const fmp = new FakeDaily('FMP', true);
    const td = new FakeDaily('Twelve Data', false);
    const s = await service(fmp, td).candles('RKLB', '1Y');
    expect(s.meta.source).toBe('Twelve Data');
    expect(s.candles).toHaveLength(40);
    expect(fmp.calls).toBe(1);
    expect(td.calls).toBe(1);
  });

  it('also uses the fallback when the main provider\'s daily call allowance is used up', async () => {
    const fmp = new FakeDaily('FMP', false, new RateLimitError('FMP', 60_000));
    const td = new FakeDaily('Twelve Data', false);
    const s = await service(fmp, td).candles('AAPL', '1Y');
    expect(s.meta.source).toBe('Twelve Data');
    expect(fmp.calls).toBe(1); // no inline retry for a long wait
  });

  it('does not use the fallback for other errors (e.g. provider down)', async () => {
    const fmp = new FakeDaily('FMP', false, new Error('HTTP 500'));
    const td = new FakeDaily('Twelve Data', false);
    await expect(service(fmp, td).candles('AAPL', '1Y')).rejects.toThrow('HTTP 500');
    expect(td.calls).toBe(0);
  });

  it('builds sparklines (last ~22 closes) through the same fallback', async () => {
    const s = await service(new FakeDaily('FMP', true), new FakeDaily('Twelve Data', false)).sparkline('FLNC');
    expect(s.points).toHaveLength(22);
    expect(s.points.at(-1)?.close).toBe(49);
    expect(s.meta.source).toBe('Twelve Data');
  });

  it('remembers a plan refusal for extra quote stats instead of asking on every refresh', async () => {
    class QuoteOnly extends FakeDaily {
      async getQuote(symbol: string) {
        return { symbol, name: null, exchange: null, currency: 'USD', price: 10, change: 0, changePct: 0, open: null, high: null, low: null, prevClose: 10, volume: null, avgVolume: null, marketCap: null, peTTM: null, week52High: null, week52Low: null, dividendYield: null, ts: Date.now(), marketState: 'open' as const, delayed: false, meta: { source: 'Q', updatedAt: '' } };
      }
    }
    class StatsRefused extends FakeDaily {
      statsCalls = 0;
      async getKeyStats(): Promise<never> {
        this.statsCalls++;
        throw new ProviderAuthError('FMP', 402);
      }
    }
    const q = new QuoteOnly('Finnhub', false);
    const fmp = new StatsRefused('FMP', true);
    const registry = { for: (cap: Capability) => (cap === 'keyStats' ? fmp : q), fallbackFor: () => null } as unknown as ProviderRegistry;
    const svc = new MarketService(registry, new LruCache(), { llm: null, keyword: new KeywordAi(), mock: new MockAi() });
    await svc.quote('RKLB', true);
    await new Promise((r) => setTimeout(r, 10));
    const again = await svc.quote('RKLB', true);
    expect(fmp.statsCalls).toBe(1);
    expect(again.volume).toBeNull();
  });

  it('answers news at once while a slow AI works in the background, then serves the AI result', async () => {
    const headlines: NewsItem[] = [0, 1].map((i) => ({
      id: `h${i}`,
      headline: i ? 'Apple shares surge on record profit' : 'Apple faces lawsuit',
      snippet: '',
      source: 'Wire',
      url: 'https://example.com',
      publishedAt: new Date(Date.now() - 3600_000).toISOString(),
      sentiment: null,
    }) as unknown as NewsItem);
    class NewsSource extends FakeDaily {
      async getNews() {
        return headlines.map((h) => ({ ...h }));
      }
      async getQuote(symbol: string) {
        return { symbol, name: 'Apple Inc', changePct: 1 } as never;
      }
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowAi: AiService = {
      name: 'SlowAI',
      sentimentMethod: 'ai',
      canSummarize: true,
      canExtract: false,
      tagSentiment: async (_s, items) => (await gate, items.map(() => 'neutral' as const)),
      summarizeNews: async () => (await gate, { text: 'Summary.', articleCount: 2, source: 'SlowAI' }),
    };
    const src = new NewsSource('Finnhub', false);
    const registry = { for: () => src, fallbackFor: () => null } as unknown as ProviderRegistry;
    const svc = new MarketService(registry, new LruCache(), { llm: slowAi, keyword: new KeywordAi(), mock: new MockAi() }, undefined, { aiWaitMs: 20 });

    const first = await svc.news('AAPL', 'en');
    expect(first.aiPending).toBe(true);
    expect(first.summaryStatus).toBe('pending');
    expect(first.sentimentMethod).toBe('keywords');
    expect(first.items.map((x) => x.sentiment)).toEqual(['negative', 'positive']);

    release();
    await new Promise((r) => setTimeout(r, 30));
    const second = await svc.news('AAPL', 'en');
    expect(second.aiPending).toBe(false);
    expect(second.summary?.text).toBe('Summary.');
    expect(second.sentimentSource).toBe('SlowAI');
    expect(second.items.map((x) => x.sentiment)).toEqual(['neutral', 'neutral']);
  });

  it('marks analyst data the plan does not include, instead of failing silently', async () => {
    const svc = service(new FakeDaily('FMP', true), null);
    vi.spyOn(svc as unknown as { guidance: () => unknown }, 'guidance').mockResolvedValue({ guidance: null, status: 'no-source', sources: [] });
    const insight = await svc.insight('RKLB', 'en');
    expect(insight.estimates).toMatchObject({ revenueAvg: null, epsAvg: null, meta: { note: NOT_IN_PLAN } });
  });
});

describe('news summary freshness', () => {
  const article = (id: string, headline: string): NewsItem =>
    ({ id, headline, snippet: '', source: 'Wire', url: 'https://example.com', publishedAt: new Date(Date.now() - 3600_000).toISOString(), sentiment: null }) as unknown as NewsItem;

  function setup() {
    const feed = { list: [article('a', 'Apple faces lawsuit'), article('b', 'Apple shares surge')] };
    class NewsSource extends FakeDaily {
      async getNews() {
        return feed.list.map((h) => ({ ...h }));
      }
      async getQuote(symbol: string) {
        return { symbol, name: 'Apple Inc', changePct: 1 } as never;
      }
    }
    const calls = { summaries: 0, tagged: [] as string[] };
    let gate: Promise<void> = Promise.resolve();
    const ai: AiService = {
      name: 'TestAI',
      sentimentMethod: 'ai',
      canSummarize: true,
      canExtract: false,
      tagSentiment: async (_s, items) => {
        await gate;
        calls.tagged.push(...items.map((i) => i.id));
        return items.map(() => 'neutral' as const);
      },
      summarizeNews: async (_s, _n, _l, items) => {
        await gate;
        calls.summaries++;
        return { text: `Summary of ${items.length}`, articleCount: items.length, source: 'TestAI' };
      },
    };
    const src = new NewsSource('Finnhub', false);
    const registry = { for: () => src, fallbackFor: () => null } as unknown as ProviderRegistry;
    const cache = new LruCache();
    const svc = new MarketService(registry, cache, { llm: ai, keyword: new KeywordAi(), mock: new MockAi() }, undefined, { aiWaitMs: 20 });
    return {
      svc,
      calls,
      /** New article arrives (and the 2-min headline cache has expired). */
      publish: async (a: NewsItem) => {
        feed.list = [a, ...feed.list];
        await cache.delete('news:Finnhub:AAPL');
      },
      hold: () => {
        let release!: () => void;
        gate = new Promise<void>((r) => (release = r));
        return () => release();
      },
    };
  }

  it('does not re-write the summary when no new articles arrived', async () => {
    const { svc, calls } = setup();
    await svc.news('AAPL', 'en');
    await svc.news('AAPL', 'en');
    expect(calls.summaries).toBe(1);
  });

  it('writes a new summary as soon as a new article arrives, showing the old one meanwhile', async () => {
    const { svc, calls, publish, hold } = setup();
    expect((await svc.news('AAPL', 'en')).summary?.text).toBe('Summary of 2');

    const release = hold();
    await publish(article('c', 'Apple unveils new chip'));
    const during = await svc.news('AAPL', 'en');
    expect(during.summary?.text).toBe('Summary of 2'); // old summary stays visible
    expect(during.summaryUpdating).toBe(true);
    expect(during.aiPending).toBe(true);
    // Already-tagged headlines keep their AI tag; only the new one waits.
    expect(during.sentimentMethod).toBe('ai');
    expect(during.items.map((x) => [x.id, x.sentiment])).toEqual([['c', null], ['a', 'neutral'], ['b', 'neutral']]);

    release();
    await new Promise((r) => setTimeout(r, 30));
    const after = await svc.news('AAPL', 'en');
    expect(after.summary?.text).toBe('Summary of 3');
    expect(after.summaryUpdating).toBeFalsy();
    expect(after.items.find((x) => x.id === 'c')?.sentiment).toBe('neutral');
    expect(calls.summaries).toBe(2);
    expect(calls.tagged).toEqual(['a', 'b', 'c']); // each headline tagged once
  });
});
