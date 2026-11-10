import type { PrismaClient } from '@prisma/client';
import { MAX_GROUP_NAME, type WatchlistItem } from '@tm/shared';

/** Watchlist persistence: membership, "My order" and optional groups. */
export interface WatchlistStore {
  list(): Promise<WatchlistItem[]>;
  add(symbol: string): Promise<WatchlistItem[]>;
  remove(symbol: string): Promise<WatchlistItem[]>;
  /** New order for some or all symbols; symbols not listed keep their relative order after them. */
  reorder(symbols: string[]): Promise<WatchlistItem[]>;
  /** Put a symbol in a group (null / blank = no group). */
  setGroup(symbol: string, group: string | null): Promise<WatchlistItem[]>;
}

/** Normalize a group name: trimmed, single spaces, at most MAX_GROUP_NAME chars; blank → null. */
export function cleanGroup(group: string | null | undefined): string | null {
  const g = (group ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
  return g || null;
}

/** The full order after moving `symbols` to the front in the given order (unknown symbols ignored). */
export function applyOrder(current: string[], symbols: string[]): string[] {
  const known = new Set(current);
  const first = [...new Set(symbols)].filter((s) => known.has(s));
  const rest = current.filter((s) => !first.includes(s));
  return [...first, ...rest];
}

/** In-memory store (tests / no database). */
export class MemoryWatchlistStore implements WatchlistStore {
  private items: WatchlistItem[];

  constructor(initial: string[]) {
    const now = new Date().toISOString();
    this.items = initial.map((symbol, position) => ({ symbol, addedAt: now, position, group: null }));
  }

  async list() {
    return [...this.items].sort((a, b) => a.position - b.position).map((i) => ({ ...i }));
  }

  async add(symbol: string) {
    if (!this.items.some((i) => i.symbol === symbol)) {
      const position = Math.max(-1, ...this.items.map((i) => i.position)) + 1;
      this.items.push({ symbol, addedAt: new Date().toISOString(), position, group: null });
    }
    return this.list();
  }

  async remove(symbol: string) {
    this.items = this.items.filter((i) => i.symbol !== symbol);
    return this.list();
  }

  async reorder(symbols: string[]) {
    const order = applyOrder((await this.list()).map((i) => i.symbol), symbols);
    for (const i of this.items) i.position = order.indexOf(i.symbol);
    return this.list();
  }

  async setGroup(symbol: string, group: string | null) {
    const item = this.items.find((i) => i.symbol === symbol);
    if (item) item.group = cleanGroup(group);
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
      ...this.starter.map((symbol, i) =>
        this.db.watchlistItem.upsert({ where: { symbol }, create: { symbol, addedAt: new Date(base + i), position: i }, update: {} }),
      ),
      this.db.setting.create({ data: { key: 'watchlistSeeded', value: new Date().toISOString() } }),
    ]);
  }

  async list(): Promise<WatchlistItem[]> {
    const rows = await this.db.watchlistItem.findMany({ orderBy: [{ position: 'asc' }, { addedAt: 'asc' }] });
    return rows.map((r) => ({ symbol: r.symbol, addedAt: r.addedAt.toISOString(), position: r.position, group: r.group }));
  }

  async add(symbol: string) {
    const last = await this.db.watchlistItem.aggregate({ _max: { position: true } });
    await this.db.watchlistItem.upsert({ where: { symbol }, create: { symbol, position: (last._max.position ?? -1) + 1 }, update: {} });
    return this.list();
  }

  async remove(symbol: string) {
    await this.db.watchlistItem.deleteMany({ where: { symbol } });
    return this.list();
  }

  async reorder(symbols: string[]) {
    const order = applyOrder((await this.list()).map((i) => i.symbol), symbols);
    await this.db.$transaction(order.map((symbol, position) => this.db.watchlistItem.update({ where: { symbol }, data: { position } })));
    return this.list();
  }

  async setGroup(symbol: string, group: string | null) {
    await this.db.watchlistItem.updateMany({ where: { symbol }, data: { group: cleanGroup(group) } });
    return this.list();
  }
}
