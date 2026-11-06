import type { WatchlistItem } from '@tm/shared';
import type { PrismaClient } from '@prisma/client';

/** Watchlist persistence. */
export interface WatchlistStore {
  list(): Promise<WatchlistItem[]>;
  add(symbol: string): Promise<WatchlistItem[]>;
  remove(symbol: string): Promise<WatchlistItem[]>;
}

/** In-memory store (tests / no database). */
export class MemoryWatchlistStore implements WatchlistStore {
  private items: WatchlistItem[];

  constructor(initial: string[]) {
    const now = new Date().toISOString();
    this.items = initial.map((symbol) => ({ symbol, addedAt: now }));
  }

  async list() {
    return [...this.items];
  }

  async add(symbol: string) {
    if (!this.items.some((i) => i.symbol === symbol)) {
      this.items.push({ symbol, addedAt: new Date().toISOString() });
    }
    return this.list();
  }

  async remove(symbol: string) {
    this.items = this.items.filter((i) => i.symbol !== symbol);
    return this.list();
  }
}

/** SQLite (Prisma) store. Seeds a starter list once, on the very first run. */
export class PrismaWatchlistStore implements WatchlistStore {
  constructor(private readonly db: PrismaClient, private readonly starter: string[]) {}

  async init() {
    const seeded = await this.db.setting.findUnique({ where: { key: 'watchlistSeeded' } });
    if (seeded) return;
    const base = Date.now();
    await this.db.$transaction([
      // createMany isn't available for SQLite in every Prisma version; upserts keep this idempotent
      ...this.starter.map((symbol, i) =>
        this.db.watchlistItem.upsert({ where: { symbol }, create: { symbol, addedAt: new Date(base + i) }, update: {} }),
      ),
      this.db.setting.create({ data: { key: 'watchlistSeeded', value: new Date().toISOString() } }),
    ]);
  }

  async list(): Promise<WatchlistItem[]> {
    const rows = await this.db.watchlistItem.findMany({ orderBy: { addedAt: 'asc' } });
    return rows.map((r) => ({ symbol: r.symbol, addedAt: r.addedAt.toISOString() }));
  }

  async add(symbol: string) {
    await this.db.watchlistItem.upsert({ where: { symbol }, create: { symbol }, update: {} });
    return this.list();
  }

  async remove(symbol: string) {
    await this.db.watchlistItem.deleteMany({ where: { symbol } });
    return this.list();
  }
}
