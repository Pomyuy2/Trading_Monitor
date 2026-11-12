import type { PrismaClient } from '@prisma/client';

export interface ProviderQuotaPolicy {
  provider: string;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
  requestsPerMonth?: number;
  windowType: 'fixed' | 'rolling';
  dayResetUtc: boolean;
}

export const PROVIDER_QUOTA_POLICIES: Record<string, ProviderQuotaPolicy> = {
  finnhub: {
    provider: 'finnhub',
    requestsPerMinute: 60,
    windowType: 'rolling',
    dayResetUtc: false,
  },
  twelvedata: {
    provider: 'twelvedata',
    requestsPerMinute: 8,
    requestsPerDay: 800,
    windowType: 'fixed',
    dayResetUtc: true,
  },
  fmp: {
    provider: 'fmp',
    requestsPerDay: 250,
    windowType: 'fixed',
    dayResetUtc: true,
  },
  alpaca: {
    provider: 'alpaca',
    requestsPerMinute: 200,
    windowType: 'rolling',
    dayResetUtc: false,
  },
  tiingo: {
    provider: 'tiingo',
    requestsPerHour: 50,
    requestsPerDay: 1000,
    windowType: 'fixed',
    dayResetUtc: true,
  },
  sec: {
    provider: 'sec',
    requestsPerMinute: 600,
    windowType: 'rolling',
    dayResetUtc: false,
  },
  yahoo: {
    provider: 'yahoo',
    requestsPerMinute: 120,
    windowType: 'rolling',
    dayResetUtc: false,
  },
};

export interface QuotaStatus {
  provider: string;
  endpoint: string;
  usedRequests: number;
  usedCredits: number;
  limitRequests?: number;
  accountingMode: 'authoritative' | 'estimated';
  authoritativeRemaining: number | null;
  windowStart: number;
  windowEnd: number;
  circuitBreaker: {
    state: 'closed' | 'open';
    until: number | null;
    strikes: number;
  };
  lastSuccessAt: number | null;
  lastRateLimitAt: number | null;
}

interface InMemoryCounter {
  provider: string;
  endpoint: string;
  usedRequests: number;
  usedCredits: number;
  minuteRequests: number;
  minuteWindowEnd: number;
  hourRequests: number;
  hourWindowEnd: number;
  authoritativeRemaining: number | null;
  windowStart: number;
  windowEnd: number;
  circuitBreakerState: 'closed' | 'open';
  circuitBreakerUntil: number | null;
  strikes: number;
  lastSuccessAt: number | null;
  lastRateLimitAt: number | null;
  isDirty: boolean;
}

function calculateWindow(policy?: ProviderQuotaPolicy, now = Date.now()): { start: number; end: number } {
  if (policy?.dayResetUtc) {
    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
    const end = start + 86400_000;
    return { start, end };
  }
  // Default to 1-minute rolling window
  const windowMs = policy?.requestsPerHour ? 3600_000 : 60_000;
  return { start: now, end: now + windowMs };
}

export class QuotaLedgerService {
  private readonly counters = new Map<string, InMemoryCounter>();
  private flushTimer?: ReturnType<typeof setInterval>;
  private isInitialized = false;

  constructor(private readonly prisma?: PrismaClient) {}

  private key(provider: string, endpoint = 'default'): string {
    return `${provider.toLowerCase()}:${endpoint.toLowerCase()}`;
  }

