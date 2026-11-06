import { bucketStart, RANGE_SECONDS, type Candle, type CandleSeries, type Range } from '@tm/shared';
import { getJson } from '../lib/http.js';
import { dateToUtcSec } from '../lib/market-time.js';
import { Memo } from '../lib/memo.js';
import { BaseProvider, NotSupportedError, type Capability, type KeyStats } from './types.js';

/**
 * Financial Modeling Prep (https://financialmodelingprep.com), "stable" API.
 * Phase 2: daily candles (6M / 1Y / 5Y) and today's volume.
 * TODO(Phase 4): analyst estimates, price targets, ratings, earnings calendar.
 *
 * Free plan notes: 250 calls/day, ~5 years of daily history; intraday charts
 * and earnings-call transcripts are paid (HTTP 402) — intraday comes from Twelve Data.
 * One 5-year daily download per symbol per hour serves all three daily ranges.
 */
const BASE = 'https://financialmodelingprep.com/stable';

interface FmpEodRow { date: string; open: number; high: number; low: number; close: number; volume: number }
interface FmpQuote { symbol: string; volume?: number; open?: number; dayHigh?: number; dayLow?: number; previousClose?: number; marketCap?: number; yearHigh?: number; yearLow?: number }

export class FmpProvider extends BaseProvider {
  readonly name = 'FMP';
  protected readonly capabilities = new Set<Capability>(['dailyCandles', 'keyStats']);

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
