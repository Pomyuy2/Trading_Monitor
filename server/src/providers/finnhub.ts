import type { MarketState, NewsItem, Quote, SymbolMatch } from '@tm/shared';
import { getJson } from '../lib/http.js';
import { Memo } from '../lib/memo.js';
import { BaseProvider, NotFoundError, type Capability } from './types.js';

/**
 * Finnhub (https://finnhub.io): live trades over WebSocket, quotes, market
 * status, key stats (metric endpoint), symbol search.
 * company news. TODO(Phase 4): company profile.
 *
 * Free plan notes: 60 REST calls/min, 1 WebSocket connection per key, up to
 * 50 symbols per socket. /stock/executive and /stock/candle are paid.
 */
const BASE = 'https://finnhub.io/api/v1';
const WS_URL = 'wss://ws.finnhub.io';
const MAX_BACKOFF_MS = 30_000;

interface FhQuote { c: number; d: number | null; dp: number | null; h: number; l: number; o: number; pc: number; t: number }
interface FhProfile { name?: string; exchange?: string; currency?: string; marketCapitalization?: number; ticker?: string }
interface FhMetric { metric?: Record<string, number | null> }
interface FhStatus { isOpen: boolean; session: string | null; holiday: string | null }
interface FhNews { id: number; datetime: number; headline: string; summary?: string; source?: string; url: string }
interface FhSearch { result: { symbol: string; description: string; displaySymbol: string; type: string }[] }
type FhWsMessage = { type: 'trade'; data: { s: string; p: number; t: number; v: number }[] } | { type: 'ping' } | { type: 'error'; msg: string };

interface Logger { info(msg: string): void; warn(msg: string): void }

export class FinnhubProvider extends BaseProvider {
  readonly name = 'Finnhub';
  protected readonly capabilities = new Set<Capability>(['quote', 'realtime', 'search', 'news']);

  private fundamentals = new Memo<{ profile: FhProfile; metric: Record<string, number | null> }>(12 * 3600_000);
  private status = new Memo<FhStatus>(60_000);

