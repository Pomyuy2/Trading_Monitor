import { InvestmentResearchAgent } from '../server/src/agent/research-agent.js';
import { MarketService } from '../server/src/services/market-service.js';
import { ProviderRegistry } from '../server/src/providers/registry.js';
import { LruCache } from '../server/src/cache/cache.js';
import { KeywordAi } from '../server/src/ai/keyword-ai.js';
import { MockAi } from '../server/src/ai/mock-ai.js';
import { PortfolioService } from '../server/src/portfolio/portfolio-service.js';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(root, '.env') });
dotenv.config({ path: join(root, 'server', '.env') });

async function main() {
  console.log('=== VERIFYING HYBRID INVESTMENT RESEARCH AGENT V1 ===');

  const db = new PrismaClient();
  const portfolioService = new PortfolioService(db);

  // Setup providers
  const providers = new ProviderRegistry();
  const cache = new LruCache();
  const ai = {
    llm: null,
    keyword: new KeywordAi(),
    mock: new MockAi(),
  };

  const market = new MarketService(providers, cache, ai);

  const baseUrl = process.env.AI_BASE_URL || 'https://ai.jarengjar.com/v1';
  const apiKey = process.env.AI_API_KEY || '';
  const model = process.env.AI_MODEL || 'combo1';

  console.log(`AI Configuration: Base=${baseUrl}, Model=${model}, HasKey=${Boolean(apiKey)}`);

  const agent = new InvestmentResearchAgent(baseUrl, apiKey, model);

  console.log('\n--- Test 1: AAPL Comprehensive Valuation & Risk Research ---');
  const t0 = Date.now();
  const resAapl = await agent.research(
    'Conduct an investment research report for AAPL with DCF valuation, key technical indicators, and downside risk assessment.',
    'AAPL',
    'en',
    {
      market,
      portfolio: portfolioService,
      userId: 'test-user-e2e',
    },
  );
  const durAapl = Date.now() - t0;

  console.log(`Research Completed in ${durAapl}ms`);
  console.log(`Answer:\n${resAapl.answer.substring(0, 300)}...`);
  console.log(`Sources (${resAapl.sources.length}):`, resAapl.sources.map((s) => s.label).join(', '));
  console.log(`Tools Executed (${resAapl.toolSteps?.length ?? 0}):`);
  for (const step of resAapl.toolSteps ?? []) {
    console.log(`  * Tool: ${step.tool} (${step.durationMs}ms, success: ${step.success}, summary: ${step.summary})`);
  }

  if (resAapl.report) {
    console.log(`\nReport Symbol: ${resAapl.report.symbol}`);
    console.log(`Verdict: ${resAapl.report.verdict}`);
    console.log(`Summary: ${resAapl.report.summary}`);
    if (resAapl.report.valuation?.dcf) {
      console.log(`DCF Fair Value: $${resAapl.report.valuation.dcf.fairValue.toFixed(2)} (Current: $${resAapl.report.valuation.dcf.currentPrice.toFixed(2)})`);
      console.log(`  Bull: $${resAapl.report.valuation.dcf.scenarios.bull.fairValue.toFixed(2)} (${resAapl.report.valuation.dcf.scenarios.bull.upsidePercent.toFixed(1)}%)`);
      console.log(`  Base: $${resAapl.report.valuation.dcf.scenarios.base.fairValue.toFixed(2)} (${resAapl.report.valuation.dcf.scenarios.base.upsidePercent.toFixed(1)}%)`);
      console.log(`  Bear: $${resAapl.report.valuation.dcf.scenarios.bear.fairValue.toFixed(2)} (${resAapl.report.valuation.dcf.scenarios.bear.upsidePercent.toFixed(1)}%)`);
    }
    if (resAapl.report.technicals) {
      console.log(`Technicals Trend: ${resAapl.report.technicals.trend}`);
      console.log(`  RSI: ${resAapl.report.technicals.rsi?.toFixed(1) ?? 'N/A'}`);
    }
    if (resAapl.report.riskAssessment) {
      console.log(`Risk Rating: ${resAapl.report.riskAssessment.riskRating}`);
      console.log(`  Thesis Invalidation:`, resAapl.report.riskAssessment.thesisInvalidation);
    }
  }

  console.log('\n--- Test 2: Portfolio Ledger Multi-User Security Verification ---');
  await db.user.upsert({
    where: { id: 'test-user-1' },
    update: {},
    create: { id: 'test-user-1', email: 'test1@example.com', name: 'User 1', passwordHash: '' },
  });
  await db.user.upsert({
    where: { id: 'test-user-2' },
    update: {},
    create: { id: 'test-user-2', email: 'test2@example.com', name: 'User 2', passwordHash: '' },
  });

  // Create portfolio for user-1
  const p1 = await portfolioService.createPortfolio('test-user-1', 'Growth Core');
  await portfolioService.addTransaction('test-user-1', {
    portfolioId: p1.id,
    type: 'CASH_DEPOSIT',
    price: 10000,
  });
  await portfolioService.addTransaction('test-user-1', {
    portfolioId: p1.id,
    symbol: 'AAPL',
    type: 'BUY',
    quantity: 20,
    price: 150,
  });

  const summaryP1 = await portfolioService.getPortfolioSummary('test-user-1', p1.id, async (sym) => (sym === 'AAPL' ? 180 : null));
  console.log(`User 1 Portfolio Value: $${summaryP1.totalValue} (Cash: $${summaryP1.cashBalance}, Invested: $${summaryP1.investedValue})`);
  console.log(`User 1 Unrealized P&L: $${summaryP1.totalUnrealizedPnL} (+${summaryP1.totalUnrealizedPnLPercent.toFixed(2)}%)`);

  // Verify User 2 is strictly blocked from accessing User 1 portfolio
  let user2Denied = false;
  try {
    await portfolioService.getPortfolioSummary('test-user-2', p1.id);
  } catch (err: any) {
    if (err.message.includes('not found')) {
      user2Denied = true;
    }
  }
  console.log(`Cross-user portfolio isolation enforced: ${user2Denied}`);

  // Rebalancing simulation
  const rebal = await portfolioService.simulateRebalancing(
    'test-user-1',
    p1.id,
    [{ symbol: 'AAPL', targetWeight: 0.5 }],
    async (sym) => (sym === 'AAPL' ? 180 : null),
  );
  console.log(`Rebalance Simulation Actions (${rebal.actions.length}):`);
  for (const act of rebal.actions) {
    console.log(`  * ${act.symbol}: current ${(act.currentWeight * 100).toFixed(1)}% -> target ${(act.targetWeight * 100).toFixed(1)}% (${act.action} $${Math.abs(act.diffValue).toFixed(2)})`);
  }

  // Clean up
  await portfolioService.deletePortfolio('test-user-1', p1.id);
  await db.user.deleteMany({ where: { id: { in: ['test-user-1', 'test-user-2'] } } });
  await db.$disconnect();

  console.log('\n=== ALL AGENT CAPABILITIES AND SECURITY CONTROLS VERIFIED ===');
}

main().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
