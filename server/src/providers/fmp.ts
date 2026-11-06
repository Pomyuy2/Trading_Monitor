import {
  bucketStart,
  RANGE_SECONDS,
  type Candle,
  type CandleSeries,
  type DividendEvent,
  type EarningsReport,
  type EarningsEvent,
  type Estimates,
  type Person,
  type PriceTargets,
  type Profile,
  type Range,
  type Ratings,
  type SourceMeta,
} from '@tm/shared';
import { getJson } from '../lib/http.js';
import { dateToUtcSec } from '../lib/market-time.js';
import { Memo } from '../lib/memo.js';
import { BaseProvider, NotFoundError, NotSupportedError, type Capability, type KeyStats } from './types.js';

/**
 * Financial Modeling Prep (https://financialmodelingprep.com), "stable" API.
 * Daily candles (6M / 1Y / 5Y), today's volume, company profile + executives,
 * analyst estimates, price targets, ratings, next earnings date.
 *
 * Free plan notes: 250 calls/day, ~5 years of daily history; intraday charts
 * and earnings-call transcripts are paid (HTTP 402) — intraday comes from Twelve Data.
 * One 5-year daily download per symbol per hour serves all three daily ranges.
 */
const BASE = 'https://financialmodelingprep.com/stable';

interface FmpEodRow { date: string; open: number; high: number; low: number; close: number; volume: number }
interface FmpProfile {
  companyName?: string; description?: string; ceo?: string; fullTimeEmployees?: string | number;
  city?: string; state?: string; country?: string; website?: string;
}
interface FmpExec { title?: string; name?: string; titleSince?: string | number | null; active?: boolean }
interface FmpEstimate { date: string; revenueAvg?: number; epsAvg?: number; numAnalystsEps?: number; numAnalystsRevenue?: number }
interface FmpTargets { targetHigh?: number; targetLow?: number; targetConsensus?: number }
interface FmpGrades { strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number }
interface FmpEarnings { date: string; epsActual?: number | null }
interface FmpEarningsRow { date: string; epsActual?: number | null; epsEstimated?: number | null; revenueActual?: number | null; revenueEstimated?: number | null }
interface FmpDividend { date: string; dividend?: number; paymentDate?: string }
interface FmpQuote { symbol: string; volume?: number; open?: number; dayHigh?: number; dayLow?: number; previousClose?: number; marketCap?: number; yearHigh?: number; yearLow?: number }

export class FmpProvider extends BaseProvider {
  readonly name = 'FMP';
  protected readonly capabilities = new Set<Capability>(['dailyCandles', 'keyStats', 'profile', 'estimates', 'priceTargets', 'ratings', 'earningsCalendar', 'dividends', 'earningsHistory']);

  private eod = new Memo<Candle[]>(3600_000);

  constructor(private readonly apiKey: string | undefined) {
    super();
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  private get<T>(path: string) {
    // FMP only accepts the key as a query parameter; getJson never logs URLs.
    const sep = path.includes('?') ? '&' : '?';
    return getJson<T>(this.name, `${BASE}${path}${sep}apikey=${this.apiKey}`);
  }

  private dailyBars(symbol: string): Promise<Candle[]> {
    return this.eod.get(symbol, async () => {
      const from = new Date(Date.now() - (5 * 365 + 10) * 86400_000).toISOString().slice(0, 10);
      const rows = await this.get<FmpEodRow[]>(`/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}`);
      if (!Array.isArray(rows)) return [];
      return rows
        .map((r) => ({ time: dateToUtcSec(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }))
        .sort((a, b) => a.time - b.time);
    });
  }

  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    if (range !== '6M' && range !== '1Y' && range !== '5Y') throw new NotSupportedError(this.name, `getCandles(${range})`);
    const daily = await this.dailyBars(symbol);
    const cutoff = Date.now() / 1000 - RANGE_SECONDS[range];
    const inRange = daily.filter((c) => c.time >= cutoff);
    const candles = range === '5Y' ? toWeekly(inRange) : inRange;
    return {
      symbol,
      range,
      resolution: range === '5Y' ? '1week' : '1day',
      candles,
      meta: { source: this.name, updatedAt: new Date().toISOString() },
    };
  }

  private meta(note?: string): SourceMeta {
    return { source: this.name, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) };
  }

  private first<T>(rows: T[] | unknown): T | undefined {
    return Array.isArray(rows) ? (rows[0] as T | undefined) : undefined;
  }

