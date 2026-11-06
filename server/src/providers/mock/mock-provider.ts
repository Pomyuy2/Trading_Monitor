import {
  bucketStart,
  RANGE_RESOLUTION,
  RANGE_SECONDS,
  RESOLUTION_SECONDS,
  type Candle,
  type CandleSeries,
  type DividendEvent,
  type EarningsReport,
  type EarningsEvent,
  type Estimates,
  type Guidance,
  type GuidanceField,
  type Lang,
  type NewsItem,
  type PriceTargets,
  type Profile,
  type Quote,
  type Range,
  type Ratings,
  type Resolution,
  type SourceMeta,
  type SymbolMatch,
  type Transcript,
} from '@tm/shared';
import { BaseProvider, NotFoundError, type Capability, type KeyStats } from '../types.js';
import { COMPANIES, GENERIC_NEWS, MOCK_SOURCES, type MockCompany, type MockGuidanceField } from './fixtures.js';

export type MockMarketState = 'open' | 'closed' | 'delayed';

const DAY = 86400;
const TICK_INTERVAL_MS = 250; // faster than 1/s on purpose, to exercise the server-side throttle

// ---------- deterministic randomness ----------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const isWeekend = (tsSec: number) => {
  const d = new Date(tsSec * 1000).getUTCDay();
  return d === 0 || d === 6;
};

interface SymbolState {
  company: MockCompany;
  minutes: Candle[]; // continuous 1-minute bars, oldest first
  price: number;
  rand: () => number;
}

export class MockProvider extends BaseProvider {
  readonly name = 'Mock';
  protected readonly capabilities = new Set<Capability>([
    'search', 'quote', 'intradayCandles', 'dailyCandles', 'keyStats', 'realtime', 'profile', 'news',
    'estimates', 'priceTargets', 'ratings', 'earningsCalendar', 'transcripts', 'earningsHistory', 'dividends',
  ]);
  private states = new Map<string, SymbolState>();
  private subscribed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly bootMs = Date.now();

  constructor(private readonly marketState: MockMarketState = 'open') {
    super();
  }

  isAvailable(): boolean {
    return true;
  }

  // ---------- helpers ----------
  private company(symbol: string): MockCompany {
    const c = COMPANIES.find((x) => x.symbol === symbol);
    if (!c) throw new NotFoundError(`Symbol ${symbol}`);
    return c;
  }

