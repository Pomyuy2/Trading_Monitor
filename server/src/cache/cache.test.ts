import { describe, expect, it, vi } from 'vitest';
import { cached, inFlightCount, LruCache } from './cache.js';

describe('Singleflight Cache Deduplication', () => {
  it('deduplicates 10 concurrent identical requests into exactly one upstream fetch', async () => {
    const cache = new LruCache(100);
    let fetchCount = 0;

    const slowFetcher = async () => {
      fetchCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { price: 150, symbol: 'AAPL' };
    };

    // Fire 10 simultaneous identical calls
    const promises = Array.from({ length: 10 }, () =>
      cached(cache, 'quote:AAPL', 60_000, slowFetcher)
    );

    // In-flight count should be 1 during execution
    await Promise.resolve();
    expect(inFlightCount(cache)).toBe(1);

    const results = await Promise.all(promises);

    // All 10 received the same result
    expect(results).toHaveLength(10);
    for (const res of results) {
      expect(res.value).toEqual({ price: 150, symbol: 'AAPL' });
      expect(res.stale).toBe(false);
    }

    // Upstream fetch was invoked exactly ONCE
    expect(fetchCount).toBe(1);

    // After completion, inFlight map is cleaned up
    expect(inFlightCount(cache)).toBe(0);
  });

  it('executes independent fetches for different keys concurrently', async () => {
    const cache = new LruCache(100);
    const fetchedKeys: string[] = [];

    const fetcher = async (sym: string) => {
      fetchedKeys.push(sym);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { symbol: sym };
    };

    const [r1, r2, r3] = await Promise.all([
      cached(cache, 'quote:AAPL', 60_000, () => fetcher('AAPL')),
      cached(cache, 'quote:MSFT', 60_000, () => fetcher('MSFT')),
      cached(cache, 'quote:TSLA', 60_000, () => fetcher('TSLA')),
    ]);

    expect(r1.value.symbol).toBe('AAPL');
    expect(r2.value.symbol).toBe('MSFT');
    expect(r3.value.symbol).toBe('TSLA');
    expect(fetchedKeys).toEqual(expect.arrayContaining(['AAPL', 'MSFT', 'TSLA']));
    expect(fetchedKeys).toHaveLength(3);
    expect(inFlightCount(cache)).toBe(0);
  });

  it('serves stale entry if fetcher throws and an expired entry exists', async () => {
    const cache = new LruCache(100);
    const now = Date.now();

    // Pre-populate with an expired entry
    await cache.set('quote:AAPL', { price: 100 }, -1000); // expired 1s ago

    let failCount = 0;
    const failingFetcher = async () => {
      failCount++;
      throw new Error('Upstream provider down');
    };

    // 5 concurrent requests hit the failing fetcher with stale cache available
    const promises = Array.from({ length: 5 }, () =>
      cached(cache, 'quote:AAPL', 60_000, failingFetcher)
    );

    const results = await Promise.all(promises);

    expect(failCount).toBe(1); // Singleflight deduplicated the failure
    for (const res of results) {
      expect(res.stale).toBe(true);
      expect(res.value).toEqual({ price: 100 });
    }
    expect(inFlightCount(cache)).toBe(0);
  });

  it('properly cleans up inFlight map and propagates error when no stale cache exists', async () => {
    const cache = new LruCache(100);
    let attempts = 0;

    const failingFetcher = async () => {
      attempts++;
      throw new Error('Network timeout');
    };

    const promises = Array.from({ length: 5 }, () =>
      cached(cache, 'quote:UNKNOWN', 60_000, failingFetcher)
    );

    await expect(Promise.all(promises)).rejects.toThrow('Network timeout');
    expect(attempts).toBe(1);
    expect(inFlightCount(cache)).toBe(0);

    // Next request can retry independently
    const retry = cached(cache, 'quote:UNKNOWN', 60_000, async () => ({ recovered: true }));
    const result = await retry;
    expect(result.value).toEqual({ recovered: true });
  });

  it('scopes in-flight promises to their respective cache instances', async () => {
    const cache1 = new LruCache(100);
    const cache2 = new LruCache(100);
    let count1 = 0;
    let count2 = 0;

    const [r1, r2] = await Promise.all([
      cached(cache1, 'key:shared', 60_000, async () => {
        count1++;
        return 'c1';
      }),
      cached(cache2, 'key:shared', 60_000, async () => {
        count2++;
        return 'c2';
      }),
    ]);

    expect(r1.value).toBe('c1');
    expect(r2.value).toBe('c2');
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});
