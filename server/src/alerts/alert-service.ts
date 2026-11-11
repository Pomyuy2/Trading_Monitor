import type { Alert as AlertRow, PrismaClient } from '@prisma/client';
import {
  bucketStart,
  isIntradayRange,
  NEAR_LEVEL_PCT,
  RANGE_RESOLUTION,
  RESOLUTION_SECONDS,
  type Alert,
  type AlertKind,
  type NewAlert,
  type Range,
  type Resolution,
} from '@tm/shared';
import type { Tick } from '../providers/types.js';
import type { MarketService } from '../services/market-service.js';

interface Logger { info(msg: string): void; warn(msg: string): void }

/** Keeps live data flowing for symbols with active alerts, even with no browser open. */
export interface SymbolRetainer {
  retainInternal(symbols: string[]): void;
  releaseInternal(symbols: string[]): void;
}

const QUOTE_POLL_MS = 60_000; // backup check when ticks are sparse
const DAILY_CHECK_MS = 10 * 60_000; // daily/weekly breakout closes

export class BadRequestError extends Error {
  readonly statusCode = 400;
}

/** Pure trigger rules (unit-tested). */
export function priceCrossed(kind: 'price_above' | 'price_below', target: number, price: number): boolean {
  return kind === 'price_above' ? price >= target : price <= target;
}

export function withinPct(price: number, level: number, pct = NEAR_LEVEL_PCT): boolean {
  return (Math.abs(price - level) / level) * 100 <= pct;
}

/** A close "beyond the zone": above a resistance zone, or below a support zone. */
export function closedBeyond(levelKind: 'support' | 'resistance', zoneLow: number, zoneHigh: number, close: number): boolean {
  return levelKind === 'resistance' ? close > zoneHigh : close < zoneLow;
}

/**
 * Server-side alerts:
 * - price_above / price_below: on every upstream tick (+ a once-a-minute quote check)
 * - near_level: price within 1 % of a level; armed only once price has been outside that band
 * - breakout: a candle closes beyond the level's zone. Intraday candle sizes are built from
 *   live ticks (no extra API calls); daily / weekly use cached daily candles.
 * Triggered alerts are pushed to browsers and stored, so they show on the next visit too.
 */
export class AlertService {
  private active = new Map<string, AlertRow[]>(); // symbol → active alerts
  private buckets = new Map<string, { bucket: number; last: number }>(); // `${symbol}|${resolution}` → current tick bucket
  private listeners = new Set<(a: Alert) => void>();
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>(); // alert ids being triggered (avoid double fires)
  private lastTick = new Map<string, { price: number; ts: number }>(); // latest upstream trade per symbol

  constructor(
    private readonly db: PrismaClient,
    private readonly market: MarketService,
    private readonly retainer: SymbolRetainer,
    private readonly log: Logger,
  ) {}