  /**
   * Initializes ledger from persisted SQLite state.
   */
  async init(): Promise<void> {
    if (this.isInitialized || !this.prisma) return;
    try {
      const records = await this.prisma.quotaLedger.findMany();
      const now = Date.now();

      for (const r of records) {
        const policy = PROVIDER_QUOTA_POLICIES[r.provider.toLowerCase()];
        const win = calculateWindow(policy, now);

        // If persisted window has expired, start a fresh window but preserve circuit breaker & strikes if still active
        const isExpired = r.windowEnd.getTime() <= now;
        const cbUntil = r.circuitBreakerUntil ? r.circuitBreakerUntil.getTime() : null;
        const isCbActive = cbUntil != null && cbUntil > now;

        const counter: InMemoryCounter = {
          provider: r.provider,
          endpoint: r.endpoint,
          usedRequests: isExpired ? 0 : r.usedRequests,
          usedCredits: isExpired ? 0 : r.usedCredits,
          minuteRequests: 0,
          minuteWindowEnd: now + 60_000,
          hourRequests: 0,
          hourWindowEnd: now + 3600_000,
          authoritativeRemaining: null,
          windowStart: isExpired ? win.start : r.windowStart.getTime(),
          windowEnd: isExpired ? win.end : r.windowEnd.getTime(),
          circuitBreakerState: isCbActive ? 'open' : 'closed',
          circuitBreakerUntil: isCbActive ? cbUntil : null,
          strikes: isCbActive ? r.strikes : 0,
          lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.getTime() : null,
          lastRateLimitAt: r.lastRateLimitAt ? r.lastRateLimitAt.getTime() : null,
          isDirty: false,
        };

        this.counters.set(this.key(r.provider, r.endpoint), counter);
      }
      this.isInitialized = true;
    } catch (err) {
      console.warn('QuotaLedger failed to load from database, running in-memory mode:', err);
    }

    // Flush dirty counters every 5 seconds
    if (!this.flushTimer && typeof setInterval !== 'undefined') {
      this.flushTimer = setInterval(() => this.flush().catch(() => {}), 5_000);
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
  }

  private getOrCreate(provider: string, endpoint = 'default'): InMemoryCounter {
    const k = this.key(provider, endpoint);
    let c = this.counters.get(k);
    const now = Date.now();
    const policy = PROVIDER_QUOTA_POLICIES[provider.toLowerCase()];

    if (!c) {
      const win = calculateWindow(policy, now);
      c = {
        provider: provider.toLowerCase(),
        endpoint: endpoint.toLowerCase(),
        usedRequests: 0,
        usedCredits: 0,
        minuteRequests: 0,
        minuteWindowEnd: now + 60_000,
        hourRequests: 0,
        hourWindowEnd: now + 3600_000,
        authoritativeRemaining: null,
        windowStart: win.start,
        windowEnd: win.end,
        circuitBreakerState: 'closed',
        circuitBreakerUntil: null,
        strikes: 0,
        lastSuccessAt: null,
        lastRateLimitAt: null,
        isDirty: true,
      };
      this.counters.set(k, c);
      return c;
    }

    // Check window expiration
    if (now >= c.windowEnd) {
      const win = calculateWindow(policy, now);
      c.windowStart = win.start;
      c.windowEnd = win.end;
      c.usedRequests = 0;
      c.usedCredits = 0;
      c.authoritativeRemaining = null;
      c.isDirty = true;
    }

    if (now >= c.minuteWindowEnd) {
      c.minuteRequests = 0;
      c.minuteWindowEnd = now + 60_000;
      c.isDirty = true;
    }

    if (now >= c.hourWindowEnd) {
      c.hourRequests = 0;
      c.hourWindowEnd = now + 3600_000;
      c.isDirty = true;
    }

    // Check circuit breaker expiration
    if (c.circuitBreakerState === 'open' && c.circuitBreakerUntil && now >= c.circuitBreakerUntil) {
      c.circuitBreakerState = 'closed';
      c.circuitBreakerUntil = null;
      c.isDirty = true;
    }

    return c;
  }

  /**
   * Check if a provider is blocked by circuit breaker or quota exhaustion.
   */
  isBlocked(provider: string, endpoint = 'default'): { blocked: boolean; retryAfterMs?: number; reason?: string } {
    const c = this.getOrCreate(provider, endpoint);
    const now = Date.now();

    // 1. Circuit breaker active
    if (c.circuitBreakerState === 'open' && c.circuitBreakerUntil && c.circuitBreakerUntil > now) {
      return {
        blocked: true,
        retryAfterMs: c.circuitBreakerUntil - now,
        reason: 'Circuit breaker open (HTTP 429 backoff)',
      };
    }

    // 2. Authoritative zero remaining
    if (c.authoritativeRemaining === 0 && c.windowEnd > now) {
      return {
        blocked: true,
        retryAfterMs: c.windowEnd - now,
        reason: 'Provider authoritative quota exhausted',
      };
    }

    // 3. Known budget exhausted
    const policy = PROVIDER_QUOTA_POLICIES[provider.toLowerCase()];
    if (policy) {
      if (policy.requestsPerMinute && c.minuteRequests >= policy.requestsPerMinute) {
        return {
          blocked: true,
          retryAfterMs: Math.max(1000, c.minuteWindowEnd - now),
          reason: `Configured quota limit reached (${c.minuteRequests}/${policy.requestsPerMinute} per min)`,
        };
      }
      if (policy.requestsPerHour && c.hourRequests >= policy.requestsPerHour) {
        return {
          blocked: true,
          retryAfterMs: Math.max(1000, c.hourWindowEnd - now),
          reason: `Configured quota limit reached (${c.hourRequests}/${policy.requestsPerHour} per hour)`,
        };
      }
      if (policy.requestsPerDay && c.usedRequests >= policy.requestsPerDay) {
        return {
          blocked: true,
          retryAfterMs: Math.max(1000, c.windowEnd - now),
          reason: `Configured quota limit reached (${c.usedRequests}/${policy.requestsPerDay} per day)`,
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Records an upstream HTTP request attempt and consumed credits.
   */
  recordRequest(provider: string, endpoint = 'default', credits = 1): void {
    const c = this.getOrCreate(provider, endpoint);
    c.usedRequests++;
    c.usedCredits += credits;
    c.minuteRequests++;
    c.hourRequests++;
    c.isDirty = true;
  }

  /**
   * Records a successful upstream response with optional usage headers.
   */
  recordSuccess(provider: string, endpoint = 'default', headers?: Headers | Record<string, string>): void {
    const c = this.getOrCreate(provider, endpoint);
    c.lastSuccessAt = Date.now();
    c.isDirty = true;

    // Reset strikes on consecutive successes if circuit breaker was closed
    if (c.circuitBreakerState === 'closed' && c.strikes > 0) {
      c.strikes = 0;
    }

    if (headers) {
      const getHeader = (name: string): string | null => {
        if ('get' in headers && typeof headers.get === 'function') {
          return headers.get(name);
        }
        return (headers as Record<string, string>)[name] ?? null;
      };

      const rem = getHeader('x-ratelimit-remaining') ?? getHeader('x-credits-remaining');
      if (rem != null && Number.isFinite(+rem)) {
        c.authoritativeRemaining = +rem;
      }
    }
  }

  /**
   * Records an HTTP 429 rate limit event. Opens circuit breaker and flushes immediately.
   */
  async recordRateLimit(provider: string, waitMs?: number, endpoint = 'default'): Promise<number> {
    const c = this.getOrCreate(provider, endpoint);
    const now = Date.now();
    c.strikes++;
    c.lastRateLimitAt = now;

    const MAX_BLOCK_MS = 30 * 60_000;
    const computedWait =
      waitMs != null && waitMs > 0
        ? waitMs
        : Math.min(60_000 * 2 ** (c.strikes - 1), MAX_BLOCK_MS);

    c.circuitBreakerState = 'open';
    c.circuitBreakerUntil = now + computedWait;
    c.isDirty = true;

    await this.flush();
    return computedWait;
  }

  /**
   * Flushes dirty in-memory counters to SQLite.
   */
  async flush(): Promise<void> {
    if (!this.prisma) return;

    const dirtyEntries: InMemoryCounter[] = [];
    for (const c of this.counters.values()) {
      if (c.isDirty) {
        dirtyEntries.push(c);
        c.isDirty = false;
      }
    }

    if (dirtyEntries.length === 0) return;

    for (const c of dirtyEntries) {
      try {
        await this.prisma.quotaLedger.upsert({
          where: {
            provider_endpoint: {
              provider: c.provider,
              endpoint: c.endpoint,
            },
          },
          create: {
            provider: c.provider,
            endpoint: c.endpoint,
            usedRequests: c.usedRequests,
            usedCredits: c.usedCredits,
            windowType: PROVIDER_QUOTA_POLICIES[c.provider]?.windowType ?? 'rolling',
            windowStart: new Date(c.windowStart),
            windowEnd: new Date(c.windowEnd),
            lastRateLimitAt: c.lastRateLimitAt ? new Date(c.lastRateLimitAt) : null,
            lastSuccessAt: c.lastSuccessAt ? new Date(c.lastSuccessAt) : null,
            circuitBreakerState: c.circuitBreakerState,
            circuitBreakerUntil: c.circuitBreakerUntil ? new Date(c.circuitBreakerUntil) : null,
            strikes: c.strikes,
          },
          update: {
            usedRequests: c.usedRequests,
            usedCredits: c.usedCredits,
            windowStart: new Date(c.windowStart),
            windowEnd: new Date(c.windowEnd),
            lastRateLimitAt: c.lastRateLimitAt ? new Date(c.lastRateLimitAt) : null,
            lastSuccessAt: c.lastSuccessAt ? new Date(c.lastSuccessAt) : null,
            circuitBreakerState: c.circuitBreakerState,
            circuitBreakerUntil: c.circuitBreakerUntil ? new Date(c.circuitBreakerUntil) : null,
            strikes: c.strikes,
          },
        });
      } catch (err) {
        console.warn(`Failed to flush quota ledger for ${c.provider}:`, err);
      }
    }
  }

  /**
   * Diagnostics dump of all known providers.
   */
  getDiagnostics(): QuotaStatus[] {
    const list: QuotaStatus[] = [];
    const allProviders = [
      ...new Set([
        ...Object.keys(PROVIDER_QUOTA_POLICIES),
        ...Array.from(this.counters.values()).map((c) => c.provider),
      ]),
    ];

    for (const p of allProviders) {
      const c = this.getOrCreate(p, 'default');
      const policy = PROVIDER_QUOTA_POLICIES[p];
      list.push({
        provider: c.provider,
        endpoint: c.endpoint,
        usedRequests: c.usedRequests,
        usedCredits: c.usedCredits,
        limitRequests: policy?.requestsPerDay ?? policy?.requestsPerHour ?? policy?.requestsPerMinute,
        accountingMode: c.authoritativeRemaining != null ? 'authoritative' : 'estimated',
        authoritativeRemaining: c.authoritativeRemaining,
        windowStart: c.windowStart,
        windowEnd: c.windowEnd,
        circuitBreaker: {
          state: c.circuitBreakerState,
          until: c.circuitBreakerUntil,
          strikes: c.strikes,
        },
        lastSuccessAt: c.lastSuccessAt,
        lastRateLimitAt: c.lastRateLimitAt,
      });
    }

    return list;
  }

  /**
   * Testing helper to reset in-memory state.
   */
  reset(): void {
    this.counters.clear();
  }
}

import { db } from '../store/db.js';

// Global default singleton instance
export const quotaLedger = new QuotaLedgerService(db);
