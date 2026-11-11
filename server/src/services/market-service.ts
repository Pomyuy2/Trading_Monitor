import {
  isIntradayRange,
  type CandleSeries,
  type Guidance,
  type GuidanceStatus,
  type InsightResponse,
  type EventsResponse,
  type Lang,
  type LevelsResponse,
  type NewsItem,
  type Pivots,
  type NewsResponse,
  type Quote,
  type Range,
  type Sentiment,
  type SentimentMethod,
  type SourceMeta,
  type Sparkline,
  type SymbolMatch,
} from '@tm/shared';
import { ProviderAuthError, RateLimitError, type Capability, type KeyStats, type MarketDataProvider } from '../providers/types.js';
import { classicPivots, computeLevels, splitLevels } from '../analysis/levels.js';
import { nyDate } from '../lib/market-time.js';
import { finalizeGuidance, guidanceTexts, withTexts } from '../ai/guidance.js';
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

/** Run fn; if the provider's plan refuses the symbol, return `empty` marked NOT_IN_PLAN instead of throwing. */
async function orNotInPlan<T extends object>(source: string, fn: () => Promise<T & { meta: SourceMeta }>, empty: T): Promise<T & { meta: SourceMeta }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderAuthError) return { ...empty, meta: { source, updatedAt: new Date().toISOString(), note: NOT_IN_PLAN } };
    throw err;
  }
}

/** Lists the plan doesn't include for this symbol are simply empty (and cached like any result). */
async function emptyIfNotInPlan<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderAuthError) return [];
    throw err;
  }
}

/** Marker the UI translates: the provider's free plan doesn't include this data for this symbol. */
export const NOT_IN_PLAN = 'notInPlan';
const EMPTY_INSIGHT = {
  estimates: { fiscalYear: null, revenueAvg: null, epsAvg: null, analystCount: null },
  priceTargets: { low: null, avg: null, high: null },
  ratings: { buy: null, hold: null, sell: null },
  earningsCalendar: { date: null },
} as const;
const SPARKLINE_DAYS = 22; // ≈ one month of trading days
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
/** How long a news request waits for the AI before answering with keyword tags / "summary on its way". */
const AI_WAIT_MS = 6_000;
const AI_RETRY_AFTER_MS = 5 * 60_000;
/** Guidance reads long filings; the insight request waits a bit longer before saying "still reading". */
const GUIDANCE_WAIT_MS = 15_000;
const PENDING = Symbol('pending');

export interface AiServices {
  /** The AI model: Claude (ANTHROPIC_API_KEY) or an OpenAI-compatible router (AI_BASE_URL + AI_API_KEY + AI_MODEL). */
  llm: AiService | null;
  keyword: AiService;
  mock: AiService;
}