  async init() {
    const rows = await this.db.alert.findMany({ where: { status: 'active' } });
    for (const r of rows) this.track(r);
    this.timers.push(setInterval(() => void this.pollQuotes(), QUOTE_POLL_MS));
    this.timers.push(setInterval(() => void this.checkDailyBreakouts(), DAILY_CHECK_MS));
    for (const t of this.timers) t.unref?.();
    if (rows.length) this.log.info(`Alerts: watching ${rows.length} active alert(s)`);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  onTriggered(cb: (a: Alert) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---------- CRUD ----------
  async list(arg1?: string, arg2?: string): Promise<Alert[]> {
    let userId: string | undefined;
    let symbol: string | undefined;

    if (arg2 !== undefined) {
      userId = arg1;
      symbol = arg2;
    } else if (arg1 !== undefined) {
      if (/^[A-Z0-9.-]{1,15}$/.test(arg1)) {
        symbol = arg1;
      } else {
        userId = arg1;
      }
    }

    const rows = await this.db.alert.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(symbol ? { symbol } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toAlert);
  }

  async create(input: NewAlert, userId = 'default-user'): Promise<Alert> {
    // The REST quote can lag (e.g. it shows yesterday's close before the open while
    // pre-market trades stream in), so prefer the latest live trade when it's newer.
    const quote = await this.market.quote(input.symbol);
    const tick = this.lastTick.get(input.symbol);
    const price = tick && tick.ts > (quote.ts ?? 0) ? tick.price : quote.price;
    if (price == null) throw new BadRequestError('No current price for this symbol');

    let data: Parameters<PrismaClient['alert']['create']>[0]['data'];
    if ('targetPrice' in input) {
      const t = input.targetPrice;
      if (!(t > 0)) throw new BadRequestError('Target price must be positive');
      if (input.kind === 'price_above' && t <= price) throw new BadRequestError('Target must be above the current price');
      if (input.kind === 'price_below' && t >= price) throw new BadRequestError('Target must be below the current price');
      data = { symbol: input.symbol, kind: input.kind, targetPrice: t, userId };
    } else {
      const l = input.level;
      if (!(l.price > 0) || !(l.zoneLow <= l.price && l.price <= l.zoneHigh)) throw new BadRequestError('Invalid level');
      data = {
        symbol: input.symbol,
        kind: input.kind,
        levelKind: l.kind,
        levelPrice: l.price,
        zoneLow: l.zoneLow,
        zoneHigh: l.zoneHigh,
        levelRange: l.range,
        resolution: RANGE_RESOLUTION[l.range],
        // near_level: if price is already within 1 %, wait until it leaves the band first
        armed: input.kind === 'near_level' ? !withinPct(price, l.price) : true,
        userId,
      };
    }
    const row = await this.db.alert.create({ data });
    this.track(row);
    return toAlert(row);
  }

  async remove(id: string, userId?: string): Promise<boolean> {
    const row = await this.db.alert.findFirst({
      where: { id, ...(userId ? { userId } : {}) },
    });
    if (!row) return false;
    await this.db.alert.delete({ where: { id: row.id } });
    this.untrack(row);
    return true;
  }

  async markSeen(id: string, userId?: string): Promise<void> {
    await this.db.alert.updateMany({
      where: { id, ...(userId ? { userId } : {}) },
      data: { seen: true },
    });
  }

  // ---------- evaluation ----------
  /** Upstream ticks (unthrottled). */
  handleTick(t: Tick) {
    const prev = this.lastTick.get(t.symbol);
    if (!prev || t.ts >= prev.ts) this.lastTick.set(t.symbol, { price: t.price, ts: t.ts });
    const alerts = this.active.get(t.symbol);
    if (!alerts?.length) return;
    this.evaluatePrice(t.symbol, t.price);
    this.evaluateIntradayBreakouts(t.symbol, t.price, t.ts);
  }

  private evaluatePrice(symbol: string, price: number) {
    for (const a of [...(this.active.get(symbol) ?? [])]) {
      if ((a.kind === 'price_above' || a.kind === 'price_below') && a.targetPrice != null) {
        if (priceCrossed(a.kind, a.targetPrice, price)) void this.trigger(a, price);
      } else if (a.kind === 'near_level' && a.levelPrice != null) {
        const near = withinPct(price, a.levelPrice);
        if (!a.armed && !near) {
          a.armed = true;
          void this.db.alert.update({ where: { id: a.id }, data: { armed: true } }).catch(() => {});
        } else if (a.armed && near) {
          void this.trigger(a, price);
        }
      }
    }
  }

  /** Build candle closes from ticks for intraday sizes; a bucket rollover = the previous candle's close. */
  private evaluateIntradayBreakouts(symbol: string, price: number, tsMs: number) {
    const intraday = (this.active.get(symbol) ?? []).filter((a) => a.kind === 'breakout' && a.resolution && RESOLUTION_SECONDS[a.resolution as Resolution] < 86400);
    if (!intraday.length) return;
    const sec = Math.floor(tsMs / 1000);
    for (const res of new Set(intraday.map((a) => a.resolution as Resolution))) {
      const key = `${symbol}|${res}`;
      const b = bucketStart(sec, res);
      const cur = this.buckets.get(key);
      if (cur && b > cur.bucket) {
        const close = cur.last;
        const closedAt = cur.bucket + RESOLUTION_SECONDS[res];
        for (const a of intraday) {
          if (a.resolution === res && closedAt * 1000 > a.createdAt.getTime() && closedBeyond(a.levelKind as 'support' | 'resistance', a.zoneLow!, a.zoneHigh!, close)) {
            void this.trigger(a, close);
          }
        }
      }
      this.buckets.set(key, { bucket: b, last: price });
    }
  }

  /** Daily / weekly breakouts from completed candles (cached daily data, no extra cost). */
  private async checkDailyBreakouts() {
    const nowSec = Date.now() / 1000;
    for (const [symbol, alerts] of this.active) {
      const daily = alerts.filter((a) => a.kind === 'breakout' && a.levelRange && !isIntradayRange(a.levelRange as Range));
      for (const range of new Set(daily.map((a) => a.levelRange as Range))) {
        try {
          const series = await this.market.candles(symbol, range);
          const size = RESOLUTION_SECONDS[series.resolution];
          for (const a of daily.filter((x) => x.levelRange === range)) {
            const created = a.createdAt.getTime() / 1000;
            const bar = series.candles.find(
              (c) => c.time + size > created && c.time + size <= nowSec && closedBeyond(a.levelKind as 'support' | 'resistance', a.zoneLow!, a.zoneHigh!, c.close),
            );
            if (bar) await this.trigger(a, bar.close);
          }
        } catch (err) {
          this.log.warn(`Alert breakout check failed for ${symbol}: ${(err as Error).message}`);
        }
      }
    }
  }

  private async pollQuotes() {
    for (const symbol of this.active.keys()) {
      if (!(this.active.get(symbol) ?? []).some((a) => a.kind !== 'breakout')) continue;
      try {
        const q = await this.market.quote(symbol);
        if (q.price != null) this.evaluatePrice(symbol, q.price);
      } catch {
        // try again next minute
      }
    }
  }

  private async trigger(a: AlertRow, price: number) {
    if (this.busy.has(a.id)) return;
    this.busy.add(a.id);
    try {
      const row = await this.db.alert.update({ where: { id: a.id }, data: { status: 'triggered', triggeredAt: new Date(), triggerPrice: price } });
      this.untrack(a);
      const alert = toAlert(row);
      this.log.info(`Alert triggered: ${row.symbol} ${row.kind} at ${price}`);
      for (const l of this.listeners) l(alert);
    } catch (err) {
      this.log.warn(`Could not record alert ${a.id}: ${(err as Error).message}`);
    } finally {
      this.busy.delete(a.id);
    }
  }

  private track(row: AlertRow) {
    const list = this.active.get(row.symbol) ?? [];
    if (list.length === 0) this.retainer.retainInternal([row.symbol]);
    list.push(row);
    this.active.set(row.symbol, list);
  }

  private untrack(row: AlertRow) {
    const list = (this.active.get(row.symbol) ?? []).filter((x) => x.id !== row.id);
    if (list.length) this.active.set(row.symbol, list);
    else if (this.active.delete(row.symbol)) {
      this.retainer.releaseInternal([row.symbol]);
      for (const k of [...this.buckets.keys()]) if (k.startsWith(`${row.symbol}|`)) this.buckets.delete(k);
    }
  }
}

function toAlert(r: AlertRow): Alert {
  return {
    id: r.id,
    userId: r.userId,
    symbol: r.symbol,
    kind: r.kind as AlertKind,
    targetPrice: r.targetPrice,
    level:
      r.levelKind && r.levelPrice != null && r.zoneLow != null && r.zoneHigh != null && r.levelRange
        ? { kind: r.levelKind as 'support' | 'resistance', price: r.levelPrice, zoneLow: r.zoneLow, zoneHigh: r.zoneHigh, range: r.levelRange as Range }
        : null,
    status: r.status as Alert['status'],
    createdAt: r.createdAt.toISOString(),
    triggeredAt: r.triggeredAt?.toISOString() ?? null,
    triggerPrice: r.triggerPrice,
    seen: r.seen,
  };
}
