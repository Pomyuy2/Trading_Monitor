import {
  isIntradayRange,
  type CandleSeries,
  type Guidance,
  type InsightResponse,
  type Lang,
  type NewsItem,
  type NewsResponse,
  type Quote,
  type Range,
  type Sentiment,
  type SentimentMethod,
  type SourceMeta,
  type SymbolMatch,
} from '@tm/shared';
import type { MarketDataProvider } from '../providers/types.js';
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

const MAX_HEADLINES = 20;
const MIN_RELEVANT = 5;

/** Short brand names that don't appear in the legal company name. */
const ALIASES: Record<string, string[]> = { GOOGL: ['Google'], GOOG: ['Google'], META: ['Facebook', 'Instagram'], BRK: ['Berkshire'] };

/** Does the article name the ticker or the company (e.g. "Apple" for "Apple Inc")? */
function mentions(n: NewsItem, symbol: string, companyName: string | null): boolean {
  const text = `${n.headline} ${n.snippet}`;
  const names = [...(ALIASES[symbol.split('.')[0]] ?? [])];
  const short = companyName
    ?.replace(/[,.]/g, ' ')
    .split(/\s+/)
    .find((w) => w.length >= 3 && !/^(the|inc|corp|corporation|company|co|ltd|plc|holdings|group)$/i.test(w));
  if (short) names.push(short);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${esc(symbol)}\\b`).test(text)) return true;
  return names.some((w) => new RegExp(`\\b${esc(w)}\\b`, 'i').test(text));
}
const MAX_SUMMARY_ARTICLES = 25;
const SENTIMENT_BATCH = 40;

export interface AiServices {
  /** Claude, when ANTHROPIC_API_KEY is set. */
  claude: AiService | null;
  keyword: AiService;
  mock: AiService;
}

export class MarketService {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly cache: Cache,
    private readonly ai: AiServices,
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

  /** Real headlines get Claude (if a key is set) or keyword rules; mock headlines get the mock AI. */
  private aiFor(provider: MarketDataProvider): AiService {
    if (provider instanceof MockProvider) return this.ai.mock;
    return this.ai.claude ?? this.ai.keyword;
  }

  /**
   * Sentiment per headline, cached per article id so each headline is classified once.
   * If the AI call fails, falls back to keyword rules for this response (not cached).
   */
  private async tagSentiment(ai: AiService, symbol: string, items: NewsItem[]): Promise<{ items: NewsItem[]; method: SentimentMethod; source: string }> {
    const labels = new Map<string, Sentiment>();
    const todo: NewsItem[] = [];
    for (const it of items) {
      if (it.sentiment) labels.set(it.id, it.sentiment);
      else {
        const hit = await this.cache.get<Sentiment>(`sentiment:${ai.name}:${it.id}`);
        if (hit) labels.set(it.id, hit.value);
        else todo.push(it);
      }
    }
    let method: SentimentMethod = ai.sentimentMethod;
    let source = ai.name;
    for (let i = 0; i < todo.length; i += SENTIMENT_BATCH) {
      const batch = todo.slice(i, i + SENTIMENT_BATCH);
      try {
        const tags = await ai.tagSentiment(symbol, batch);
        for (const [j, it] of batch.entries()) {
          labels.set(it.id, tags[j]);
          await this.cache.set(`sentiment:${ai.name}:${it.id}`, tags[j], TTL.sentiment);
        }
      } catch {
        const tags = await this.ai.keyword.tagSentiment(symbol, batch);
        batch.forEach((it, j) => labels.set(it.id, tags[j]));
        method = 'keywords';
        source = this.ai.keyword.name;
      }
    }
    return { items: items.map((it) => ({ ...it, sentiment: labels.get(it.id) ?? null })), method, source };
  }

  async news(symbol: string, lang: Lang): Promise<NewsResponse> {
    const p = this.providers.for('news');
    const ai = this.aiFor(p);
    const now = Date.now();
    // Headline list: the last 3 days (weekends are quiet). The AI summary uses only the last 24 h.
    const quote = await settle(this.quote(symbol));
    const res = await cached(this.cache, `news:${p.name}:${ai.name}:${symbol}`, TTL.news, async () => {
      const raw = await withRateLimitRetry(() => p.getNews(symbol, now - 3 * 86400_000, now));
      const sorted = raw.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      // Providers tag many market-wide stories to big tickers; prefer ones that mention the company.
      const relevant = sorted.filter((n) => mentions(n, symbol, quote?.name ?? null));
      const latest = (relevant.length >= MIN_RELEVANT ? relevant : sorted).slice(0, MAX_HEADLINES);
      return this.tagSentiment(ai, symbol, latest);
    });
    const { items, method, source } = res.value;
    const meta: SourceMeta = {
      source: p.name,
      updatedAt: new Date(res.storedAt).toISOString(),
      ...(res.stale ? { stale: true, note: STALE_NOTE } : {}),
    };
    const base = { symbol, lang, items, sentimentMethod: items.length ? method : null, sentimentSource: items.length ? source : null, meta };

    if (!ai.canSummarize) return { ...base, summary: null, summaryStatus: 'disabled' };
    const recent = items.filter((n) => Date.parse(n.publishedAt) >= Date.now() - 24 * 3600_000).slice(0, MAX_SUMMARY_ARTICLES);
    if (recent.length === 0) return { ...base, summary: null, summaryStatus: 'no-recent' };

    const sRes = await settle(
      cached(this.cache, `newsSummary:${ai.name}:${symbol}:${lang}`, TTL.newsSummary, () =>
        ai.summarizeNews(symbol, quote?.name ?? null, lang, recent, quote?.changePct ?? null),
      ),
    );
    if (!sRes?.value) return { ...base, summary: null, summaryStatus: 'error' };
    return {
      ...base,
      summary: {
        text: sRes.value.text,
        articleCount: sRes.value.articleCount,
        lang,
        meta: { source: sRes.value.source, updatedAt: new Date(sRes.storedAt).toISOString() },
      },
      summaryStatus: 'ok',
    };
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
