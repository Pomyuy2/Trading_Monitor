import {
  isIntradayRange,
  type CandleSeries,
  type Guidance,
  type InsightResponse,
  type Lang,
  type NewsResponse,
  type Quote,
  type Range,
  type SourceMeta,
  type SymbolMatch,
} from '@tm/shared';
import type { AiService } from '../ai/ai-service.js';
import { cached, type Cache, type CachedResult } from '../cache/cache.js';
import { TTL } from '../config/cache-ttl.js';
import { withRateLimitRetry } from '../lib/retry.js';
import { MockProvider } from '../providers/mock/mock-provider.js';
import type { ProviderRegistry } from '../providers/registry.js';

const STALE_NOTE = 'Provider unavailable — showing last cached data';

/** Mark data served from cache after an upstream failure. */
function markStale<T extends { meta: SourceMeta }>(r: CachedResult<T>): T {
  if (!r.stale) return r.value;
  return { ...r.value, meta: { ...r.value.meta, stale: true, note: STALE_NOTE, updatedAt: new Date(r.storedAt).toISOString() } };
}

async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export class MarketService {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly cache: Cache,
    private readonly ai: AiService,
  ) {}

  async search(q: string): Promise<SymbolMatch[]> {
    const p = this.providers.for('search');
    const key = `search:${p.name}:${q.toLowerCase()}`;
    return (await cached(this.cache, key, TTL.search, () => withRateLimitRetry(() => p.searchSymbols(q)))).value;
  }

  /** `detail` also merges key stats (e.g. today's volume) from the keyStats provider. */
  async quote(symbol: string, detail = false): Promise<Quote> {
    const p = this.providers.for('quote');
    const quote = markStale(await cached(this.cache, `quote:${p.name}:${symbol}`, TTL.quote, () => withRateLimitRetry(() => p.getQuote(symbol))));
    if (!detail) return quote;
    const sp = this.providers.for('keyStats');
    if (sp === p) return quote;
    const stats = await settle(cached(this.cache, `keyStats:${sp.name}:${symbol}`, TTL.keyStats, () => withRateLimitRetry(() => sp.getKeyStats(symbol))));
    if (!stats) return quote;
    const merged: Quote = { ...quote };
    let used = false;
    for (const [k, v] of Object.entries(stats.value)) {
      if (k === 'meta' || v == null) continue;
      const rec = merged as unknown as Record<string, unknown>;
      if (rec[k] == null) {
        rec[k] = v;
        used = true;
      }
    }
    if (used) merged.meta = { ...quote.meta, source: `${quote.meta.source}, ${sp.name}` };
    return merged;
  }

  async candles(symbol: string, range: Range): Promise<CandleSeries> {
    const p = this.providers.for(isIntradayRange(range) ? 'intradayCandles' : 'dailyCandles');
    // Intraday: 1 min while bars are still arriving; 30 min once the newest bar is old (market not trading),
    // which keeps us well inside Twelve Data's free 800 requests/day.
    const ttl = isIntradayRange(range)
      ? (s: CandleSeries) => {
          const last = s.candles[s.candles.length - 1]?.time ?? 0;
          return Date.now() / 1000 - last > 15 * 60 ? TTL.intradayIdle : TTL.intradayCandles;
        }
      : TTL.dailyCandles;
    return markStale(
      await cached(this.cache, `candles:${p.name}:${symbol}:${range}`, ttl, () => withRateLimitRetry(() => p.getCandles(symbol, range))),
    );
  }

  async news(symbol: string, lang: Lang): Promise<NewsResponse> {
    const p = this.providers.for('news');
    const to = Date.now();
    const from = to - 24 * 3600_000;
    const itemsRes = await cached(this.cache, `news:${p.name}:${symbol}`, TTL.news, async () => {
      const items = await withRateLimitRetry(() => p.getNews(symbol, from, to));
      const tags = await this.ai.tagSentiment(items);
      return items.map((it, i) => ({ ...it, sentiment: it.sentiment ?? tags[i] ?? null }));
    });
    const items = itemsRes.value.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const meta: SourceMeta = {
      source: p.name,
      updatedAt: new Date(itemsRes.storedAt).toISOString(),
      ...(itemsRes.stale ? { stale: true, note: STALE_NOTE } : {}),
    };

    let summary: NewsResponse['summary'] = null;
    if (items.length > 0) {
      const quote = await settle(this.quote(symbol));
      const sRes = await settle(
        cached(this.cache, `newsSummary:${this.ai.name}:${symbol}:${lang}`, TTL.newsSummary, () =>
          this.ai.summarizeNews(symbol, lang, items, quote?.changePct ?? null),
        ),
      );
      if (sRes) {
        summary = {
          text: sRes.value.text,
          articleCount: sRes.value.articleCount,
          lang,
          meta: { source: sRes.value.source, updatedAt: new Date(sRes.storedAt).toISOString() },
        };
      }
    }
    return { symbol, lang, summary, items, meta };
  }

  async insight(symbol: string, lang: Lang): Promise<InsightResponse> {
    const r = this.providers;
    const c = <T extends { meta: SourceMeta }>(cap: Parameters<ProviderRegistry['for']>[0], ttl: number, fn: (p: ReturnType<ProviderRegistry['for']>) => Promise<T>) => {
      const p = r.for(cap);
      return settle(cached(this.cache, `${cap}:${p.name}:${symbol}`, ttl, () => withRateLimitRetry(() => fn(p))).then(markStale));
    };
    const [profile, estimates, priceTargets, ratings, earnings] = await Promise.all([
      c('profile', TTL.profile, (p) => p.getProfile(symbol)),
      c('estimates', TTL.estimates, (p) => p.getEstimates(symbol)),
      c('priceTargets', TTL.estimates, (p) => p.getPriceTargets(symbol)),
      c('ratings', TTL.estimates, (p) => p.getRatings(symbol)),
      c('earningsCalendar', TTL.estimates, (p) => p.getEarningsCalendar(symbol)),
    ]);
    const guidance = await settle(this.guidance(symbol, lang, earnings?.date ?? null));
    return { symbol, lang, profile, guidance, estimates, priceTargets, ratings, earnings };
  }

  /** Guidance is cached until the next earnings date. Phase 4 adds transcript → AI extraction. */
  private async guidance(symbol: string, lang: Lang, nextEarnings: string | null): Promise<Guidance | null> {
    const p = this.providers.for('transcripts');
    const untilEarnings = nextEarnings ? Date.parse(nextEarnings) - Date.now() : NaN;
    const ttl = Number.isFinite(untilEarnings) && untilEarnings > 3600_000 ? untilEarnings : TTL.guidanceFallback;
    const res = await cached(this.cache, `guidance:${p.name}:${symbol}:${lang}`, ttl, async () => {
      if (p instanceof MockProvider) return p.getMockGuidance(symbol, lang);
      return null; // TODO(Phase 4): fetch transcript, extract with AI, validate with zod
    });
    return res.value;
  }
}
