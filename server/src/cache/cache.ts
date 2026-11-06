/**
 * Cache abstraction. The in-memory LRU below is the default; a Redis
 * implementation can be dropped in later as long as it satisfies `Cache`.
 *
 * Expired entries are kept (until evicted) so they can be served as "stale"
 * when an upstream provider fails or rate-limits us.
 */
export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  storedAt: number;
}

export interface Cache {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class LruCache implements Cache {
  private map = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly maxEntries = 2000) {}

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // refresh recency
    this.map.delete(key);
    this.map.set(key, entry);
    return entry as CacheEntry<T>;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const now = Date.now();
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + ttlMs, storedAt: now });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** Result of `cached()`: the value plus whether it was served stale. */
export interface CachedResult<T> {
  value: T;
  stale: boolean;
  storedAt: number;
}

/**
 * Read-through cache with stale fallback.
 * - Fresh hit → return it.
 * - Miss / expired → call `fetcher`. On success cache and return.
 * - Fetcher throws and we have an old entry → return it flagged stale.
 * - Otherwise rethrow.
 */
export async function cached<T>(
  cache: Cache,
  key: string,
  ttlMs: number | ((value: T) => number),
  fetcher: () => Promise<T>,
): Promise<CachedResult<T>> {
  const hit = await cache.get<T>(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) {
    return { value: hit.value, stale: false, storedAt: hit.storedAt };
  }
  try {
    const value = await fetcher();
    const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
    await cache.set(key, value, ttl);
    return { value, stale: false, storedAt: now };
  } catch (err) {
    if (hit) return { value: hit.value, stale: true, storedAt: hit.storedAt };
    throw err;
  }
}
