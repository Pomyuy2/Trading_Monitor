import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvestmentResearchAgent } from './research-agent.js';
import { ToolOrchestrator } from './orchestrator.js';
import { ToolRegistry } from './tools/registry.js';
import type { AgentContext, ToolDefinition } from './types.js';
import type { AgentStreamEvent } from '@tm/shared';
import { z } from 'zod/v4';

// Helper to create SSE chunk string
function makeSseChunk(delta: Record<string, unknown>, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta,
        finish_reason,
      },
    ],
  })}\n\n`;
}

function makeSseStreamResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

describe('ToolOrchestrator.runStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams incremental text deltas and emits them to onEvent', async () => {
    const registry = new ToolRegistry();
    const orchestrator = new ToolOrchestrator(
      registry,
      'https://router.example.com/v1',
      'sk-test',
      'combo1',
    );

    const sseChunks = [
      makeSseChunk({ role: 'assistant', content: 'Apple Inc. ' }),
      makeSseChunk({ content: 'shows strong ' }),
      makeSseChunk({ content: 'cash generation.' }, 'stop'),
      'data: [DONE]\n\n',
    ];

    vi.stubGlobal('fetch', async () => makeSseStreamResponse(sseChunks));

    const events: AgentStreamEvent[] = [];
    const dummyCtx = {} as AgentContext;

    const result = await orchestrator.runStream(
      [{ role: 'user', content: 'Tell me about AAPL' }],
      dummyCtx,
      {},
      async (ev) => {
        events.push(ev);
      },
    );

    expect(result.finalContent).toBe('Apple Inc. shows strong cash generation.');
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBe(3);
    expect(textDeltas.map((e) => (e.data as { delta: string }).delta).join('')).toBe(
      'Apple Inc. shows strong cash generation.',
    );
  });

  it('accumulates tool call arguments over fragmented chunks and executes tool', async () => {
    const registry = new ToolRegistry();

    // Register a mock tool with typed parameters
    const mockTool: ToolDefinition<{ symbol: string }, { symbol: string; price: number }> = {
      name: 'get_quote',
      description: 'Get quote for a symbol',
      parameters: z.object({ symbol: z.string() }),
      async execute(args) {
        return {
          success: true,
          data: { symbol: args.symbol, price: 230.5 },
          provenance: {
            source: 'Mock Provider',
            updatedAt: new Date().toISOString(),
          },
          summary: `${args.symbol} price is $230.50`,
          evidenceSource: { id: 'src-1', label: `${args.symbol} Quote`, type: 'price' },
        };
      },
    };
    registry.register(mockTool);

    const orchestrator = new ToolOrchestrator(
      registry,
      'https://router.example.com/v1',
      'sk-test',
      'combo1',
    );

    // Call 1: Model requests tool call across 3 chunks
    const turn1Chunks = [
      makeSseChunk({
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'call_123', type: 'function', function: { name: 'get_quote', arguments: '' } }],
      }),
      makeSseChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"symbol":' } }],
      }),
      makeSseChunk(
        {
          tool_calls: [{ index: 0, function: { arguments: '"AAPL"}' } }],
        },
        'tool_calls',
      ),
      'data: [DONE]\n\n',
    ];

    // Call 2: Model gives final answer
    const turn2Chunks = [
      makeSseChunk({ role: 'assistant', content: 'AAPL is currently trading at $230.50.' }, 'stop'),
      'data: [DONE]\n\n',
    ];

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount === 1) return makeSseStreamResponse(turn1Chunks);
      return makeSseStreamResponse(turn2Chunks);
    });

    const events: AgentStreamEvent[] = [];
    const dummyCtx = {} as AgentContext;

    const result = await orchestrator.runStream(
      [{ role: 'user', content: 'Price of AAPL?' }],
      dummyCtx,
      {},
      async (ev) => {
        events.push(ev);
      },
    );

    expect(callCount).toBe(2);
    expect(result.finalContent).toBe('AAPL is currently trading at $230.50.');
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].tool).toBe('get_quote');
    expect(result.steps[0].success).toBe(true);
    expect(result.sources.length).toBe(1);
    expect(result.sources[0].label).toBe('AAPL Quote');

    // Check events emitted
    const toolStart = events.find((e) => e.type === 'tool_start');
    const toolResult = events.find((e) => e.type === 'tool_result');
    const textDelta = events.find((e) => e.type === 'text_delta');

    expect(toolStart).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(textDelta).toBeDefined();
    expect((toolStart?.data as { tool: string }).tool).toBe('get_quote');
    expect((toolResult?.data as { success: boolean }).success).toBe(true);
  });

  it('buffers and suppresses raw ```investment_report block from text_delta stream', async () => {
    const registry = new ToolRegistry();
    const orchestrator = new ToolOrchestrator(
      registry,
      'https://router.example.com/v1',
      'sk-test',
      'combo1',
    );

    const sseChunks = [
      makeSseChunk({ role: 'assistant', content: 'Here is the analysis.\n\n' }),
      makeSseChunk({ content: '```investment_report\n' }),
      makeSseChunk({ content: '{"symbol":"AAPL","companyName":"Apple"}' }),
      makeSseChunk({ content: '\n```' }, 'stop'),
      'data: [DONE]\n\n',
    ];

    vi.stubGlobal('fetch', async () => makeSseStreamResponse(sseChunks));

    const events: AgentStreamEvent[] = [];
    const dummyCtx = {} as AgentContext;

    const result = await orchestrator.runStream(
      [{ role: 'user', content: 'Analyze AAPL' }],
      dummyCtx,
      {},
      async (ev) => {
        events.push(ev);
      },
    );

    // Orchestrator preserves full content for report extraction
    expect(result.finalContent).toContain('```investment_report');

    // BUT text_delta events must NOT contain the raw JSON!
    const streamedText = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { delta: string }).delta)
      .join('');

    expect(streamedText).toBe('Here is the analysis.\n\n');
    expect(streamedText).not.toContain('```investment_report');
    expect(streamedText).not.toContain('Apple');
  });

  it('handles cancellation via AbortSignal cleanly', async () => {
    const registry = new ToolRegistry();
    const orchestrator = new ToolOrchestrator(
      registry,
      'https://router.example.com/v1',
      'sk-test',
      'combo1',
    );

    const controller = new AbortController();

    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      // Listen to signal
      if (init?.signal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      // Simulate delay and abort
      controller.abort();
      throw new DOMException('The user aborted a request.', 'AbortError');
    });

    const dummyCtx = {} as AgentContext;

    const result = await orchestrator.runStream(
      [{ role: 'user', content: 'Test abort' }],
      dummyCtx,
      {},
      async () => {},
      controller.signal,
    );

    expect(result.stoppedReason).toBe('error');
  });
});

