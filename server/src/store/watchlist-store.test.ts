import { PrismaClient } from '@prisma/client';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyOrder, cleanGroup, MemoryWatchlistStore, PrismaWatchlistStore } from './watchlist-store.js';

describe('applyOrder', () => {
  it('moves the given symbols to the front, keeping the rest in order', () => {
    expect(applyOrder(['A', 'B', 'C', 'D'], ['C', 'A'])).toEqual(['C', 'A', 'B', 'D']);
  });
  it('ignores unknown and duplicate symbols', () => {
    expect(applyOrder(['A', 'B', 'C'], ['X', 'B', 'B'])).toEqual(['B', 'A', 'C']);
  });
});

describe('cleanGroup', () => {
  it('trims, collapses spaces and caps the length; blank means no group', () => {
    expect(cleanGroup('  Big   Tech ')).toBe('Big Tech');
    expect(cleanGroup('   ')).toBeNull();
    expect(cleanGroup(null)).toBeNull();
    expect(cleanGroup('x'.repeat(40))).toHaveLength(24);
  });
});

describe('MemoryWatchlistStore', () => {
  it('appends new symbols at the end and reorders', async () => {
    const s = new MemoryWatchlistStore(['AAPL', 'MSFT']);
    await s.add('NVDA');
    expect((await s.list()).map((i) => i.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect((await s.reorder(['NVDA'])).map((i) => i.symbol)).toEqual(['NVDA', 'AAPL', 'MSFT']);
  });
});

/** Isolated SQLite DB built from the real migrations (incl. the order/group backfill). */
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tm-watchlist-'));
const db = new PrismaClient({ datasources: { db: { url: `file:${join(dir, 'test.db').replace(/\\/g, '/')}` } } });

beforeAll(async () => {
  const migrations = join(here, '../../prisma/migrations');
  for (const m of readdirSync(migrations).filter((d) => !d.endsWith('.toml')).sort()) {
    const sql = readFileSync(join(migrations, m, 'migration.sql'), 'utf8');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter((s) => s && !/^--[^\n]*$/.test(s))) await db.$executeRawUnsafe(stmt);
  }
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.watchlistItem.deleteMany();
  await db.setting.deleteMany();
});

describe('PrismaWatchlistStore', () => {
  it('seeds the starter list once, in order', async () => {
    const s = new PrismaWatchlistStore(db, ['AAPL', 'MSFT', 'NVDA']);
    await s.init();
    await s.remove('MSFT');
    await s.init(); // already seeded: removed symbols stay removed
    expect((await s.list()).map((i) => [i.symbol, i.position, i.group])).toEqual([
      ['AAPL', 0, null],
      ['NVDA', 2, null],
    ]);
  });

  it('adds at the end, reorders, and persists the order', async () => {
    const s = new PrismaWatchlistStore(db, ['AAPL', 'MSFT', 'NVDA']);
    await s.init();
    await s.add('TSLA');
    expect((await s.list()).map((i) => i.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA']);
    await s.reorder(['TSLA', 'AAPL', 'NVDA', 'MSFT']);
    const again = new PrismaWatchlistStore(db, []);
    expect((await again.list()).map((i) => i.symbol)).toEqual(['TSLA', 'AAPL', 'NVDA', 'MSFT']);
    expect((await again.list()).map((i) => i.position)).toEqual([0, 1, 2, 3]);
  });

  it('sets and clears a group', async () => {
    const s = new PrismaWatchlistStore(db, ['AAPL', 'MSFT']);
    await s.init();
    await s.setGroup('AAPL', '  Tech ');
    expect((await s.list()).find((i) => i.symbol === 'AAPL')?.group).toBe('Tech');
    await s.setGroup('AAPL', '');
    expect((await s.list()).find((i) => i.symbol === 'AAPL')?.group).toBeNull();
  });
});