  // realtime
  private ws: WebSocket | null = null;
  private symbols = new Set<string>();
  private backoff = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly apiKey: string | undefined, private readonly log: Logger = console) {
    super();
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  private get<T>(path: string) {
    return getJson<T>(this.name, `${BASE}${path}`, { 'X-Finnhub-Token': this.apiKey! });
  }

  private meta() {
    return { source: this.name, updatedAt: new Date().toISOString() };
  }

  // ---------- market status ----------
  async marketState(): Promise<MarketState> {
    const s = await this.status.get('US', () => this.get<FhStatus>('/stock/market-status?exchange=US'));
    if (s.session === 'regular' || (s.isOpen && !s.session)) return 'open';
    if (s.session === 'pre-market') return 'pre';
    if (s.session === 'post-market') return 'post';
    return 'closed';
  }

  private getFundamentals(symbol: string) {
    return this.fundamentals.get(symbol, async () => {
      const [profile, metric] = await Promise.all([
        this.get<FhProfile>(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`).catch(() => ({}) as FhProfile),
        this.get<FhMetric>(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`).catch(() => ({}) as FhMetric),
      ]);
      return { profile, metric: metric.metric ?? {} };
    });
  }

  // ---------- REST ----------
  async getQuote(symbol: string): Promise<Quote> {
    const [q, f, state] = await Promise.all([
      this.get<FhQuote>(`/quote?symbol=${encodeURIComponent(symbol)}`),
      this.getFundamentals(symbol),
      this.marketState().catch(() => 'closed' as MarketState),
    ]);
    // Finnhub answers unknown symbols with all zeros.
    if (!q || (q.c === 0 && q.t === 0)) throw new NotFoundError(`Symbol ${symbol}`);
    const m = f.metric;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const mcapM = num(f.profile.marketCapitalization) ?? num(m.marketCapitalization);
    const avgVolM = num(m['10DayAverageTradingVolume']);
    return {
      symbol,
      name: f.profile.name || null,
      exchange: f.profile.exchange ? shortExchange(f.profile.exchange) : null,
      currency: f.profile.currency || 'USD',
      price: num(q.c),
      change: num(q.d),
      changePct: num(q.dp),
      open: num(q.o) || null,
      high: num(q.h) || null,
      low: num(q.l) || null,
      prevClose: num(q.pc) || null,
      volume: null, // not in Finnhub's quote; filled from the keyStats provider (FMP)
      avgVolume: avgVolM != null ? Math.round(avgVolM * 1_000_000) : null,
      marketCap: mcapM != null ? Math.round(mcapM * 1_000_000) : null,
      peTTM: num(m.peTTM) ?? num(m.peBasicExclExtraTTM),
      week52High: num(m['52WeekHigh']),
      week52Low: num(m['52WeekLow']),
      dividendYield: num(m.currentDividendYieldTTM) ?? num(m.dividendYieldIndicatedAnnual),
      ts: q.t ? q.t * 1000 : Date.now(),
      marketState: state,
      delayed: false, // Finnhub free plan streams real-time US trades
      meta: this.meta(),
    };
  }

  async searchSymbols(query: string): Promise<SymbolMatch[]> {
    const r = await this.get<FhSearch>(`/search?q=${encodeURIComponent(query)}&exchange=US`);
    return (r.result ?? [])
      .filter((x) => x.type === 'Common Stock' || x.type === 'ETP' || x.type === 'ADR')
      .slice(0, 10)
      .map((x) => ({ symbol: x.symbol, name: x.description, exchange: 'US', type: x.type }));
  }

  async getNews(symbol: string, fromMs: number, toMs: number): Promise<NewsItem[]> {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const rows = await this.get<FhNews[]>(`/company-news?symbol=${encodeURIComponent(symbol)}&from=${day(fromMs)}&to=${day(toMs)}`);
    if (!Array.isArray(rows)) return [];
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    for (const r of rows.sort((a, b) => b.datetime - a.datetime)) {
      const ms = r.datetime * 1000;
      if (ms < fromMs || ms > toMs || !r.headline || !r.url) continue;
      const key = r.headline.trim().toLowerCase();
      if (seen.has(key)) continue; // same story syndicated by several outlets
      seen.add(key);
      out.push({
        id: `fh-${r.id}`,
        headline: r.headline.trim(),
        snippet: (r.summary ?? '').trim().slice(0, 400),
        source: r.source || 'Unknown',
        url: r.url,
        publishedAt: new Date(ms).toISOString(),
        sentiment: null,
      });
    }
    return out;
  }

  // ---------- realtime (one upstream socket) ----------
  subscribe(symbols: string[]): void {
    for (const s of symbols) {
      if (this.symbols.has(s)) continue;
      this.symbols.add(s);
      this.send({ type: 'subscribe', symbol: s });
    }
    this.connect();
  }

  unsubscribe(symbols: string[]): void {
    for (const s of symbols) {
      if (this.symbols.delete(s)) this.send({ type: 'unsubscribe', symbol: s });
    }
    if (this.symbols.size === 0) this.disconnect();
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect() {
    if (this.ws || this.reconnectTimer || !this.apiKey) return;
    const ws = new WebSocket(`${WS_URL}?token=${this.apiKey}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.backoff = 1000;
      this.log.info(`Finnhub WS connected (${this.symbols.size} symbols)`);
      for (const s of this.symbols) this.send({ type: 'subscribe', symbol: s });
    });
    ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
    ws.addEventListener('close', (e) => {
      this.ws = null;
      if (this.symbols.size === 0) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.log.warn(`Finnhub WS closed (code ${e.code}); reconnecting in ${wait / 1000}s`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, wait);
    });
    ws.addEventListener('error', () => {
      // 'close' follows and handles the reconnect
    });
  }

  private disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private onMessage(raw: string) {
    let msg: FhWsMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'error') {
      this.log.warn(`Finnhub WS error: ${msg.msg}`);
      return;
    }
    if (msg.type !== 'trade') return;
    // One message can hold many trades: emit the latest per symbol, summing volume.
    const latest = new Map<string, { price: number; ts: number; volume: number }>();
    for (const t of msg.data) {
      const cur = latest.get(t.s);
      if (!cur || t.t >= cur.ts) latest.set(t.s, { price: t.p, ts: t.t, volume: (cur?.volume ?? 0) + (t.v ?? 0) });
      else cur.volume += t.v ?? 0;
    }
    for (const [symbol, t] of latest) this.emitTick({ symbol, price: t.price, ts: t.ts, volume: t.volume });
  }
}

function shortExchange(x: string): string {
  if (/nasdaq/i.test(x)) return 'NASDAQ';
  if (/new york stock exchange|nyse/i.test(x)) return 'NYSE';
  return x;
}
