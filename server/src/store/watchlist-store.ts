import type { WatchlistItem } from '@tm/shared';

/** Watchlist persistence. Phase 5 swaps this for a Prisma/SQLite implementation. */
export interface WatchlistStore {
  list(): Promise<WatchlistItem[]>;
  add(symbol: string): Promise<WatchlistItem[]>;
  remove(symbol: string): Promise<WatchlistItem[]>;
}

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