export class MarketService {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly cache: Cache,
    private readonly ai: AiServices,
    /** Persistent cache for AI outputs (defaults to the regular cache). */
    private readonly aiCache: Cache = cache,
    private readonly opts: { aiWaitMs?: number } = {},
  ) {}

  private readonly aiJobs = new Map<string, Promise<unknown>>();
  private readonly aiFailedAt = new Map<string, number>();

  /**
   * Start (or join) a background AI job and wait at most `aiWaitMs` for it. A slow model never holds up
   * the page: the caller shows a fallback meanwhile, the job finishes and fills the AI cache, and the
   * next request picks it up. After a failure the job isn't retried for AI_RETRY_AFTER_MS.
   */
  private async aiJob<T>(key: string, fn: () => Promise<T>, waitMs = this.opts.aiWaitMs ?? AI_WAIT_MS): Promise<{ ready: true; value: T } | { ready: false; failed: boolean }> {
    const failedAt = this.aiFailedAt.get(key);
    if (failedAt && Date.now() - failedAt < AI_RETRY_AFTER_MS) return { ready: false, failed: true };
    let job = this.aiJobs.get(key) as Promise<T> | undefined;
    if (!job) {
      job = fn();
      this.aiJobs.set(key, job);
      job
        .then(
          () => this.aiFailedAt.delete(key),
          () => this.aiFailedAt.set(key, Date.now()),
        )
        .finally(() => this.aiJobs.delete(key));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<typeof PENDING>((r) => (timer = setTimeout(() => r(PENDING), waitMs)));
    try {
      const v = await Promise.race([job, waited]);
      return v === PENDING ? { ready: false, failed: false } : { ready: true, value: v as T };
    } catch {
      return { ready: false, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }

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
    // A plan refusal is remembered (12 h) so we don't ask again on every refresh.
    const stats = await settle(
      cached(
        this.cache,
        `keyStats:${sp.name}:${symbol}`,
        (v: KeyStats) => (v.meta.note === NOT_IN_PLAN ? TTL.notInPlan : TTL.keyStats),
        () => orNotInPlan(sp.name, () => withRateLimitRetry(() => sp.getKeyStats(symbol)), {} as Omit<KeyStats, 'meta'>),
      ),
    );
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
    const cap = isIntradayRange(range) ? 'intradayCandles' : 'dailyCandles';
    return markStale(
      await cached(this.cache, `candles:${p.name}:${symbol}:${range}`, ttl, () => this.withFallback(cap, (x) => x.getCandles(symbol, range))),
    );
  }

  /**
   * Call the capability's provider; if it refuses this symbol on the free plan (401/402/403) or its
   * call allowance is used up (429), try the configured fallback provider (e.g. FMP → Twelve Data
   * for daily candles).
   */
  private async withFallback<T>(cap: Capability, fn: (p: MarketDataProvider) => Promise<T>): Promise<T> {
    const p = this.providers.for(cap);
    try {
      return await withRateLimitRetry(() => fn(p));
    } catch (err) {
      const fb = this.providers.fallbackFor(cap);
      if (!(err instanceof ProviderAuthError || err instanceof RateLimitError) || !fb) throw err;
      return withRateLimitRetry(() => fn(fb));
    }
  }

  /**
   * Support / resistance for the selected range. The (price-independent) level list is cached per
   * symbol + range + latest candle, so it's recomputed only when new candles arrive; the split into
   * supports / resistances uses the current price on every request.
   */
  /** Quotes for several symbols at once (watchlist); unknown symbols are skipped. */
  async quotes(symbols: string[]): Promise<Quote[]> {
    const out = await Promise.all(symbols.map((s) => settle(this.quote(s))));
    return out.filter((q): q is Quote => !!q);
  }

  /**
   * ~1 month of daily closes for a watchlist trend line. Cached 12 h per symbol so a long
   * watchlist costs only a couple of daily-candle calls per stock per day.
   */
  async sparkline(symbol: string): Promise<Sparkline> {
    const p = this.providers.for('dailyCandles');
    const res = await cached(this.cache, `sparkline:${p.name}:${symbol}`, TTL.sparkline, async () => {
      const s = await this.withFallback('dailyCandles', (x) => x.getCandles(symbol, '6M'));
      return {
        symbol,
        points: s.candles.slice(-SPARKLINE_DAYS).map((c) => ({ time: c.time, close: c.close })),
        meta: { ...s.meta },
      } satisfies Sparkline;
    });
    return markStale(res);
  }

  async sparklines(symbols: string[]): Promise<Sparkline[]> {
    const out = await Promise.all(symbols.map((s) => settle(this.sparkline(s))));
    return out.filter((x): x is Sparkline => !!x);
  }

  async levels(symbol: string, range: Range): Promise<LevelsResponse> {
    const series = await this.candles(symbol, range);
    const bars = series.candles;
    const last = bars[bars.length - 1];
    const key = `levels:${series.meta.source}:${symbol}:${range}:${bars.length}:${last?.time ?? 0}`;
    const scored = (await cached(this.cache, key, TTL.levels, async () => computeLevels(bars))).value;
    const quote = await settle(this.quote(symbol));
    const price = quote?.price ?? last?.close ?? null;
    const { supports, resistances } = price != null ? splitLevels(scored, price) : { supports: [], resistances: [] };
    const pivots = await settle(this.pivots(symbol, quote));
    return {
      symbol,
      range,
      resolution: series.resolution,
      price,
      supports,
      resistances,
      pivots,
      candleCount: bars.length,
      meta: { ...series.meta },
    };
  }

  /** Classic pivots from the most recent completed regular session (daily candles, already cached). */
  private async pivots(symbol: string, quote: Quote | null): Promise<Pivots | null> {
    const daily = await this.candles(symbol, '6M');
    const today = nyDate(Date.now() / 1000);
    const sessionInProgress = quote?.marketState === 'open' || quote?.marketState === 'pre';
    // Daily bars are keyed by their calendar date at 00:00 UTC.
    const dateOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    const done = daily.candles.filter((c) => !sessionInProgress || dateOf(c.time) < today);
    const prev = done[done.length - 1];
    if (!prev) return null;
    return { ...classicPivots(prev.high, prev.low, prev.close), sessionDate: dateOf(prev.time), meta: { ...daily.meta } };
  }

  /** Earnings + dividend markers for the chart (5 years back, ~3 months ahead). */
  async events(symbol: string): Promise<EventsResponse> {
    const now = Date.now();
    const ep = this.providers.for('earningsHistory');
    const dp = this.providers.for('dividends');
    const [earnings, dividends] = await Promise.all([
      settle(cached(this.cache, `events:earnings:${ep.name}:${symbol}`, TTL.events, () => emptyIfNotInPlan(() => withRateLimitRetry(() => ep.getEarningsHistory(symbol, now - 5 * 366 * 86400_000, now + 100 * 86400_000))))),
      settle(cached(this.cache, `events:dividends:${dp.name}:${symbol}`, TTL.events, () => emptyIfNotInPlan(() => withRateLimitRetry(() => dp.getDividends(symbol))))),
    ]);
    const cutoff = new Date(now - 5 * 366 * 86400_000).toISOString().slice(0, 10);
    const meta = (r: { storedAt: number; stale: boolean } | null, source: string): SourceMeta | null =>
      r ? { source, updatedAt: new Date(r.storedAt).toISOString(), ...(r.stale ? { stale: true } : {}) } : null;
    return {
      symbol,
      earnings: earnings?.value ?? [],
      dividends: (dividends?.value ?? []).filter((d) => d.exDate >= cutoff),
      meta: { earnings: meta(earnings, ep.name), dividends: meta(dividends, dp.name) },
    };
  }

  /** Real headlines get the AI model (if configured) or keyword rules; mock headlines get the mock AI. */
  private aiFor(provider: MarketDataProvider): AiService {
    if (provider instanceof MockProvider) return this.ai.mock;
    return this.ai.llm ?? this.ai.keyword;
  }

  /**
   * AI sentiment per headline, cached per article id so each headline is classified once.
   * Throws if the AI fails (the caller then shows keyword tags).
   */
  private async aiSentiment(ai: AiService, symbol: string, items: NewsItem[]): Promise<{ items: NewsItem[]; method: SentimentMethod; source: string }> {
    const labels = new Map<string, Sentiment>();
    const todo: NewsItem[] = [];
    for (const it of items) {
      if (it.sentiment) labels.set(it.id, it.sentiment);
      else {
        const hit = await this.aiCache.get<Sentiment>(`sentiment:${ai.name}:${it.id}`);
        if (hit) labels.set(it.id, hit.value);
        else todo.push(it);
      }
    }
    for (let i = 0; i < todo.length; i += SENTIMENT_BATCH) {
      const batch = todo.slice(i, i + SENTIMENT_BATCH);
      const tags = await ai.tagSentiment(symbol, batch);
      for (const [j, it] of batch.entries()) {
        labels.set(it.id, tags[j]);
        await this.aiCache.set(`sentiment:${ai.name}:${it.id}`, tags[j], TTL.sentiment);
      }
    }
    return { items: items.map((it) => ({ ...it, sentiment: labels.get(it.id) ?? null })), method: ai.sentimentMethod, source: ai.name };
  }

  /** Keyword-rule tags (no AI) — used while the AI is busy or unavailable. */
  private async keywordSentiment(symbol: string, items: NewsItem[]): Promise<{ items: NewsItem[]; method: SentimentMethod; source: string }> {
    const todo = items.filter((it) => !it.sentiment);
    const tags = await this.ai.keyword.tagSentiment(symbol, todo);
    const byId = new Map(todo.map((it, j) => [it.id, tags[j]]));
    return { items: items.map((it) => (it.sentiment ? it : { ...it, sentiment: byId.get(it.id) ?? null })), method: 'keywords', source: this.ai.keyword.name };
  }

  async news(symbol: string, lang: Lang): Promise<NewsResponse> {
    const p = this.providers.for('news');
    const ai = this.aiFor(p);
    const now = Date.now();
    // Headline list: the last 3 days (weekends are quiet). The AI summary uses only the last 24 h.
    const quote = await settle(this.quote(symbol));
    const res = await cached(this.cache, `news:${p.name}:${symbol}`, TTL.news, async () => {
      const raw = await withRateLimitRetry(() => p.getNews(symbol, now - 3 * 86400_000, now));
      const sorted = raw.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      // Providers tag many market-wide stories to big tickers; prefer ones that mention the company.
      const relevant = sorted.filter((n) => mentions(n, symbol, quote?.name ?? null));
      return (relevant.length >= MIN_RELEVANT ? relevant : sorted).slice(0, MAX_HEADLINES);
    });
    const headlines = res.value;
    const meta: SourceMeta = {
      source: p.name,
      updatedAt: new Date(res.storedAt).toISOString(),
      ...(res.stale ? { stale: true, note: STALE_NOTE } : {}),
    };
    const recent = headlines.filter((n) => Date.parse(n.publishedAt) >= Date.now() - 24 * 3600_000).slice(0, MAX_SUMMARY_ARTICLES);
    const wantSummary = ai.canSummarize && recent.length > 0;

    // Sentiment and summary run side by side, in the background if the model is slow.
    const [tagged, summary] = await Promise.all([
      this.aiJob(`sentiment:${ai.name}:${symbol}`, () => this.aiSentiment(ai, symbol, headlines)),
      wantSummary
        ? this.aiJob(`newsSummary:${ai.name}:${symbol}:${lang}`, () =>
            cached(this.aiCache, `newsSummary:${ai.name}:${symbol}:${lang}`, TTL.newsSummary, () =>
              ai.summarizeNews(symbol, quote?.name ?? null, lang, recent, quote?.changePct ?? null),
            ),
          )
        : null,
    ]);
    // A job started for an older headline list may not cover the current one; use keywords for this response.
    const tagsFit = tagged.ready && headlines.every((h) => tagged.value.items.some((x) => x.id === h.id));
    const { items, method, source } = tagged.ready && tagsFit ? tagged.value : await this.keywordSentiment(symbol, headlines);
    const sentimentPending = !tagged.ready && !tagged.failed;
    const base = {
      symbol,
      lang,
      items,
      sentimentMethod: items.length ? method : null,
      sentimentSource: items.length ? source : null,
      meta,
    };

    if (!ai.canSummarize) return { ...base, aiPending: sentimentPending, summary: null, summaryStatus: 'disabled' };
    if (!summary) return { ...base, aiPending: sentimentPending, summary: null, summaryStatus: 'no-recent' };
    if (!summary.ready) return { ...base, aiPending: sentimentPending || !summary.failed, summary: null, summaryStatus: summary.failed ? 'error' : 'pending' };
    const s = summary.value;
    if (!s.value) return { ...base, aiPending: sentimentPending, summary: null, summaryStatus: 'error' };
    return {
      ...base,
      aiPending: sentimentPending,
      summary: {
        text: s.value.text,
        articleCount: s.value.articleCount,
        lang,
        meta: { source: s.value.source, updatedAt: new Date(s.storedAt).toISOString() },
      },
      summaryStatus: 'ok',
    };
  }

  async insight(symbol: string, lang: Lang): Promise<InsightResponse> {
    const r = this.providers;
    const c = <T extends { meta: SourceMeta }>(cap: Parameters<ProviderRegistry['for']>[0], ttl: number, fn: (p: ReturnType<ProviderRegistry['for']>) => Promise<T>) => {
      const p = r.for(cap);
      return settle(
        cached(this.cache, `${cap}:${p.name}:${symbol}`, ttl, async () => {
          try {
            return await withRateLimitRetry(() => fn(p));
          } catch (err) {
            const empty = EMPTY_INSIGHT[cap as keyof typeof EMPTY_INSIGHT];
            if (err instanceof ProviderAuthError && empty) {
              return { ...empty, meta: { source: p.name, updatedAt: new Date().toISOString(), note: NOT_IN_PLAN } } as unknown as T;
            }
            throw err;
          }
        }).then(markStale),
      );
    };
    const [profile, estimates, priceTargets, ratings, earnings] = await Promise.all([
      c('profile', TTL.profile, (p) => p.getProfile(symbol)),
      c('estimates', TTL.estimates, (p) => p.getEstimates(symbol)),
      c('priceTargets', TTL.estimates, (p) => p.getPriceTargets(symbol)),
      c('ratings', TTL.estimates, (p) => p.getRatings(symbol)),
      c('earningsCalendar', TTL.estimates, (p) => p.getEarningsCalendar(symbol)),
    ]);
    const g = await this.guidance(symbol, lang, earnings?.date ?? null, profile?.name ?? null);
    return { symbol, lang, profile, guidance: g.guidance, guidanceStatus: g.status, guidanceSources: g.sources, estimates, priceTargets, ratings, earnings };
  }

  /**
   * Guidance: source documents (transcript / SEC filings) → Claude extraction → zod validation
   * + quote check. The English result is cached until the next earnings date; translations are
   * cached separately per language. Without an AI key, the source documents are still returned
   * so the UI can link to them.
   */
  private async guidance(
    symbol: string,
    lang: Lang,
    nextEarnings: string | null,
    companyName: string | null,
  ): Promise<{ guidance: Guidance | null; status: GuidanceStatus; sources: InsightResponse['guidanceSources'] }> {
    const p = this.providers.for('transcripts');
    const untilEarnings = nextEarnings ? Date.parse(nextEarnings) - Date.now() : NaN;
    const ttl = Number.isFinite(untilEarnings) && untilEarnings > 3600_000 ? untilEarnings : TTL.guidanceFallback;

    if (p instanceof MockProvider) {
      const g = p.getMockGuidance(symbol, lang);
      return { guidance: g, status: g ? 'ok' : 'no-source', sources: [] };
    }

    const docsRes = await settle(cached(this.cache, `guidanceDocs:${p.name}:${symbol}`, TTL.guidanceDocs, () => withRateLimitRetry(() => p.getGuidanceDocuments(symbol))));
    const docs = docsRes?.value ?? [];
    const sources = docs.map(({ title, date, url }) => ({ title, date, url }));
    if (docs.length === 0) return { guidance: null, status: 'no-source', sources };

    const ai = this.ai.llm;
    if (!ai?.canExtract || !ai.extractGuidance) return { guidance: null, status: 'disabled', sources };

    const docKey = docs.map((d) => `${d.date}:${d.url}`).join('|');
    // Runs in the background if the model is slow; the card says "still reading" and asks again.
    const job = await this.aiJob(
      `guidance:${ai.name}:${lang}:${symbol}:${docKey}`,
      async (): Promise<Guidance | null> => {
        const en = (
          await cached(this.aiCache, `guidance:en:${symbol}:${docKey}`, ttl, async () => {
            const raw = await ai.extractGuidance!(symbol, companyName, docs);
            return raw ? finalizeGuidance(raw, docs, { source: `${p.name} · ${ai.name}`, updatedAt: new Date().toISOString() }) : null;
          })
        ).value;
        if (!en || lang === 'en' || !ai.translate) return en;
        const tr = await settle(
          cached(this.aiCache, `guidance:${lang}:${symbol}:${docKey}`, ttl, async () => withTexts(en, await ai.translate!(guidanceTexts(en), lang))),
        );
        return tr?.value ?? en;
      },
      this.opts.aiWaitMs ?? GUIDANCE_WAIT_MS,
    );
    if (!job.ready) return { guidance: null, status: job.failed ? 'error' : 'pending', sources };
    return { guidance: job.value, status: job.value ? 'ok' : 'error', sources };
  }
}
