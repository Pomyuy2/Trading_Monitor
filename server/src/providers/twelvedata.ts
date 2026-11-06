import { RANGE_RESOLUTION, type Candle, type CandleSeries, type Range, type Resolution } from '@tm/shared';
import { getJson } from '../lib/http.js';
import { nyDate } from '../lib/market-time.js';
import { BaseProvider, NotSupportedError, ProviderAuthError, RateLimitError, type Capability } from './types.js';

/**
 * Twelve Data (https://twelvedata.com): intraday candles for 1H / 1D / 1W / 1M.
 * Free "Basic" plan: 800 credits/day, 8/min; regular-hours bars only.
 */
const BASE = 'https://api.twelvedata.com';
const PER_MINUTE = 8;

const INTERVAL: Partial<Record<Resolution, string>> = { '1min': '1min', '5min': '5min', '30min': '30min', '1hour': '1h' };

/** How many bars to request, and how to trim them, per range. */
const PLAN: Partial<Record<Range, { outputsize: number; keep: (bars: Candle[]) => Candle[] }>> = {
  '1H': { outputsize: 60, keep: (b) => b },
  // the latest trading session only
  '1D': { outputsize: 100, keep: (b) => (b.length ? b.filter((c) => nyDate(c.time) === nyDate(b[b.length - 1].time)) : b) },
  '1W': { outputsize: 80, keep: (b) => withinDays(b, 7) },
  '1M': { outputsize: 180, keep: (b) => withinDays(b, 30) },
};

function withinDays(bars: Candle[], days: number) {
  if (!bars.length) return bars;
  const cutoff = bars[bars.length - 1].time - days * 86400;
  return bars.filter((c) => c.time > cutoff);
}

interface TdResponse {
  status?: 'ok' | 'error';
  code?: number;
  message?: string;
  values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[];
}

export class TwelveDataProvider extends BaseProvider {
  readonly name = 'Twelve Data';
  protected readonly capabilities = new Set<Capability>(['intradayCandles']);
  private recent: number[] = []; // request timestamps in the last minute

  constructor(private readonly apiKey: string | undefined) {
    super();
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async getCandles(symbol: string, range: Range): Promise<CandleSeries> {
    const res = RANGE_RESOLUTION[range];
    const interval = INTERVAL[res];
    const plan = PLAN[range];
    if (!interval || !plan) throw new NotSupportedError(this.name, `getCandles(${range})`);

    // Free plan: 8 requests/minute. Refuse locally instead of burning a request on a 429.
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= PER_MINUTE) throw new RateLimitError(this.name, 60_000 - (now - this.recent[0]));
    this.recent.push(now);

    const url = `${BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${plan.outputsize}&timezone=UTC&order=asc`;
    let r: TdResponse;
    try {
      r = await getJson<TdResponse>(this.name, url, { Authorization: `apikey ${this.apiKey}` });
    } catch (err) {
      // A 429 here means the per-minute budget is gone: retrying within seconds can't help.
      if (err instanceof RateLimitError) throw new RateLimitError(this.name, 60_000);
      throw err;
    }

    // Twelve Data reports errors in the body, often with HTTP 200.
    if (r.status === 'error') {
      if (r.code === 429) throw new RateLimitError(this.name, 60_000);
      if (r.code === 401 || r.code === 403) throw new ProviderAuthError(this.name, r.code, r.message);
      if (r.code === 400 || r.code === 404) {
        return { symbol, range, resolution: res, candles: [], meta: { source: this.name, updatedAt: new Date().toISOString(), note: 'No intraday data for this symbol' } };
      }
      throw new Error(`${this.name} error ${r.code ?? ''}`);
    }

    const bars: Candle[] = (r.values ?? [])
      .map((v) => ({
        time: Date.parse(`${v.datetime.replace(' ', 'T')}Z`) / 1000,
        open: +v.open,
        high: +v.high,
        low: +v.low,
        close: +v.close,
        volume: v.volume ? +v.volume : 0,
      }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);

    return { symbol, range, resolution: res, candles: plan.keep(bars), meta: { source: this.name, updatedAt: new Date().toISOString() } };
  }
}
