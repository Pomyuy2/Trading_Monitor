import type { PrismaClient } from '@prisma/client';
import { MAX_GROUP_NAME, type WatchlistItem } from '@tm/shared';

/** Watchlist persistence: membership, "My order" and optional groups, partitioned per user. */
export interface WatchlistStore {
  list(userId?: string): Promise<WatchlistItem[]>;
  add(symbol: string, userId?: string): Promise<WatchlistItem[]>;
  remove(symbol: string, userId?: string): Promise<WatchlistItem[]>;
  /** New order for some or all symbols; symbols not listed keep their relative order after them. */
  reorder(symbols: string[], userId?: string): Promise<WatchlistItem[]>;
  /** Put a symbol in a group (null / blank = no group). */
  setGroup(symbol: string, group: string | null, userId?: string): Promise<WatchlistItem[]>;
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
  private userItems = new Map<string, WatchlistItem[]>();

  constructor(private readonly initial: string[]) {}

  private getItems(userId: string): WatchlistItem[] {
    if (!this.userItems.has(userId)) {
      const now = new Date().toISOString();
      this.userItems.set(
        userId,
        this.initial.map((symbol, position) => ({ symbol, addedAt: now, position, group: null })),
      );
    }
    return this.userItems.get(userId)!;
  }

  async list(userId = 'default-user') {
    return [...this.getItems(userId)].sort((a, b) => a.position - b.position).map((i) => ({ ...i }));
  }

  async add(symbol: string, userId = 'default-user') {
    const items = this.getItems(userId);
    if (!items.some((i) => i.symbol === symbol)) {
      const position = Math.max(-1, ...items.map((i) => i.position)) + 1;
      items.push({ symbol, addedAt: new Date().toISOString(), position, group: null });
    }
    return this.list(userId);
  }

  async remove(symbol: string, userId = 'default-user') {
    const items = this.getItems(userId);
    this.userItems.set(
      userId,
      items.filter((i) => i.symbol !== symbol),
    );
    return this.list(userId);
  }

  async reorder(symbols: string[], userId = 'default-user') {
    const items = this.getItems(userId);
    const order = applyOrder((await this.list(userId)).map((i) => i.symbol), symbols);
    for (const i of items) i.position = order.indexOf(i.symbol);
    return this.list(userId);
  }

  async setGroup(symbol: string, group: string | null, userId = 'default-user') {
    const items = this.getItems(userId);
    const item = items.find((i) => i.symbol === symbol);
    if (item) item.group = cleanGroup(group);
    return this.list(userId);
  }
}

/** SQLite (Prisma) store. Seeds a starter list per user on first visit. */
export class PrismaWatchlistStore implements WatchlistStore {
  constructor(private readonly db: PrismaClient, private readonly starter: string[]) {}

  async init(defaultUserId = 'default-user') {
    const seeded = await this.db.setting.findUnique({ where: { key: 'watchlistSeeded' } });
    if (seeded) return;
    const base = Date.now();
    await this.db.$transaction([
      ...this.starter.map((symbol, i) =>
        this.db.watchlistItem.upsert({
          where: { userId_symbol: { userId: defaultUserId, symbol } },
          create: { userId: defaultUserId, symbol, addedAt: new Date(base + i), position: i },
          update: {},
        }),
      ),
      this.db.setting.create({ data: { key: 'watchlistSeeded', value: new Date().toISOString() } }),
    ]);
  }

  async list(userId = 'default-user'): Promise<WatchlistItem[]> {
    let rows = await this.db.watchlistItem.findMany({
      where: { userId },
      orderBy: [{ position: 'asc' }, { addedAt: 'asc' }],
    });
    // First time this user visits: seed their personal starter watchlist
    if (rows.length === 0) {
      const base = Date.now();
      await this.db.watchlistItem
        .createMany({
          data: this.starter.map((symbol, i) => ({
            userId,
            symbol,
            position: i,
            addedAt: new Date(base + i),
          })),
        })
        .catch(() => {});
      rows = await this.db.watchlistItem.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { addedAt: 'asc' }],
      });
    }
    return rows.map((r) => ({
      symbol: r.symbol,
      addedAt: r.addedAt.toISOString(),
      position: r.position,
      group: r.group,
    }));
  }

  async add(symbol: string, userId = 'default-user') {
    const last = await this.db.watchlistItem.aggregate({
      where: { userId },
      _max: { position: true },
    });
    await this.db.watchlistItem.upsert({
      where: { userId_symbol: { userId, symbol } },
      create: { userId, symbol, position: (last._max.position ?? -1) + 1 },
      update: {},
    });
    return this.list(userId);
  }

  async remove(symbol: string, userId = 'default-user') {
    await this.db.watchlistItem.deleteMany({
      where: { userId, symbol },
    });
    return this.list(userId);
  }

  async reorder(symbols: string[], userId = 'default-user') {
    const order = applyOrder((await this.list(userId)).map((i) => i.symbol), symbols);
    await this.db.$transaction(
      order.map((symbol, position) =>
        this.db.watchlistItem.update({
          where: { userId_symbol: { userId, symbol } },
          data: { position },
        }),
      ),
    );
    return this.list(userId);
  }

  async setGroup(symbol: string, group: string | null, userId = 'default-user') {
    await this.db.watchlistItem.updateMany({
      where: { userId, symbol },
      data: { group: cleanGroup(group) },
    });
    return this.list(userId);
  }
}