  private meta(note?: string): SourceMeta {
    return { source: this.name, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) };
  }

  /** Lazily build 24 h of 1-minute bars bridging prevClose → fixture price. */
  private state(symbol: string): SymbolState {
    let st = this.states.get(symbol);
    if (st) return st;
    const c = this.company(symbol);
    const rand = mulberry32(hash(`${symbol}:minutes`));
    const nowSec = Math.floor(Date.now() / 1000);
    const lastBucket = bucketStart(nowSec, '1min');
    const n = 24 * 60 + 1;
    const sigma = c.dailyVol / Math.sqrt(24 * 60);
    // random walk W, then Brownian bridge to hit both endpoints
    const w: number[] = [0];
    for (let i = 1; i < n; i++) w.push(w[i - 1] + sigma * gaussian(rand));
    const target = Math.log(c.price / c.prevClose);
    const logP = w.map((wi, i) => Math.log(c.prevClose) + wi - (i / (n - 1)) * (w[n - 1] - target));
    const volPerMin = (c.avgVolume ?? 5_000_000) / (6.5 * 60);
    const minutes: Candle[] = [];
    let prev = c.prevClose;
    for (let i = 0; i < n; i++) {
      const close = Math.exp(logP[i]);
      const open = prev;
      const wick = sigma * 0.5;
      minutes.push({
        time: lastBucket - (n - 1 - i) * 60,
        open,
        close,
        high: Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * wick),
        low: Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * wick),
        volume: Math.round(volPerMin * (0.3 + rand() * 1.4) * 0.27),
      });
      prev = close;
    }
    st = { company: c, minutes, price: c.price, rand: mulberry32(hash(`${symbol}:live:${Date.now()}`)) };
    this.states.set(symbol, st);
    return st;
  }

  private step(st: SymbolState) {
    const c = st.company;
    const sigma = (c.dailyVol / Math.sqrt(6.5 * 3600)) * Math.sqrt(TICK_INTERVAL_MS / 1000) * 2;
    const reversion = -0.002 * Math.log(st.price / c.price); // keep long dev sessions near the fixture price
    st.price = st.price * Math.exp(sigma * gaussian(st.rand) + reversion);
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = bucketStart(nowSec, '1min');
    const last = st.minutes[st.minutes.length - 1];
    const vol = Math.round(((c.avgVolume ?? 5_000_000) / (6.5 * 3600)) * (TICK_INTERVAL_MS / 1000) * st.rand() * 2);
    if (last.time === bucket) {
      last.close = st.price;
      last.high = Math.max(last.high, st.price);
      last.low = Math.min(last.low, st.price);
      last.volume += vol;
    } else {
      st.minutes.push({ time: bucket, open: last.close, high: Math.max(last.close, st.price), low: Math.min(last.close, st.price), close: st.price, volume: vol });
    }
    return vol;
  }

  private ensureTimer() {
    if (this.timer || this.marketState === 'closed') return;
    this.timer = setInterval(() => {
      for (const symbol of this.subscribed) {
        const st = this.states.get(symbol);
        if (!st) continue;
        const vol = this.step(st);
        this.emitTick({ symbol, price: r2(st.price), ts: Date.now(), volume: vol });
      }
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  // ---------- MarketDataProvider ----------
  async searchSymbols(query: string): Promise<SymbolMatch[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return COMPANIES.filter((c) => c.symbol.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q))
      .slice(0, 10)
      .map((c) => ({ symbol: c.symbol, name: c.name, exchange: c.exchange, type: c.type }));
  }

  async getQuote(symbol: string): Promise<Quote> {
    const st = this.state(symbol);
    const c = st.company;
    const bars = st.minutes;
    const high = Math.max(...bars.map((b) => b.high));
    const low = Math.min(...bars.map((b) => b.low));
    const volume = bars.reduce((s, b) => s + b.volume, 0);
    const price = st.price;
    const change = price - c.prevClose;
    return {
      symbol,
      name: c.name,
      exchange: c.exchange,
      currency: 'USD',
      price: r2(price),
      change: r2(change),
      changePct: Math.round((change / c.prevClose) * 10000) / 100,
      open: r2(bars[0].open),
      high: r2(high),
      low: r2(low),
      prevClose: c.prevClose,
      volume,
      avgVolume: c.avgVolume,
      marketCap: Math.round(price * c.sharesOut),
      peTTM: c.peTTM,
      week52High: r2(Math.max(c.week52High, high)),
      week52Low: r2(Math.min(c.week52Low, low)),
      dividendYield: c.dividendYield,
      ts: Date.now(),
      marketState: this.marketState === 'closed' ? 'closed' : 'open',
      delayed: this.marketState === 'delayed',
      meta: this.meta(),
    };
  }

  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    const st = this.state(symbol);
    const c = st.company;
    const res = RANGE_RESOLUTION[range];
    const resSec = RESOLUTION_SECONDS[res];
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - RANGE_SECONDS[range];

    // Recent part: aggregate the live 1-minute path.
    const recent = aggregate(st.minutes.filter((b) => b.time >= windowStart), res);

    // Older part: deterministic synthetic history ending where the minute path starts.
    const firstRecent = recent[0]?.time ?? bucketStart(nowSec, res);
    const endPrice = recent[0]?.open ?? st.price;
    const daily = resSec >= DAY;
    const sigma = c.dailyVol * Math.sqrt(res === '1week' ? 5 : daily ? 1 : resSec / DAY);
    const driftPerDay = Math.log(c.fiveYearGrowth) / (5 * 252);
    const drift = driftPerDay * (res === '1week' ? 5 : daily ? 1 : resSec / DAY);
    const baseVol = c.avgVolume ?? 5_000_000;
    const volPerBar = res === '1week' ? baseVol * 5 : daily ? baseVol : (baseVol * resSec) / DAY;
    const older = synthBackward({
      seed: `${symbol}:${res}`,
      endBucket: firstRecent,
      startTime: windowStart,
      endPrice,
      resSec,
      sigma,
      drift,
      volPerBar,
      skipWeekends: res === '1day',
    });

    const candles = [...older, ...recent].map((b) => ({ ...b, open: r2(b.open), high: r2(b.high), low: r2(b.low), close: r2(b.close) }));
    return { symbol, range, resolution: res, candles, meta: this.meta() };
  }

  subscribe(symbols: string[]): void {
    for (const s of symbols) {
      try {
        this.state(s);
        this.subscribed.add(s);
      } catch {
        // unknown symbol: ignore
      }
    }
    this.ensureTimer();
  }

  unsubscribe(symbols: string[]): void {
    for (const s of symbols) this.subscribed.delete(s);
    if (this.subscribed.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async getProfile(symbol: string): Promise<Profile> {
    const c = this.company(symbol);
    return { symbol, name: c.name, ...c.profile, meta: this.meta() };
  }

  async getKeyStats(symbol: string): Promise<KeyStats> {
    const q = await this.getQuote(symbol);
    return { volume: q.volume, meta: q.meta };
  }

  async getNews(symbol: string, fromMs: number, toMs: number): Promise<NewsItem[]> {
    const c = COMPANIES.find((x) => x.symbol === symbol);
    if (!c) return []; // real symbols without fixtures: no mock news
    const short = c.name.replace(/,? (Inc\.|Corporation|Platforms|& Co\.|Inc|\.com).*$/, '').replace(/\.com$/, '');
    const raw = c.news ?? GENERIC_NEWS.map((n) => ({ ...n, headline: n.headline.replaceAll('{n}', short) }));
    return raw
      .map((n, i) => ({
        id: `${symbol}-${i}`,
        headline: n.headline,
        snippet: n.snippet,
        source: MOCK_SOURCES[(hash(symbol) + i) % MOCK_SOURCES.length],
        url: `https://example.com/mock-news/${symbol.toLowerCase()}-${i}`,
        publishedAt: new Date(this.bootMs - n.hoursAgo * 3600_000).toISOString(),
        sentiment: n.sentiment, // fixtures carry a tag so the UI works without an AI key
      }))
      .filter((n) => {
        const t = Date.parse(n.publishedAt);
        return t >= fromMs && t <= toMs;
      });
  }

  async getEstimates(symbol: string): Promise<Estimates> {
    const e = this.company(symbol).estimates;
    if (!e) return { fiscalYear: null, revenueAvg: null, epsAvg: null, analystCount: null, meta: this.meta('No estimates from source') };
    return { ...e, meta: this.meta() };
  }

  async getPriceTargets(symbol: string): Promise<PriceTargets> {
    const p = this.company(symbol).priceTargets;
    if (!p) return { low: null, avg: null, high: null, meta: this.meta('No price targets from source') };
    return { ...p, meta: this.meta() };
  }

  async getRatings(symbol: string): Promise<Ratings> {
    const r = this.company(symbol).ratings;
    if (!r) return { buy: null, hold: null, sell: null, meta: this.meta('No ratings from source') };
    return { ...r, meta: this.meta() };
  }

  async getEarningsCalendar(symbol: string): Promise<EarningsEvent> {
    const d = this.company(symbol).nextEarnings;
    return { date: d, meta: this.meta(d ? undefined : 'No upcoming date from source') };
  }

  /** Fake quarterly earnings: every ~91 days back from the fixture's next date. */
  async getEarningsHistory(symbol: string, fromMs: number, toMs: number): Promise<EarningsReport[]> {
    const c = this.company(symbol);
    if (!c.nextEarnings) return [];
    const rand = mulberry32(hash(`${symbol}:earnings`));
    const out: EarningsReport[] = [];
    let t = Date.parse(`${c.nextEarnings}T00:00:00Z`);
    for (let i = 0; i < 24 && t >= fromMs; i++, t -= 91 * 86400_000) {
      if (t > toMs) continue;
      const future = t > Date.now();
      const est = Math.round(((c.estimates?.epsAvg ?? 2) / 4) * (0.85 + rand() * 0.3) * 100) / 100;
      out.push({
        date: new Date(t).toISOString().slice(0, 10),
        hour: 'amc',
        epsEstimate: est,
        epsActual: future ? null : Math.round(est * (0.9 + rand() * 0.25) * 100) / 100,
        revenueActual: null,
        revenueEstimate: null,
      });
    }
    return out.reverse();
  }

  async getDividends(symbol: string): Promise<DividendEvent[]> {
    const c = this.company(symbol);
    if (!c.dividendYield) return [];
    const perQuarter = Math.round(((c.price * c.dividendYield) / 100 / 4) * 100) / 100;
    const out: DividendEvent[] = [];
    for (let i = 1; i <= 20; i++) {
      const t = Date.now() - (i * 91 - 30) * 86400_000;
      out.push({ exDate: new Date(t).toISOString().slice(0, 10), amount: perQuarter, paymentDate: new Date(t + 7 * 86400_000).toISOString().slice(0, 10) });
    }
    return out.reverse();
  }

  async getLatestTranscript(_symbol: string): Promise<Transcript | null> {
    // The mock serves pre-extracted guidance (see getMockGuidance) instead of transcript text.
    return null;
  }

  /** Mock-only: guidance as if already extracted by the AI step. */
  getMockGuidance(symbol: string, lang: Lang): Guidance | null {
    const g = this.company(symbol).guidance;
    if (!g) return null;
    const f = (x: MockGuidanceField | null): GuidanceField | null => (x ? { value: x.value[lang], quote: x.quote } : null);
    return {
      fiscalYear: g.fiscalYear,
      revenueGuidance: f(g.revenueGuidance),
      epsGuidance: f(g.epsGuidance),
      capexBudget: f(g.capexBudget),
      rndBudget: f(g.rndBudget),
      priorities: [0, 1, 2].map((i) => f(g.priorities[i] ?? null)),
      sourceTitle: g.sourceTitle,
      sourceDate: g.sourceDate,
      meta: this.meta(),
    };
  }
}

// ---------- candle helpers ----------
export function aggregate(bars: Candle[], res: Resolution): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const t = bucketStart(b.time, res);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else {
      out.push({ ...b, time: t });
    }
  }
  return out;
}

function synthBackward(o: {
  seed: string;
  endBucket: number; // first bucket NOT generated
  startTime: number;
  endPrice: number;
  resSec: number;
  sigma: number;
  drift: number;
  volPerBar: number;
  skipWeekends: boolean;
}): Candle[] {
  const rand = mulberry32(hash(o.seed));
  const bars: Candle[] = [];
  let close = o.endPrice;
  for (let t = o.endBucket - o.resSec; t >= o.startTime - o.resSec; t -= o.resSec) {
    if (o.skipWeekends && isWeekend(t)) continue;
    const open = close / Math.exp(o.drift + o.sigma * gaussian(rand));
    const wick = o.sigma * 0.6;
    bars.push({
      time: t,
      open,
      close,
      high: Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * wick),
      low: Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * wick),
      volume: Math.round(o.volPerBar * (0.5 + rand())),
    });
    close = open;
  }
  return bars.reverse();
}
