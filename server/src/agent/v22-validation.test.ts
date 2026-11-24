import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InvestmentResearchAgent } from './research-agent.js';
import type { AgentContext } from './types.js';
import type { AgentStreamEvent } from '@tm/shared';

describe('Investment Research Agent V2.2 — Autonomous Research Planning & Evidence Verification', () => {
  const baseUrl = 'http://mock-ai.internal';
  const apiKey = 'test-key';
  const model = 'combo1';

  let mockMarket: any;
  let mockPortfolio: any;
  let mockContext: AgentContext;

  beforeEach(() => {
    mockMarket = {
      quote: vi.fn(async (sym: string) => ({
        symbol: sym,
        price: 150.0,
        change: 2.5,
        changePercent: 1.69,
        marketCap: 2_500_000_000_000,
      })),
      companyFacts: vi.fn(async (sym: string) => ({
        symbol: sym,
        annual: [
          {
            fiscalYear: 2024,
            revenue: 60_900_000_000,
            netIncome: 29_760_000_000,
            operatingCashFlow: 28_000_000_000,
            capitalExpenditures: 3_000_000_000,
            totalDebt: 10_000_000_000,
            cashAndEquivalents: 15_000_000_000,
            sharesDiluted: 24_500_000_000,
          },
        ],
        quarterly: [],
        meta: { source: 'SEC' },
      })),
      candles: vi.fn(async () => ({
        candles: [
          { time: 1700000000, open: 140, high: 152, low: 139, close: 150, volume: 10000 },
        ],
        meta: { source: 'mock' },
      })),
    };

    mockPortfolio = {
      getInvestmentProfile: vi.fn(async () => ({
        horizon: 'medium',
        riskTolerance: 'moderate',
        liquidityNeeds: 'medium',
        lossCapacity: 'moderate',
      })),
    };

    mockContext = {
      userId: 'test-user-v22',
      lang: 'en',
      market: mockMarket,
      portfolio: mockPortfolio,
    };
  });

  it('Scenario 1: Complex research query triggers ResearchPlanner and emits plan_ready in streaming', async () => {
    const originalFetch = globalThis.fetch;
    const events: AgentStreamEvent[] = [];

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: {
        getReader: () => {
          const chunks = [
            'data: {"choices":[{"delta":{"content":"Based on our research plan, NVDA revenue grew strongly."}}]}\n\n',
            'data: [DONE]\n\n',
          ];
          let idx = 0;
          return {
            read: async () => {
              if (idx < chunks.length) {
                const value = new TextEncoder().encode(chunks[idx++]);
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    })) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
        enablePlanning: true,
        enableVerification: true,
      });

      const resp = await agent.researchStream(
        'Deep research on NVDA: revenue drivers, DCF valuation, and Item 1A risks',
        'NVDA',
        'en',
        mockContext,
        [],
        (e) => {
          events.push(e);
        },
      );

      // Verify plan_ready event was emitted
      const planEvent = events.find((e) => e.type === 'plan_ready');
      expect(planEvent).toBeDefined();
      if (planEvent && planEvent.type === 'plan_ready') {
        expect(planEvent.data.plan.complexity).toBe('deep');
        expect(planEvent.data.plan.targetCompanies).toContain('NVDA');
        expect(planEvent.data.plan.tasks.length).toBeGreaterThanOrEqual(3);
      }

      // Verify final response contains plan and verification
      expect(resp.plan).toBeDefined();
      expect(resp.verification).toBeDefined();
      expect(resp.agentVersion).toBe('v2.2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 2: Fast-path bypass avoids planning overhead for simple price/quote queries', async () => {
    const originalFetch = globalThis.fetch;
    const events: AgentStreamEvent[] = [];

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: {
        getReader: () => {
          const chunks = [
            'data: {"choices":[{"delta":{"content":"NVDA is currently trading at $150.00."}}]}\n\n',
            'data: [DONE]\n\n',
          ];
          let idx = 0;
          return {
            read: async () => {
              if (idx < chunks.length) {
                const value = new TextEncoder().encode(chunks[idx++]);
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    })) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      const resp = await agent.researchStream(
        'what is the price of NVDA?',
        'NVDA',
        'en',
        mockContext,
        [],
        (e) => {
          events.push(e);
        },
      );

      // Fast-path should NOT emit plan_ready
      const planEvent = events.find((e) => e.type === 'plan_ready');
      expect(planEvent).toBeUndefined();
      expect(resp.answer).toContain('$150.00');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 3: In-request memoization eliminates duplicate tool executions', async () => {
    const originalFetch = globalThis.fetch;
    let callStep = 0;

    globalThis.fetch = vi.fn(async () => {
      callStep++;
      if (callStep === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    { id: 'c1', function: { name: 'get_quote', arguments: '{"symbol":"NVDA"}' } },
                  ],
                },
              },
            ],
          }),
        } as any;
      }
      if (callStep === 2) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    // Second call with duplicate arguments
                    { id: 'c2', function: { name: 'get_quote', arguments: '{"symbol":"NVDA"}' } },
                  ],
                },
              },
            ],
          }),
        } as any;
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'NVDA analysis finished.' } }],
        }),
      } as any;
    }) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      const resp = await agent.research(
        'Analyze NVDA valuation and growth drivers',
        'NVDA',
        'en',
        mockContext,
      );

      // Market quote should only be invoked once because of memoization!
      expect(mockMarket.quote).toHaveBeenCalledTimes(1);
      expect(resp.answer).toContain('NVDA analysis finished.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 4: Multi-stock fair allocation prevents one ticker from starving another', async () => {
    const originalFetch = globalThis.fetch;
    let step = 0;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      step++;
      const body = JSON.parse(init.body);
      const lastMsg = body.messages[body.messages.length - 1];

      if (lastMsg?.content && lastMsg.content.includes('allocationCapReached')) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'Comparison between AAPL and MSFT completed.' } }],
          }),
        } as any;
      }

      if (step <= 6) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    { id: `c_${step}`, function: { name: 'get_quote', arguments: `{"symbol":"AAPL","nonce":${step}}` } },
                  ],
                },
              },
            ],
          }),
        } as any;
      }

      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
        }),
      } as any;
    }) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      const resp = await agent.research(
        'Compare AAPL and MSFT cloud revenue and profitability',
        undefined,
        'en',
        mockContext,
      );

      // AAPL should be capped at 5 tool calls (10 total / 2 symbols)
      expect(mockMarket.quote).toHaveBeenCalledTimes(5);
      expect(resp.answer).toContain('Comparison between AAPL and MSFT completed.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 5: Contradiction detection surfaces divergence between verdict and DCF downside', async () => {
    const originalFetch = globalThis.fetch;
    let step = 0;

    globalThis.fetch = vi.fn(async () => {
      step++;
      if (step === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    { id: 'c1', function: { name: 'calculate_valuation', arguments: '{"symbol":"NVDA","wacc":0.15}' } },
                  ],
                },
              },
            ],
          }),
        } as any;
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Verdict: ATTRACTIVE_UNDER_ASSUMPTIONS with high growth potential.',
              },
            },
          ],
        }),
      } as any;
    }) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      const resp = await agent.research(
        'Conduct full valuation and research on NVDA',
        'NVDA',
        'en',
        mockContext,
      );

      // EvidenceVerifier should detect the contradiction
      expect(resp.verification).toBeDefined();
      expect(resp.answer).toContain('Material Opposing Signals Surfaced');
      expect(resp.answer).toContain('Valuation vs Recommendation Disconnect');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 6: Preserves V1 default and keeps V2.1 baseline operational as fallback', async () => {
    const v1Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
      enableFinancialRag: false,
      agentVersion: 'v1',
    });
    expect(v1Agent.agentVersion).toBe('v1');
    expect(v1Agent.enableFinancialRag).toBe(false);
    expect(v1Agent.enablePlanning).toBe(false);

    const v21Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
      enableFinancialRag: true,
      agentVersion: 'v2.1',
      enablePlanning: false,
      enableVerification: false,
    });
    expect(v21Agent.agentVersion).toBe('v2.1');
    expect(v21Agent.enableFinancialRag).toBe(true);
    expect(v21Agent.enablePlanning).toBe(false);

    const v22Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
      enableFinancialRag: true,
      agentVersion: 'v2.2',
    });
    expect(v22Agent.agentVersion).toBe('v2.2');
    expect(v22Agent.enableFinancialRag).toBe(true);
    expect(v22Agent.enablePlanning).toBe(true);
  });

  it('Scenario 7: Enforces strict historical cutoff dates and flags lookahead citations', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'In fiscal 2025 revenue surged to $116B [SEC-NVDA-10-K-2025-02-26-ITEM_7-c5].',
            },
          },
        ],
      }),
    })) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      // Question explicitly asks about as of FY2024 (cutoff 2024-12-31)
      const resp = await agent.research(
        'What was NVDA revenue growth as of FY2024?',
        'NVDA',
        'en',
        mockContext,
      );

      expect(resp.verification).toBeDefined();
      expect(resp.verification.cutoffCompliant).toBe(false);
      expect(resp.answer).toContain('historical cutoff');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 8: Bounded tool exhaustion disclaims unfinished tasks rather than reporting completeness', async () => {
    const originalFetch = globalThis.fetch;
    let count = 0;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      count++;
      const body = JSON.parse(init.body);
      const isSummary = body.messages?.some((m: any) => typeof m.content === 'string' && m.content.includes('Summarize'));

      if (isSummary) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'Partial analysis compiled.' } }],
          }),
        } as any;
      }

      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  { id: `c_${count}`, function: { name: 'get_quote', arguments: `{"symbol":"NVDA","c":${count}}` } },
                ],
              },
            },
          ],
        }),
      } as any;
    }) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      const resp = await agent.research(
        'Deep multi-factor analysis of NVDA',
        'NVDA',
        'en',
        mockContext,
      );

      expect(resp.answer).toContain('Research Horizon & Budget Limitation');
      expect(resp.answer).toContain('partial findings');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 9: Cancellation via AbortSignal terminates streaming cleanly', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();

    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
          }),
        },
      } as any;
    }) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      const events: AgentStreamEvent[] = [];
      await agent.researchStream(
        'Analyze NVDA',
        'NVDA',
        'en',
        mockContext,
        [],
        (e) => { events.push(e); },
        controller.signal,
      );

      // Done event should complete without throw
      expect(events.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Scenario 10: Graceful fallback to V2.1 baseline when planner encounters unexpected error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'V2.1 baseline fallback response.' } }],
      }),
    })) as any;

    try {
      const agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
        enableFinancialRag: true,
        agentVersion: 'v2.2',
      });

      // Force planner to throw
      (agent as any).planner.plan = vi.fn().mockRejectedValue(new Error('Simulated planner failure'));

      const resp = await agent.research(
        'Analyze NVDA financial performance',
        'NVDA',
        'en',
        mockContext,
      );

      expect(resp.answer).toContain('V2.1 baseline fallback response.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
