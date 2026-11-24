import { describe, expect, it, vi } from 'vitest';
import { AdaptiveExecutor, getBoundsForComplexity } from './adaptive-executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentContext } from '../types.js';
import type { ResearchPlan } from '../planner/plan-types.js';

describe('AdaptiveExecutor', () => {
  it('assigns correct bounds based on research complexity', () => {
    const simple = getBoundsForComplexity('simple');
    expect(simple.maxSteps).toBe(2);
    expect(simple.maxTotalTools).toBe(2);
    expect(simple.totalTimeoutMs).toBe(15_000);

    const moderate = getBoundsForComplexity('moderate');
    expect(moderate.maxSteps).toBe(5);
    expect(moderate.maxTotalTools).toBe(6);

    const deep = getBoundsForComplexity('deep');
    expect(deep.maxSteps).toBe(7);
    expect(deep.maxTotalTools).toBe(10);
    expect(deep.totalTimeoutMs).toBe(50_000);
  });

  it('memoizes duplicate tool calls and avoids re-execution', async () => {
    const executedCalls: any[] = [];
    const mockTools: any = {
      getOpenAiToolDefinitions: () => [],
      execute: vi.fn(async (name: string, args: any) => {
        executedCalls.push({ name, args });
        return {
          success: true,
          data: { quote: 150.0 },
          provenance: { source: 'mock', updatedAt: new Date().toISOString() },
        };
      }),
    };

    // Mock fetch returning two rounds of tool calls with identical arguments
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    { id: 'c1', function: { name: 'get_quote', arguments: '{"symbol":"AAPL"}' } },
                  ],
                },
              },
            ],
          }),
        } as any;
      }
      if (callCount === 2) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    // Second call with same arguments
                    { id: 'c2', function: { name: 'get_quote', arguments: '{"symbol":"AAPL"}' } },
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
          choices: [{ message: { role: 'assistant', content: 'AAPL price is 150.' } }],
        }),
      } as any;
    }) as any;

    try {
      const executor = new AdaptiveExecutor(mockTools, 'http://mock-ai', 'mock-key', 'mock-model');
      const ctx: AgentContext = {
        userId: 'u1',
        lang: 'en',
        market: {} as any,
        portfolio: {} as any,
      };

      const result = await executor.execute([{ role: 'user', content: 'Check AAPL' }], ctx);

      // Tool execute should only be called once because of memoization!
      expect(mockTools.execute).toHaveBeenCalledTimes(1);
      expect(result.cachedHits).toBe(1);
      expect(result.stoppedReason).toBe('completed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('enforces multi-ticker fair budgeting', async () => {
    const mockTools: any = {
      getOpenAiToolDefinitions: () => [],
      execute: vi.fn(async () => ({
        success: true,
        data: {},
        provenance: { source: 'mock', updatedAt: new Date().toISOString() },
      })),
    };

    const plan: ResearchPlan = {
      planId: 'p-1',
      query: 'Compare AAPL and MSFT',
      complexity: 'deep',
      targetCompanies: ['AAPL', 'MSFT'],
      researchObjectives: ['compare'],
      requiredFinancialMetrics: ['rev'],
      requiredSecEvidence: ['10-K'],
      riskFactorsToInvestigate: ['comp'],
      missingOrUncertainInputs: [],
      tasks: [],
      createdAt: new Date().toISOString(),
    };

    let step = 0;
    const originalFetch = globalThis.fetch;
    // Model repeatedly tries to call AAPL 6 times
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      step++;
      const body = JSON.parse(init.body);
      const lastMsg = body.messages[body.messages.length - 1];

      // Check if last message was allocationCapReached
      if (lastMsg?.content && lastMsg.content.includes('allocationCapReached')) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'Balanced comparative findings.' } }],
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
                    { id: `c_${step}`, function: { name: 'get_quote', arguments: `{"symbol":"AAPL","unique":${step}}` } },
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
          choices: [{ message: { role: 'assistant', content: 'Finished.' } }],
        }),
      } as any;
    }) as any;

    try {
      const executor = new AdaptiveExecutor(mockTools, 'http://mock-ai', 'mock-key', 'mock-model');
      const ctx: AgentContext = { userId: 'u1', lang: 'en', market: {} as any, portfolio: {} as any };
      const res = await executor.execute([{ role: 'user', content: 'Compare AAPL MSFT' }], ctx, plan);

      // maxTotalTools is 10, targetCompanies.length is 2 -> maxPerCompany is 5
      expect(mockTools.execute).toHaveBeenCalledTimes(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts cleanly when AbortSignal is fired', async () => {
    const mockTools: any = {
      getOpenAiToolDefinitions: () => [],
      execute: vi.fn(),
    };

    const controller = new AbortController();
    controller.abort(); // already aborted

    const executor = new AdaptiveExecutor(mockTools, 'http://mock-ai', 'mock-key', 'mock-model');
    const ctx: AgentContext = { userId: 'u1', lang: 'en', market: {} as any, portfolio: {} as any };

    const res = await executor.execute([{ role: 'user', content: 'Abort test' }], ctx, undefined, undefined, controller.signal);
    expect(res.stoppedReason).toBe('aborted');
  });
});
