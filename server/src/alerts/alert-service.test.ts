import { PrismaClient } from '@prisma/client';
import type { Alert } from '@tm/shared';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MarketService } from '../services/market-service.js';
import { AlertService } from './alert-service.js';

/** Isolated SQLite DB built from the real migrations — the dev database is never touched. */
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tm-alerts-'));
const db = new PrismaClient({ datasources: { db: { url: `file:${join(dir, 'test.db').replace(/\\/g, '/')}` } } });

let price = 100;
const market = { quote: async () => ({ price }) } as unknown as MarketService;
const retained = new Map<string, number>();
const retainer = {
  retainInternal: (s: string[]) => s.forEach((x) => retained.set(x, (retained.get(x) ?? 0) + 1)),
  releaseInternal: (s: string[]) => s.forEach((x) => retained.set(x, (retained.get(x) ?? 0) - 1)),
};
const quiet = { info() {}, warn() {} };

let svc: AlertService;
let fired: Alert[];
const settle = () => new Promise((r) => setTimeout(r, 30)); // trigger() writes to the DB asynchronously
const tick = async (p: number, ts = Date.now()) => {
  svc.handleTick({ symbol: 'TEST', price: p, ts });
  await settle();
};

beforeAll(async () => {
  const migrations = join(here, '../../prisma/migrations');
  for (const m of readdirSync(migrations).filter((d) => !d.endsWith('.toml')).sort()) {
    const sql = readFileSync(join(migrations, m, 'migration.sql'), 'utf8');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt);
  }
});

afterAll(async () => {
  svc?.stop();
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  svc?.stop();
  await db.alert.deleteMany();
  price = 100;
  retained.clear();
  fired = [];
  svc = new AlertService(db, market, retainer, quiet);
  svc.onTriggered((a) => fired.push(a));
  await svc.init();
});

describe('AlertService', () => {
  it('rejects a price target on the wrong side of the current price', async () => {
    await expect(svc.create({ symbol: 'TEST', kind: 'price_above', targetPrice: 95 })).rejects.toThrow(/above the current price/);
    await expect(svc.create({ symbol: 'TEST', kind: 'price_below', targetPrice: 105 })).rejects.toThrow(/below the current price/);
  });

  it('validates against the latest live trade when it is newer than the quote (pre-market)', async () => {
    // quote still shows 100 (yesterday's close), but trades are already at 110
    svc.handleTick({ symbol: 'TEST', price: 110, ts: Date.now() });
    await expect(svc.create({ symbol: 'TEST', kind: 'price_above', targetPrice: 105 })).rejects.toThrow(/above the current price/);
    await expect(svc.create({ symbol: 'TEST', kind: 'price_above', targetPrice: 115 })).resolves.toMatchObject({ status: 'active' });
  });

  it('fires a price_above alert once, stores it, and stops streaming the symbol', async () => {
    await svc.create({ symbol: 'TEST', kind: 'price_above', targetPrice: 105 });
    expect(retained.get('TEST')).toBe(1);
    await tick(104.9);
    expect(fired).toHaveLength(0);
    await tick(105.2);
    await tick(106);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ status: 'triggered', triggerPrice: 105.2 });
    expect((await svc.list('TEST'))[0].status).toBe('triggered');
    expect(retained.get('TEST')).toBe(0);
  });

  it('fires near_level when price comes within 1 % of the level', async () => {
    await svc.create({ symbol: 'TEST', kind: 'near_level', level: { kind: 'support', price: 95, zoneLow: 94.5, zoneHigh: 95.5, range: '1D' } });
    await tick(97); // 2.1 % away
    expect(fired).toHaveLength(0);
    await tick(95.9); // 0.95 % away
    expect(fired).toHaveLength(1);
  });

  it('waits for price to leave the band first if it starts inside it', async () => {
    price = 95.5; // already within 1 % of 95 at creation
    await svc.create({ symbol: 'TEST', kind: 'near_level', level: { kind: 'support', price: 95, zoneLow: 94.5, zoneHigh: 95.5, range: '1D' } });
    await tick(95.4);
    expect(fired).toHaveLength(0); // not armed yet
    await tick(97); // leaves the band → armed
    await tick(95.6); // comes back
    expect(fired).toHaveLength(1);
  });

  it('fires an intraday breakout only when a candle closes beyond the zone', async () => {
    await svc.create({ symbol: 'TEST', kind: 'breakout', level: { kind: 'resistance', price: 110, zoneLow: 109, zoneHigh: 111, range: '1D' } }); // 5-min candles
    const t0 = Math.ceil(Date.now() / 300_000) * 300_000 + 1_000; // just inside the next 5-min bucket
    await tick(112, t0); // pokes above the zone…
    await tick(110.5, t0 + 60_000); // …but this candle closes inside it
    await tick(110.6, t0 + 300_000); // next candle starts → previous close 110.5 → no breakout
    expect(fired).toHaveLength(0);
    await tick(111.8, t0 + 400_000); // this candle closes above 111
    await tick(111.9, t0 + 600_000); // next candle starts → close 111.8 → breakout
    expect(fired).toHaveLength(1);
    expect(fired[0].triggerPrice).toBe(111.8);
  });

  it('reloads active alerts from the database on restart', async () => {
    await svc.create({ symbol: 'TEST', kind: 'price_below', targetPrice: 90 });
    svc.stop();
    const restarted = new AlertService(db, market, retainer, quiet);
    const got: Alert[] = [];
    restarted.onTriggered((a) => got.push(a));
    await restarted.init();
    restarted.handleTick({ symbol: 'TEST', price: 89, ts: Date.now() });
    await settle();
    expect(got).toHaveLength(1);
    restarted.stop();
  });

  it('removes alerts and marks triggered ones as seen', async () => {
    const a = await svc.create({ symbol: 'TEST', kind: 'price_above', targetPrice: 101 });
    await tick(102);
    await svc.markSeen(a.id);
    expect((await svc.list())[0].seen).toBe(true);
    expect(await svc.remove(a.id)).toBe(true);
    expect(await svc.list()).toHaveLength(0);
    expect(await svc.remove('missing')).toBe(false);
  });
});
