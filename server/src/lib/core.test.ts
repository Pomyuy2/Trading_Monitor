import { bucketStart, isIntradayRange, isRange, RANGE_RESOLUTION, RANGES, type Range } from '@tm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cached, LruCache } from '../cache/cache.js';
import { ProviderAuthError, RateLimitError, type MarketDataProvider, type Tick } from '../providers/types.js';
import { RealtimeHub } from '../realtime/hub.js';
import { getJson } from './http.js';
import { withRateLimitRetry } from './retry.js';

// ---------------------------------------------------------------- range mapping
describe('range → candle size (spec table)', () => {
  it('matches the spec exactly', () => {
    expect(RANGE_RESOLUTION).toEqual({
      '1H': '1min',
      '1D': '5min',
      '1W': '30min',
      '1M': '1hour',
      '6M': '1day',
      '1Y': '1day',
      '5Y': '1week',
    });
    expect(RANGES).toEqual(['1H', '1D', '1W', '1M', '6M', '1Y', '5Y']);
  });

  it('classifies intraday ranges', () => {
    const intraday = RANGES.filter((r) => isIntradayRange(r));
    expect(intraday).toEqual(['1H', '1D', '1W', '1M']);
  });

  it('validates range strings', () => {
    expect(RANGES.every((r) => isRange(r))).toBe(true);
    expect(isRange('2D')).toBe(false);
    expect(isRange(undefined)).toBe(false);
  });

  it('puts a timestamp in the right candle bucket for each size', () => {
    const t = Date.parse('2026-11-11T14:47:31Z') / 1000; // a Wednesday
    const iso = (s: number) => new Date(s * 1000).toISOString();
    expect(iso(bucketStart(t, '1min'))).toBe('2026-11-11T14:47:00.000Z');
    expect(iso(bucketStart(t, '5min'))).toBe('2026-11-11T14:45:00.000Z');
    expect(iso(bucketStart(t, '30min'))).toBe('2026-11-11T14:30:00.000Z');
    expect(iso(bucketStart(t, '1hour'))).toBe('2026-11-11T14:00:00.000Z');
    expect(iso(bucketStart(t, '1day'))).toBe('2026-11-11T00:00:00.000Z');
    expect(iso(bucketStart(t, '1week'))).toBe('2026-11-09T00:00:00.000Z'); // Monday
  });

  it('weekly buckets always start on Monday, including on Sundays', () => {
    const sunday = Date.parse('2026-11-15T23:59:00Z') / 1000;
    expect(new Date(bucketStart(sunday, '1week') * 1000).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    for (const r of ['5Y'] as Range[]) expect(RANGE_RESOLUTION[r]).toBe('1week');
  });
});

// ---------------------------------------------------------------- cache
describe('cache with stale fallback', () => {
  it('serves fresh hits without calling the fetcher', async () => {
    const c = new LruCache();
    const f = vi.fn(async () => 'v');
    await cached(c, 'k', 60_000, f);
    const r = await cached(c, 'k', 60_000, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ value: 'v', stale: false });
  });

  it('serves the old value marked stale when the provider fails after expiry', async () => {
    const c = new LruCache();
    await cached(c, 'k', 1, async () => 'old');
    await new Promise((r) => setTimeout(r, 5));
    const r = await cached(c, 'k', 1, async () => {
      throw new RateLimitError('X');
    });
    expect(r).toMatchObject({ value: 'old', stale: true });
  });

  it('rethrows when there is nothing cached to fall back to', async () => {
    await expect(cached(new LruCache(), 'k', 1000, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });

  it('supports a TTL computed from the value', async () => {
    const c = new LruCache();
    await cached(c, 'k', (v: number) => v, async () => 50_000);
    const e = await c.get<number>('k');
    expect(e!.expiresAt - e!.storedAt).toBe(50_000);
  });

  it('evicts the least recently used entry', async () => {
    const c = new LruCache(2);
    await c.set('a', 1, 1000);
    await c.set('b', 2, 1000);
    await c.get('a'); // a is now most recent
    await c.set('c', 3, 1000);
    expect(await c.get('b')).toBeUndefined();
    expect((await c.get('a'))?.value).toBe(1);
  });
});

// ---------------------------------------------------------------- HTTP + retry
describe('provider HTTP errors', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, headers: Record<string, string> = {}) =>
    vi.stubGlobal('fetch', async () => new Response('{}', { status, headers }));

  it('maps 429 (with Retry-After) to RateLimitError', async () => {
    respond(429, { 'retry-after': '7' });
    const err = (await getJson('P', 'https://x').catch((e) => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(7000);
  });

  it('maps 401/402/403 to ProviderAuthError', async () => {
    for (const s of [401, 402, 403]) {
      respond(s);
      await expect(getJson('P', 'https://x')).rejects.toBeInstanceOf(ProviderAuthError);
    }
  });

  it('never puts the URL (which may contain a key) in the error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const err = (await getJson('P', 'https://api.example.com/x?apikey=SECRET').catch((e) => e)) as Error;
    expect(String(err.message)).not.toContain('SECRET');
  });

  it('retries a rate limit with backoff, but gives up at once on long waits', async () => {
    let n = 0;
    const ok = await withRateLimitRetry(async () => {
      if (n++ < 2) throw new RateLimitError('P', 1);
      return 'done';
    });
    expect(ok).toBe('done');
    let m = 0;
    await expect(
      withRateLimitRetry(async () => {
        m++;
        throw new RateLimitError('P', 60_000);
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(m).toBe(1); // no inline wait for a minute-long limit
  });
});

// ---------------------------------------------------------------- WebSocket hub
class FakeUpstream {
  handlers = new Set<(t: Tick) => void>();
  subscribed = new Set<string>();
  subscribe = vi.fn((s: string[]) => s.forEach((x) => this.subscribed.add(x)));
  unsubscribe = vi.fn((s: string[]) => s.forEach((x) => this.subscribed.delete(x)));
  onTick(h: (t: Tick) => void) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  emit(t: Tick) {
    this.handlers.forEach((h) => h(t));
  }
}

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: { type: string; symbol?: string; price?: number; volume?: number }[] = [];
  private listeners: Record<string, ((x: unknown) => void)[]> = {};
  on(ev: string, fn: (x: unknown) => void) {
    (this.listeners[ev] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  fire(ev: string, x?: unknown) {
    this.listeners[ev]?.forEach((f) => f(x));
  }
}

describe('RealtimeHub (one upstream, fan-out, 1 msg/s/symbol)', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers({ now: 1_000_000 });
    const up = new FakeUpstream();
    const hub = new RealtimeHub(up as unknown as MarketDataProvider, 1000);
    const ws = new FakeSocket();
    hub.addClient(ws as never);
    ws.fire('message', Buffer.from(JSON.stringify({ type: 'subscribe', symbols: ['aapl', 'BAD SYMBOL!'] })));
    return { up, hub, ws };
  }

  it('subscribes upstream once per symbol and ignores invalid symbols', () => {
    const { up, hub } = setup();
    const ws2 = new FakeSocket();
    hub.addClient(ws2 as never);
    ws2.fire('message', Buffer.from(JSON.stringify({ type: 'subscribe', symbols: ['AAPL'] })));
    expect(up.subscribe).toHaveBeenCalledTimes(1);
    expect([...up.subscribed]).toEqual(['AAPL']);
  });

  it('throttles to one message per second, sending the latest price and the summed volume', () => {
    const { up, ws } = setup();
    up.emit({ symbol: 'AAPL', price: 100, ts: 1, volume: 1 }); // sent immediately
    vi.advanceTimersByTime(250);
    up.emit({ symbol: 'AAPL', price: 101, ts: 2, volume: 2 });
    vi.advanceTimersByTime(250);
    up.emit({ symbol: 'AAPL', price: 102, ts: 3, volume: 3 });
    expect(ws.sent).toHaveLength(1);
    vi.advanceTimersByTime(500); // window ends → trailing send of the latest tick
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[1]).toMatchObject({ type: 'tick', symbol: 'AAPL', price: 102, volume: 5 });
  });

  it('never sends more than one message per second under a burst', () => {
    const { up, ws } = setup();
    for (let i = 0; i < 40; i++) {
      up.emit({ symbol: 'AAPL', price: 100 + i, ts: i, volume: 1 });
      vi.advanceTimersByTime(100); // 10 ticks/s for 4 s
    }
    vi.advanceTimersByTime(1000);
    expect(ws.sent.length).toBeGreaterThanOrEqual(4);
    expect(ws.sent.length).toBeLessThanOrEqual(5);
  });

  it('unsubscribes upstream when the last client leaves', () => {
    const { up, ws } = setup();
    ws.fire('close');
    expect(up.unsubscribe).toHaveBeenCalledWith(['AAPL']);
    expect(up.subscribed.size).toBe(0);
  });

  it('keeps streaming for server-side subscribers (alerts) with no browser open', () => {
    const { up, hub, ws } = setup();
    hub.retainInternal(['AAPL']);
    ws.fire('close');
    expect(up.subscribed.has('AAPL')).toBe(true);
    hub.releaseInternal(['AAPL']);
    expect(up.subscribed.has('AAPL')).toBe(false);
  });

  it('replies with an error to malformed messages', () => {
    const { ws } = setup();
    ws.fire('message', Buffer.from('not json'));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error' });
  });
});