  async getProfile(symbol: string): Promise<Profile> {
    const q = encodeURIComponent(symbol);
    const [rows, execs] = await Promise.all([
      this.get<FmpProfile[]>(`/profile?symbol=${q}`),
      this.get<FmpExec[]>(`/key-executives?symbol=${q}`).catch(() => [] as FmpExec[]),
    ]);
    const p = this.first<FmpProfile>(rows);
    if (!p?.companyName) throw new NotFoundError(`Profile for ${symbol}`);
    const active = (Array.isArray(execs) ? execs : []).filter((e) => e.active !== false && e.name && e.title);
    const findExec = (re: RegExp) => active.find((e) => re.test(e.title!));
    const ceoExec = findExec(/chief executive officer|\bceo\b/i);
    const cfoExec = findExec(/chief financial officer|\bcfo\b/i);
    const year = (v: unknown) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v.slice(0, 4), 10) : NaN;
      return Number.isFinite(n) && n > 1800 ? n : null;
    };
    const ceoName = p.ceo?.trim() || ceoExec?.name || null;
    const ceo: Person | null = ceoName
      ? { name: ceoName, since: ceoExec && sameName(ceoExec.name!, ceoName) ? year(ceoExec.titleSince) : null }
      : null;
    const cfo: Person | null = cfoExec ? { name: cfoExec.name!, since: year(cfoExec.titleSince) } : null;
    const employees = Number(p.fullTimeEmployees);
    const hq = [p.city, p.state, p.country].filter((x) => x && String(x).trim()).join(', ') || null;
    return {
      symbol,
      name: p.companyName,
      description: oneLine(p.description),
      ceo,
      cfo,
      hq,
      founded: null, // not provided by FMP (only the IPO date) — shown as "—", never guessed
      employees: Number.isFinite(employees) && employees > 0 ? employees : null,
      website: p.website || null,
      meta: this.meta(),
    };
  }

  /** Estimates for the fiscal year in progress (the first fiscal year ending after today). */
  async getEstimates(symbol: string): Promise<Estimates> {
    const rows = await this.get<FmpEstimate[]>(`/analyst-estimates?symbol=${encodeURIComponent(symbol)}&period=annual&limit=10`);
    const today = new Date().toISOString().slice(0, 10);
    const next = (Array.isArray(rows) ? rows : []).filter((r) => r.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!next) return { fiscalYear: null, revenueAvg: null, epsAvg: null, analystCount: null, meta: this.meta('No estimates from source') };
    return {
      fiscalYear: Number(next.date.slice(0, 4)),
      revenueAvg: next.revenueAvg ?? null,
      epsAvg: next.epsAvg ?? null,
      analystCount: next.numAnalystsEps ?? next.numAnalystsRevenue ?? null,
      meta: this.meta(),
    };
  }

  async getPriceTargets(symbol: string): Promise<PriceTargets> {
    const t = this.first<FmpTargets>(await this.get<FmpTargets[]>(`/price-target-consensus?symbol=${encodeURIComponent(symbol)}`));
    if (!t || t.targetConsensus == null) return { low: null, avg: null, high: null, meta: this.meta('No price targets from source') };
    return { low: t.targetLow ?? null, avg: t.targetConsensus, high: t.targetHigh ?? null, meta: this.meta() };
  }

  /** Buy = strong buy + buy; Sell = sell + strong sell. */
  async getRatings(symbol: string): Promise<Ratings> {
    const g = this.first<FmpGrades>(await this.get<FmpGrades[]>(`/grades-consensus?symbol=${encodeURIComponent(symbol)}`));
    if (!g) return { buy: null, hold: null, sell: null, meta: this.meta('No ratings from source') };
    return {
      buy: (g.strongBuy ?? 0) + (g.buy ?? 0),
      hold: g.hold ?? 0,
      sell: (g.sell ?? 0) + (g.strongSell ?? 0),
      meta: this.meta(),
    };
  }

  async getEarningsCalendar(symbol: string): Promise<EarningsEvent> {
    const rows = await this.get<FmpEarnings[]>(`/earnings?symbol=${encodeURIComponent(symbol)}&limit=3`);
    const today = new Date().toISOString().slice(0, 10);
    const next = (Array.isArray(rows) ? rows : [])
      .filter((r) => r.date >= today && r.epsActual == null)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return { date: next?.date ?? null, meta: this.meta(next ? undefined : 'No upcoming date from source') };
  }

  /** Free plan: at most 5 rows = the next report + the last 4 (with EPS actual vs estimate). */
  async getEarningsHistory(symbol: string, fromMs: number, toMs: number): Promise<EarningsReport[]> {
    const rows = await this.get<FmpEarningsRow[]>(`/earnings?symbol=${encodeURIComponent(symbol)}&limit=5`);
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const to = new Date(toMs).toISOString().slice(0, 10);
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r.date >= from && r.date <= to)
      .map((r) => ({
        date: r.date,
        hour: null,
        epsActual: r.epsActual ?? null,
        epsEstimate: r.epsEstimated ?? null,
        revenueActual: r.revenueActual ?? null,
        revenueEstimate: r.revenueEstimated ?? null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getDividends(symbol: string): Promise<DividendEvent[]> {
    const rows = await this.get<FmpDividend[]>(`/dividends?symbol=${encodeURIComponent(symbol)}`);
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r.date && typeof r.dividend === 'number' && r.dividend > 0)
      .map((r) => ({ exDate: r.date, amount: r.dividend!, paymentDate: r.paymentDate || null }))
      .sort((a, b) => a.exDate.localeCompare(b.exDate));
  }

  async getKeyStats(symbol: string): Promise<KeyStats> {
    const rows = await this.get<FmpQuote[]>(`/quote?symbol=${encodeURIComponent(symbol)}`);
    const q = Array.isArray(rows) ? rows[0] : undefined;
    return {
      volume: q?.volume ?? null,
      meta: { source: this.name, updatedAt: new Date().toISOString() },
    };
  }
}

/** Aggregate daily bars into Monday-aligned weekly bars. */
export function toWeekly(daily: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const d of daily) {
    const t = bucketStart(d.time, '1week');
    const w = out[out.length - 1];
    if (w && w.time === t) {
      w.high = Math.max(w.high, d.high);
      w.low = Math.min(w.low, d.low);
      w.close = d.close;
      w.volume += d.volume;
    } else {
      out.push({ ...d, time: t });
    }
  }
  return out;
}

/** First sentence of a long description (the card shows one line). */
function oneLine(text: string | undefined): string | null {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const m = t.match(/^(.{40,}?[.!?])\s+[A-Z]/);
  const first = m ? m[1] : t;
  return first.length > 260 ? first.slice(0, 257).trimEnd() + '…' : first;
}

/** "Timothy D. Cook" vs "Tim Cook": compare last names. */
function sameName(a: string, b: string): boolean {
  const last = (s: string) => s.replace(/[.,]/g, '').trim().split(/\s+/).pop()?.toLowerCase();
  return last(a) === last(b);
}
