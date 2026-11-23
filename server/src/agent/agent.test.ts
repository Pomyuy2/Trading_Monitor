import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tools/registry.js';
import { InvestmentResearchAgent } from './research-agent.js';
import type { AgentContext } from './types.js';

describe('ToolRegistry & Agent Tools', () => {
  const registry = new ToolRegistry({ enableFinancialRag: false });

  it('lists all 13 investment research and portfolio tools in baseline mode', () => {
    const tools = registry.list();
    expect(tools.length).toBe(13);
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_quote');
    expect(names).toContain('get_candles');
    expect(names).toContain('get_company_profile');
    expect(names).toContain('get_company_facts');
    expect(names).toContain('get_company_insight');
    expect(names).toContain('get_news');
    expect(names).toContain('calculate_indicators');
    expect(names).toContain('calculate_financial_ratios');
    expect(names).toContain('calculate_valuation');
    expect(names).toContain('analyze_stock_risk');
    expect(names).toContain('compare_stocks');
    expect(names).toContain('get_user_portfolios');
    expect(names).toContain('get_portfolio_analysis');
  });

  it('lists all 15 tools when financial RAG is enabled', () => {
    const ragRegistry = new ToolRegistry({ enableFinancialRag: true });
    expect(ragRegistry.list().length).toBe(15);
    expect(ragRegistry.get('search_financial_documents')).toBeDefined();
    expect(ragRegistry.get('get_document_section')).toBeDefined();
  });

  it('generates valid OpenAI-compatible function calling schemas', () => {
    const definitions = registry.getOpenAiToolDefinitions();
    expect(definitions.length).toBe(13);

    for (const d of definitions) {
      expect(d.type).toBe('function');
      expect(d.function.name).toBeDefined();
      expect(d.function.description).toBeDefined();
      expect(d.function.parameters).toBeDefined();
    }

    const quoteDef = definitions.find((d) => d.function.name === 'get_quote');
    expect(quoteDef?.function.parameters.properties).toHaveProperty('symbol');
  });

  it('rejects invalid arguments via strict Zod validation without throwing', async () => {
    const dummyCtx = {} as AgentContext;

    // Missing required symbol
    const res1 = await registry.execute('get_quote', {}, dummyCtx);
    expect(res1.success).toBe(false);
    expect(res1.error).toContain('symbol');

    // Invalid range
    const res2 = await registry.execute('get_candles', { symbol: 'AAPL', range: '100Y' }, dummyCtx);
    expect(res2.success).toBe(false);
    expect(res2.error).toContain('range');

    // Compare stocks with fewer than 2 symbols
    const res3 = await registry.execute('compare_stocks', { symbols: ['AAPL'] }, dummyCtx);
    expect(res3.success).toBe(false);
    expect(res3.error).toContain('symbols');
  });

  it('handles unknown tool execution gracefully', async () => {
    const dummyCtx = {} as AgentContext;
    const res = await registry.execute('non_existent_tool', {}, dummyCtx);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown tool');
  });

  it('executes calculate_indicators with mocked market candles', async () => {
    const mockCandles = [
      { time: 100, open: 150, high: 155, low: 148, close: 152, volume: 1000 },
      { time: 200, open: 152, high: 158, low: 151, close: 156, volume: 1200 },
      { time: 300, open: 156, high: 160, low: 155, close: 159, volume: 1500 },
      { time: 400, open: 159, high: 162, low: 158, close: 161, volume: 1100 },
      { time: 500, open: 161, high: 165, low: 160, close: 164, volume: 1300 },
      { time: 600, open: 164, high: 168, low: 163, close: 167, volume: 1400 },
      { time: 700, open: 167, high: 170, low: 165, close: 169, volume: 1600 },
      { time: 800, open: 169, high: 172, low: 168, close: 171, volume: 1700 },
      { time: 900, open: 171, high: 175, low: 170, close: 173, volume: 1800 },
      { time: 1000, open: 173, high: 177, low: 172, close: 175, volume: 1900 },
      { time: 1100, open: 175, high: 179, low: 174, close: 177, volume: 2000 },
      { time: 1200, open: 177, high: 181, low: 176, close: 179, volume: 2100 },
      { time: 1300, open: 179, high: 183, low: 178, close: 181, volume: 2200 },
      { time: 1400, open: 181, high: 185, low: 180, close: 183, volume: 2300 },
      { time: 1500, open: 183, high: 187, low: 182, close: 185, volume: 2400 },
      { time: 1600, open: 185, high: 189, low: 184, close: 187, volume: 2500 },
      { time: 1700, open: 187, high: 191, low: 186, close: 189, volume: 2600 },
      { time: 1800, open: 189, high: 193, low: 188, close: 191, volume: 2700 },
      { time: 1900, open: 191, high: 195, low: 190, close: 193, volume: 2800 },
      { time: 2000, open: 193, high: 197, low: 192, close: 195, volume: 2900 },
      { time: 2100, open: 195, high: 200, low: 194, close: 198, volume: 3000 },
    ];

    const mockCtx: AgentContext = {
      userId: 'test-user',
      lang: 'en',
      market: {
        candles: async () => ({
          symbol: 'AAPL',
          range: '1Y',
          resolution: '1day',
          candles: mockCandles,
          meta: { source: 'Yahoo Finance', updatedAt: new Date().toISOString() },
        }),
      } as any,
      portfolio: {} as any,
    };

    const res = await registry.execute('calculate_indicators', { symbol: 'AAPL', range: '1Y' }, mockCtx);
    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    expect((res.data as any).price).toBe(198);
    expect((res.data as any).rsi14).toBeDefined();
    expect((res.data as any).trend).toBe('bullish');
    expect(res.evidenceSource?.label).toContain('AAPL Technical Indicators');
  });

  it('executes compare_stocks across multiple symbols concurrently', async () => {
    const mockCtx: AgentContext = {
      userId: 'test-user',
      lang: 'en',
      market: {
        quote: async (sym: string) => ({
          symbol: sym,
          name: `${sym} Corp`,
          price: sym === 'AAPL' ? 220 : 130,
          changePct: 1.5,
          marketCap: sym === 'AAPL' ? 3_000_000_000_000 : 2_500_000_000_000,
        }),
        companyFacts: async () => ({ annual: [] }),
        candles: async () => ({
          candles: [{ close: 100 }, { close: 105 }, { close: 110 }],
          meta: { source: 'Yahoo' },
        }),
      } as any,
      portfolio: {} as any,
    };

    const res = await registry.execute('compare_stocks', { symbols: ['AAPL', 'NVDA'] }, mockCtx);
    expect(res.success).toBe(true);
    const data = res.data as any[];
    expect(data.length).toBe(2);
    expect(data[0].symbol).toBe('AAPL');
    expect(data[1].symbol).toBe('NVDA');
  });

  it('generates system prompt containing missing 8-K guidance, multi-stock budget, and cutoff rules in V2 RAG mode', () => {
    const agentV1 = new InvestmentResearchAgent('http://fake', 'key', 'model', console, { enableFinancialRag: false });
    const agentV2 = new InvestmentResearchAgent('http://fake', 'key', 'model', console, { enableFinancialRag: true });

    expect(agentV1.enableFinancialRag).toBe(false);
    expect(agentV2.enableFinancialRag).toBe(true);

    const promptV1 = (agentV1 as any).buildSystemPrompt({}, false, 'global');
    const promptV2 = (agentV2 as any).buildSystemPrompt({}, false, 'global');

    expect(promptV1).not.toContain('MISSING 8-K GUIDANCE');
    expect(promptV2).toContain('MISSING 8-K GUIDANCE & DOCUMENT HORIZON LIMITATION');
    expect(promptV2).toContain('MULTI-STOCK QUESTIONS & BOUNDED TOOL BUDGET');
    expect(promptV2).toContain('HISTORICAL TIME AWARENESS (STRICTLY NO LOOKAHEAD)');
    expect(promptV2).toContain('search_financial_documents');
  });
});
