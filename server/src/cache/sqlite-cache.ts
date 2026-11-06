import type { PrismaClient } from '@prisma/client';
import type { Cache, CacheEntry } from './cache.js';

/**
 * Persistent cache (SQLite via Prisma) for AI outputs, so paid model results
 * survive restarts. Same interface as the in-memory LRU. Expired rows are kept
 * for a while (stale fallback) and purged after `keepExpiredMs`.
 */
export class SqliteCache implements Cache {
  constructor(private readonly db: PrismaClient, private readonly keepExpiredMs = 7 * 24 * 3600_000) {}

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const row = await this.db.aiCache.findUnique({ where: { key } });
    if (!row) return undefined;
    try {
      return { value: JSON.parse(row.value) as T, expiresAt: row.expiresAt.getTime(), storedAt: row.storedAt.getTime() };
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const json = JSON.stringify(value ?? null);
    await this.db.aiCache.upsert({ where: { key }, create: { key, value: json, storedAt: now, expiresAt }, update: { value: json, storedAt: now, expiresAt } });
  }

  async delete(key: string): Promise<void> {
    await this.db.aiCache.deleteMany({ where: { key } });
  }

  /** Remove rows that expired long ago. */
  async purge(): Promise<number> {
    const r = await this.db.aiCache.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - this.keepExpiredMs) } } });
    return r.count;
  }
}
