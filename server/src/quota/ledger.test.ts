import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuotaLedgerService, PROVIDER_QUOTA_POLICIES } from './ledger.js';

describe('Persistent Quota Ledger & Circuit Breaker', () => {
  let db: PrismaClient;
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `quota-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'test.db');
    db = new PrismaClient({
      datasources: { db: { url: `file:${dbPath.replace(/\\/g, '/')}` } },
    });
    // Create schema
    await db.$executeRawUnsafe(`
      CREATE TABLE "QuotaLedger" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "provider" TEXT NOT NULL,
        "endpoint" TEXT NOT NULL DEFAULT 'default',
        "usedRequests" INTEGER NOT NULL DEFAULT 0,
        "usedCredits" INTEGER NOT NULL DEFAULT 0,
        "windowType" TEXT NOT NULL DEFAULT 'rolling',
        "windowStart" DATETIME NOT NULL,
        "windowEnd" DATETIME NOT NULL,
        "lastRateLimitAt" DATETIME,
        "lastSuccessAt" DATETIME,
        "circuitBreakerState" TEXT NOT NULL DEFAULT 'closed',
        "circuitBreakerUntil" DATETIME,
        "strikes" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" DATETIME NOT NULL
      );
    `);
    await db.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "QuotaLedger_provider_endpoint_key" ON "QuotaLedger"("provider", "endpoint");
    `);
  });

  afterEach(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tracks requests and credits consumed in-memory', () => {
    const ledger = new QuotaLedgerService();
    ledger.recordRequest('tiingo', 'default', 1);
    ledger.recordRequest('tiingo', 'default', 2);

    const diag = ledger.getDiagnostics().find((d) => d.provider === 'tiingo');
    expect(diag).toBeDefined();
    expect(diag?.usedRequests).toBe(2);
    expect(diag?.usedCredits).toBe(3);
    expect(diag?.circuitBreaker.state).toBe('closed');
  });

  it('opens circuit breaker on 429 and blocks further calls during wait period', async () => {
    const ledger = new QuotaLedgerService();
    expect(ledger.isBlocked('finnhub').blocked).toBe(false);

    // Record HTTP 429 with 30s wait
    await ledger.recordRateLimit('finnhub', 30_000);

    const check = ledger.isBlocked('finnhub');
    expect(check.blocked).toBe(true);
    expect(check.retryAfterMs).toBeGreaterThan(0);
    expect(check.reason).toContain('Circuit breaker open');

    const diag = ledger.getDiagnostics().find((d) => d.provider === 'finnhub');
    expect(diag?.circuitBreaker.state).toBe('open');
    expect(diag?.circuitBreaker.strikes).toBe(1);
  });

  it('blocks requests when configured quota limit is reached', () => {
    const ledger = new QuotaLedgerService();
    // Twelve Data policy has 8 requests/min
    const limit = PROVIDER_QUOTA_POLICIES['twelvedata'].requestsPerMinute!;
    for (let i = 0; i < limit; i++) {
      expect(ledger.isBlocked('twelvedata').blocked).toBe(false);
      ledger.recordRequest('twelvedata');
    }

    const check = ledger.isBlocked('twelvedata');
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('Configured quota limit reached');
  });

  it('persists quota and circuit breaker state to SQLite and restores across restarts', async () => {
    // 1. First service instance records activity and flushes to SQLite
    const ledger1 = new QuotaLedgerService(db);
    await ledger1.init();

    ledger1.recordRequest('alpaca', 'default', 5);
    ledger1.recordSuccess('alpaca', 'default');
    await ledger1.recordRateLimit('alpaca', 60_000); // 1 minute block
    await ledger1.flush();

    // Verify row written to database
    const rows = await db.quotaLedger.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('alpaca');
    expect(rows[0].usedRequests).toBe(1);
    expect(rows[0].circuitBreakerState).toBe('open');
    expect(rows[0].strikes).toBe(1);

    // 2. Second service instance simulates server restart by loading from same DB
    const ledger2 = new QuotaLedgerService(db);
    await ledger2.init();

    // Circuit breaker state must be restored!
    const check = ledger2.isBlocked('alpaca');
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('Circuit breaker open');

    const diag = ledger2.getDiagnostics().find((d) => d.provider === 'alpaca');
    expect(diag?.usedRequests).toBe(1);
    expect(diag?.circuitBreaker.state).toBe('open');
    expect(diag?.circuitBreaker.strikes).toBe(1);
    expect(diag?.accountingMode).toBe('estimated');
  });

  it('strictly prevents concurrent requests from exceeding budget', async () => {
    const ledger = new QuotaLedgerService();
    const limit = PROVIDER_QUOTA_POLICIES['twelvedata'].requestsPerMinute!;
    let allowedCount = 0;
    let blockedCount = 0;

    // Simulate 20 concurrent requests
    await Promise.all(
      Array.from({ length: 20 }).map(async () => {
        const check = ledger.isBlocked('twelvedata');
        if (!check.blocked) {
          ledger.recordRequest('twelvedata');
          allowedCount++;
        } else {
          blockedCount++;
        }
      }),
    );

    expect(allowedCount).toBe(limit);
    expect(blockedCount).toBe(20 - limit);
  });

  it('distinguishes estimated usage from authoritative provider usage in diagnostics', () => {
    const ledger = new QuotaLedgerService();
    ledger.recordRequest('finnhub');

    // Without upstream headers: accountingMode is 'estimated'
    let diag = ledger.getDiagnostics().find((d) => d.provider === 'finnhub');
    expect(diag?.accountingMode).toBe('estimated');
    expect(diag?.authoritativeRemaining).toBeNull();

    // After receiving authoritative upstream header
    ledger.recordSuccess('finnhub', 'default', { 'x-ratelimit-remaining': '42' });
    diag = ledger.getDiagnostics().find((d) => d.provider === 'finnhub');
    expect(diag?.accountingMode).toBe('authoritative');
    expect(diag?.authoritativeRemaining).toBe(42);
  });
});