describe('InvestmentResearchAgent.researchStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits agent_start, text_delta, report_ready, and done events', async () => {
    const agent = new InvestmentResearchAgent(
      'https://router.example.com/v1',
      'sk-test',
      'combo1',
    );

    const validReportJson = JSON.stringify({
      symbol: 'MSFT',
      companyName: 'Microsoft Corporation',
      currentPrice: 420.5,
      currency: 'USD',
      recommendation: {
        action: 'BUY',
        conviction: 'HIGH',
        targetPrice: 480,
        expectedReturnPct: 14.1,
        timeHorizon: '12M',
        oneLineRationale: 'Strong enterprise cloud & AI positioning',
      },
      pillars: {
        fundamental: { score: 90, summary: 'High gross margins and FCF', keyMetrics: {} },
        technical: { score: 85, trend: 'BULLISH', summary: 'Above 50d and 200d MA' },
        valuation: { score: 75, modelUsed: 'DCF', fairValue: 460, summary: 'Reasonable multiple' },
        risk: { score: 80, rating: 'LOW', var95Pct: 2.1, summary: 'Defensive fortress balance sheet' },
      },
      scenarios: {
        bull: { price: 520, returnPct: 23.7, drivers: ['Azure growth re-accelerates'] },
        base: { price: 480, returnPct: 14.1, drivers: ['Steady 15% EPS growth'] },
        bear: { price: 360, returnPct: -14.4, drivers: ['Enterprise IT budget freeze'] },
      },
      provenance: {
        generatedAt: '2026-11-20T14:00:00Z',
        model: 'combo1',
        disclaimer: 'Not financial advice',
        staleFeeds: [],
        sources: [{ id: 'quote', label: 'MSFT Real-time' }],
      },
    });

    const sseChunks = [
      makeSseChunk({ role: 'assistant', content: 'Microsoft is executing well across cloud.\n\n' }),
      makeSseChunk({ content: '```investment_report\n' + validReportJson + '\n```' }, 'stop'),
      'data: [DONE]\n\n',
    ];

    vi.stubGlobal('fetch', async () => makeSseStreamResponse(sseChunks));

    const events: AgentStreamEvent[] = [];
    const mockCtx: AgentContext = {
      userId: 'u1',
      lang: 'en',
      portfolio: {
        getInvestmentProfile: async () => ({
          horizon: 'medium' as const,
          riskTolerance: 'moderate' as const,
          targetReturnPct: 10,
          maxDrawdownPct: 15,
          ethicalExclusions: [],
        }),
      } as any,
      market: {} as any,
    };

    const res = await agent.researchStream(
      'Research MSFT',
      'MSFT',
      'en',
      mockCtx,
      [],
      async (ev) => {
        events.push(ev);
      },
    );

    expect(res.answer).toContain('Microsoft is executing well across cloud.');

    // Verify events sequence
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('agent_start');
    expect(eventTypes).toContain('text_delta');
    expect(eventTypes).toContain('report_ready');
    expect(eventTypes).toContain('done');

    // Verify report_ready event
    const reportEvent = events.find((e) => e.type === 'report_ready');
    expect(reportEvent).toBeDefined();
    expect((reportEvent?.data as { report: { symbol: string } }).report.symbol).toBe('MSFT');

    // Verify done event
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect((doneEvent?.data as { model: string }).model).toBe('combo1');
  });
});
