import { describe, expect, it } from 'vitest';
import { MarketService } from './market-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { MockProvider } from '../providers/mock/mock-provider.js';
import { LruCache } from '../cache/cache.js';
import { KeywordAi } from '../ai/keyword-ai.js';
import { MockAi } from '../ai/mock-ai.js';

describe('MarketService Levels & Pivots Integration', () => {
  function makeService() {
    const mock = new MockProvider();
    const registry = {
      for: () => mock,
      fallbackFor: () => null,
      mockCapabilities: () => [],
    } as unknown as ProviderRegistry;
    const cache = new LruCache();
    return new MarketService(registry, cache, { llm: null, keyword: new KeywordAi(), mock: new MockAi() });
  }

  it('serves V1 levels by default with methodVersion v1', async () => {
    const service = makeService();
    const res = await service.levels('AAPL', '1M');

    expect(res.symbol).toBe('AAPL');
    expect(res.range).toBe('1M');
    expect(res.methodVersion).toBe('v1');
    expect(Array.isArray(res.supports)).toBe(true);
    expect(Array.isArray(res.resistances)).toBe(true);
    expect(res.supports.length).toBeLessThanOrEqual(3);
    expect(res.resistances.length).toBeLessThanOrEqual(3);
  });

  it('serves V2 adaptive levels when version v2 is requested', async () => {
    const service = makeService();
    const res = await service.levels('AAPL', '1D', { version: 'v2' });

    expect(res.symbol).toBe('AAPL');
    expect(res.methodVersion).toBe('v2');
    expect(res.config).toBeDefined();

    for (const s of res.supports) {
      expect(s.methodVersion).toBe('v2');
      expect(s.kind).toBe('support');
      expect(s.price).toBeLessThanOrEqual(res.price!);
    }
    for (const r of res.resistances) {
      expect(r.methodVersion).toBe('v2');
      expect(r.kind).toBe('resistance');
      expect(r.price).toBeGreaterThanOrEqual(res.price!);
    }
  });

  it('computes classic floor pivots with prior completed session date', async () => {
    const service = makeService();
    const res = await service.levels('AAPL', '6M');

    if (res.pivots) {
      expect(res.pivots.P).toBeGreaterThan(0);
      expect(res.pivots.R1).toBeGreaterThan(res.pivots.P);
      expect(res.pivots.S1).toBeLessThan(res.pivots.P);
      expect(res.pivots.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
