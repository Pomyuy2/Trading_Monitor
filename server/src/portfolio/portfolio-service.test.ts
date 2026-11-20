import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PortfolioService } from './portfolio-service.js';

describe('PortfolioService — Ledger Accounting & Isolation', () => {
  let db: PrismaClient;
  let dir: string;
  let service: PortfolioService;

  beforeEach(async () => {
    dir = join(tmpdir(), `portfolio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'test.db');
    db = new PrismaClient({
      datasources: { db: { url: `file:${dbPath.replace(/\\/g, '/')}` } },
    });

    // Create required tables
    await db.$executeRawUnsafe(`
      CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL,
        "emailHash" TEXT UNIQUE,
        "name" TEXT,
        "passwordHash" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE "Portfolio" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "currency" TEXT NOT NULL DEFAULT 'USD',
        "description" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      );
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE "PortfolioTransaction" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "portfolioId" TEXT NOT NULL,
        "symbol" TEXT,
        "type" TEXT NOT NULL,
        "quantity" REAL NOT NULL DEFAULT 0,
        "price" REAL NOT NULL DEFAULT 0,
        "fee" REAL NOT NULL DEFAULT 0,
        "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "notes" TEXT,
        FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE
      );
    `);
    await db.$executeRawUnsafe(`
      CREATE TABLE "UserInvestmentProfile" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL UNIQUE,
        "horizon" TEXT NOT NULL DEFAULT 'medium',
        "riskTolerance" TEXT NOT NULL DEFAULT 'moderate',
        "liquidityNeeds" TEXT NOT NULL DEFAULT 'medium',
        "lossCapacity" TEXT NOT NULL DEFAULT 'moderate',
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      );
    `);

    // Create two test users
    await db.user.create({
      data: { id: 'user-1', email: 'alice@test.com', passwordHash: 'hash1' },
    });
    await db.user.create({
      data: { id: 'user-2', email: 'bob@test.com', passwordHash: 'hash2' },
    });

    service = new PortfolioService(db);
  });

  afterEach(async () => {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and lists user-scoped portfolios', async () => {
    const p1 = await service.createPortfolio('user-1', 'Main Growth', 'USD', 'Core portfolio');
    expect(p1.name).toBe('Main Growth');
    expect(p1.userId).toBe('user-1');

    const listUser1 = await service.listPortfolios('user-1');
    expect(listUser1.length).toBe(1);

    // User-2 cannot see User-1's portfolio
    const listUser2 = await service.listPortfolios('user-2');
    expect(listUser2.length).toBe(0);
  });

  it('calculates average cost basis, cash balance, and realized P&L across buy and sell transactions', async () => {
    const p = await service.createPortfolio('user-1', 'Tech Stocks');

    // 1. Deposit 50,000 cash
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'CASH_DEPOSIT',
      price: 50_000,
    });

    // 2. Buy 100 AAPL @ $150 (fee: $5) -> Cost: 15,005, Cost Basis: 150.05
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'BUY',
      symbol: 'AAPL',
      quantity: 100,
      price: 150,
      fee: 5,
    });

    // 3. Buy 100 more AAPL @ $170 (fee: $5) -> Total shares: 200, Total cost: 15,005 + 17,005 = 32,010. Avg basis = 160.05
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'BUY',
      symbol: 'AAPL',
      quantity: 100,
      price: 170,
      fee: 5,
    });

    // 4. Sell 50 AAPL @ $200 (fee: $10) -> Proceeds: 50 * 200 - 10 = 9,990.
    // Cost of 50 shares sold: 50 * 160.05 = 8,002.5. Realized Gain = 9,990 - 8,002.5 = 1,987.5
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'SELL',
      symbol: 'AAPL',
      quantity: 50,
      price: 200,
      fee: 10,
    });

    // 5. Receive $200 dividend
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'DIVIDEND',
      symbol: 'AAPL',
      price: 200,
    });

    // Current market price lookup mock: AAPL is $220
    const mockPrices = async (sym: string) => (sym === 'AAPL' ? 220 : null);
    const summary = await service.getPortfolioSummary('user-1', p.id, mockPrices);

    expect(summary.totalRealizedPnL).toBeCloseTo(1987.5, 1);
    // Remaining shares: 150 AAPL
    const aapl = summary.holdings.find((h) => h.symbol === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl?.quantity).toBe(150);
    expect(aapl?.averageCostBasis).toBeCloseTo(160.05, 2);
    expect(aapl?.currentPrice).toBe(220);
    // Current value: 150 * 220 = 33,000
    expect(aapl?.currentValue).toBe(33_000);
    // Unrealized PnL: 33,000 - (150 * 160.05) = 33,000 - 24,007.5 = 8,992.5
    expect(aapl?.unrealizedPnL).toBeCloseTo(8992.5, 1);

    // Cash balance:
    // 50,000 (deposit) - 15,005 (buy 1) - 17,005 (buy 2) + 9,990 (sell) + 200 (div) = 28,180
    expect(summary.cashBalance).toBe(28_180);
    // Total value: 33,000 (stock) + 28,180 (cash) = 61,180
    expect(summary.totalValue).toBe(61_180);
  });

  it('enforces strict cross-user access controls', async () => {
    const pAlice = await service.createPortfolio('user-1', 'Alice Portfolio');

    // Bob attempts to add a transaction to Alice's portfolio -> REJECTED
    await expect(
      service.addTransaction('user-2', {
        portfolioId: pAlice.id,
        type: 'CASH_DEPOSIT',
        price: 1000,
      }),
    ).rejects.toThrow('Portfolio not found or access denied');

    // Bob attempts to view Alice's summary -> REJECTED
    await expect(service.getPortfolioSummary('user-2', pAlice.id)).rejects.toThrow(
      'Portfolio not found or access denied',
    );

    // Bob attempts to delete Alice's portfolio -> returns false
    const deleted = await service.deletePortfolio('user-2', pAlice.id);
    expect(deleted).toBe(false);
  });

  it('simulates portfolio rebalancing accurately', async () => {
    const p = await service.createPortfolio('user-1', 'Index Rebalancer');
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'CASH_DEPOSIT',
      price: 100_000,
    });
    // Buy $50,000 AAPL and $50,000 NVDA
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'BUY',
      symbol: 'AAPL',
      quantity: 250,
      price: 200,
    });
    await service.addTransaction('user-1', {
      portfolioId: p.id,
      type: 'BUY',
      symbol: 'NVDA',
      quantity: 500,
      price: 100,
    });

    // Prices now: AAPL = 200 ($50k), NVDA = 100 ($50k) -> 50% / 50%
    const mockPrices = async (sym: string) => (sym === 'AAPL' ? 200 : sym === 'NVDA' ? 100 : null);

    // Desired rebalance: 70% AAPL, 30% NVDA
    const rebalance = await service.simulateRebalancing(
      'user-1',
      p.id,
      [
        { symbol: 'AAPL', targetWeight: 0.7 },
        { symbol: 'NVDA', targetWeight: 0.3 },
      ],
      mockPrices,
    );

    expect(rebalance.totalValue).toBe(100_000);
    const aaplAction = rebalance.actions.find((a) => a.symbol === 'AAPL');
    const nvdaAction = rebalance.actions.find((a) => a.symbol === 'NVDA');

    expect(aaplAction?.action).toBe('BUY');
    expect(aaplAction?.targetValue).toBe(70_000); // Needs +20,000 -> buy 100 shares
    expect(aaplAction?.estimatedQuantityChange).toBe(100);

    expect(nvdaAction?.action).toBe('SELL');
    expect(nvdaAction?.targetValue).toBe(30_000); // Needs -20,000 -> sell 200 shares
    expect(nvdaAction?.estimatedQuantityChange).toBe(200);
  });
});
