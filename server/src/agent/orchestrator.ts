import type { AgentStreamEvent, AskSource } from '@tm/shared';
import type { AgentContext, ToolExecutionStep } from './types.js';
import type { ToolRegistry } from './tools/registry.js';

export interface OrchestratorOptions {
  maxSteps?: number; // Maximum model-tool round trips (default 6)
  maxTotalTools?: number; // Max total tools invoked in one query (default 10)
  totalTimeoutMs?: number; // Total budget in ms (default 50,000)
  perToolTimeoutMs?: number; // Max ms per individual tool (default 12,000)
}

export interface OrchestrationResult {
  finalContent: string;
  sources: AskSource[];
  steps: ToolExecutionStep[];
  model: string;
  durationMs: number;
  stoppedReason: 'completed' | 'max_steps' | 'timeout' | 'error';
}

export class ToolOrchestrator {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly log: { info?(msg: string): void; warn(msg: string): void } = console,
  ) {}

  getBounds() {
    return { maxSteps: 6, maxTotalTools: 10, totalTimeoutMs: 50_000, perToolTimeoutMs: 12_000 };
  }

  /**
   * Executes multi-step tool-assisted reasoning with bounded limits and timeout protection.
   */
  async run(
    initialMessages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }[],
    ctx: AgentContext,
    options: OrchestratorOptions = {},
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const maxSteps = options.maxSteps ?? 6;
    const maxTotalTools = options.maxTotalTools ?? 10;
    const totalTimeoutMs = options.totalTimeoutMs ?? 50_000;
    const perToolTimeoutMs = options.perToolTimeoutMs ?? 12_000;

    const messages = [...initialMessages];
    const steps: ToolExecutionStep[] = [];
    const sourceMap = new Map<string, AskSource>();
    const openAiTools = this.tools.getOpenAiToolDefinitions();

    let stepCount = 0;
    let totalToolsInvoked = 0;
    let finalContent = '';
    let stoppedReason: OrchestrationResult['stoppedReason'] = 'completed';

    while (stepCount < maxSteps) {
      stepCount++;
      const elapsed = Date.now() - startTime;
      if (elapsed >= totalTimeoutMs) {
        stoppedReason = 'timeout';
        this.log.warn(`ToolOrchestrator timed out after ${elapsed}ms`);
        break;
      }

      // Check remaining time budget for this request
      const remainingTimeout = Math.max(5000, totalTimeoutMs - elapsed);

      let responseJson: any;
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            messages,
            tools: openAiTools,
            tool_choice: 'auto',
          }),
          signal: AbortSignal.timeout(remainingTimeout),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`AI endpoint HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }

        responseJson = await res.json();
      } catch (err) {
        this.log.warn(`Model request failed during step ${stepCount}: ${(err as Error).message}`);
        stoppedReason = 'error';
        if (!finalContent) {
          finalContent = `I encountered an issue communicating with the AI service: ${(err as Error).message}`;
        }
        break;
      }

      const choice = responseJson.choices?.[0];
      const message = choice?.message;
      if (!message) {
        stoppedReason = 'error';
        break;
      }

      // Add assistant message to history
      messages.push(message);

      const toolCalls = message.tool_calls;
      if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        // No tool calls requested -> model reached final answer
        finalContent = message.content || '';
        stoppedReason = 'completed';
        break;
      }

      // Model requested tool calls
      for (const tc of toolCalls) {
        if (totalToolsInvoked >= maxTotalTools) {
          this.log.warn(`Max tool invocation limit (${maxTotalTools}) reached`);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: 'Tool execution budget exhausted for this query.' }),
          });
          continue;
        }

        totalToolsInvoked++;
        const toolName = tc.function?.name ?? '';
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          toolArgs = {};
        }

        const tStart = Date.now();
        const toolResult = await this.tools.execute(toolName, toolArgs, ctx, perToolTimeoutMs);
        const tDuration = Date.now() - tStart;

        // Collect source
        if (toolResult.evidenceSource) {
          sourceMap.set(toolResult.evidenceSource.id, toolResult.evidenceSource);
        }

        // Record execution step
        steps.push({
          tool: toolName,
          args: toolArgs,
          durationMs: tDuration,
          success: toolResult.success,
          summary: toolResult.success
            ? `Successfully executed ${toolName}`
            : `Failed ${toolName}: ${toolResult.error}`,
          error: toolResult.error,
          evidenceSource: toolResult.evidenceSource,
        });

        // Feed tool response back into conversation
        const toolResponsePayload = toolResult.success
          ? { success: true, data: toolResult.data, provenance: toolResult.provenance }
          : { success: false, error: toolResult.error, provenance: toolResult.provenance };

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResponsePayload),
        });
      }
    }

    if (stepCount >= maxSteps && !finalContent) {
      stoppedReason = 'max_steps';
      // If we hit max steps without final answer, perform one final prompt asking for summary
      try {
        const finalPrompt = [
          ...messages,
          {
            role: 'user' as const,
            content: 'Please summarize your findings and provide your final research analysis based on all the data gathered above.',
          },
        ];
        const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            messages: finalPrompt,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const j = await res.json();
          finalContent = j.choices?.[0]?.message?.content ?? '';
        }
      } catch {
        finalContent = 'Research data gathered successfully. Please see the structured research cards for details.';
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      finalContent,
      sources: Array.from(sourceMap.values()),
      steps,
      model: this.model,
      durationMs,
      stoppedReason,
    };
  }

  /**
   * Executes multi-step tool-assisted reasoning with genuine token streaming over SSE events.
   */
  async runStream(
    initialMessages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: any[] }[],
    ctx: AgentContext,
    options: OrchestratorOptions = {},
    onEvent: (event: AgentStreamEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const maxSteps = options.maxSteps ?? 6;
    const maxTotalTools = options.maxTotalTools ?? 10;
    const totalTimeoutMs = options.totalTimeoutMs ?? 50_000;
    const perToolTimeoutMs = options.perToolTimeoutMs ?? 12_000;

    const messages = [...initialMessages];
    const steps: ToolExecutionStep[] = [];
    const sourceMap = new Map<string, AskSource>();
    const openAiTools = this.tools.getOpenAiToolDefinitions();

    let stepCount = 0;
    let totalToolsInvoked = 0;
    let finalContent = '';
    let stoppedReason: OrchestrationResult['stoppedReason'] = 'completed';

    while (stepCount < maxSteps) {
      if (signal?.aborted) {
        stoppedReason = 'error';
        break;
      }
      stepCount++;
      const elapsed = Date.now() - startTime;
      if (elapsed >= totalTimeoutMs) {
        stoppedReason = 'timeout';
        this.log.warn(`ToolOrchestrator timed out after ${elapsed}ms`);
        break;
      }

      const remainingTimeout = Math.max(5000, totalTimeoutMs - elapsed);
      const abortTimeout = AbortSignal.timeout(remainingTimeout);
      const combinedSignal = signal ? AbortSignal.any([signal, abortTimeout]) : abortTimeout;

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            stream: true,
            messages,
            tools: openAiTools,
            tool_choice: 'auto',
          }),
          signal: combinedSignal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`AI endpoint HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }
      } catch (err) {
        if (signal?.aborted) {
          stoppedReason = 'error';
          break;
        }
        this.log.warn(`Model request failed during step ${stepCount}: ${(err as Error).message}`);
        stoppedReason = 'error';
        if (!finalContent) {
          finalContent = `I encountered an issue communicating with the AI service: ${(err as Error).message}`;
          await onEvent({ type: 'text_delta', data: { delta: finalContent } });
        }
        break;
      }

      if (!res.body) {
        stoppedReason = 'error';
        break;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      interface ToolCallAccumulator {
        id: string;
        name: string;
        arguments: string;
      }
      const accumulatedToolCalls: ToolCallAccumulator[] = [];
      let stepContent = '';
      let inReportBlock = false;
      let lastEmittedIndex = 0;
      const fence = '```investment_report';

      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            let chunk: any;
            try {
              chunk = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Handle tool call deltas
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!accumulatedToolCalls[idx]) {
                  accumulatedToolCalls[idx] = {
                    id: tc.id || `call_${Date.now()}_${idx}`,
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  };
                } else {
                  if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                  if (tc.function?.name) accumulatedToolCalls[idx].name += tc.function.name;
                  if (tc.function?.arguments) accumulatedToolCalls[idx].arguments += tc.function.arguments;
                }
              }
            }

            // Handle content text delta
            if (typeof delta.content === 'string') {
              stepContent += delta.content;

              if (!inReportBlock) {
                const fenceIndex = stepContent.indexOf(fence);
                if (fenceIndex !== -1) {
                  inReportBlock = true;
                  const textBefore = stepContent.slice(lastEmittedIndex, fenceIndex);
                  if (textBefore) {
                    await onEvent({ type: 'text_delta', data: { delta: textBefore } });
                  }
                  lastEmittedIndex = stepContent.length;
                } else {
                  // Buffer up to safe length so we don't emit a partial fence like "```invest"
                  const safeLength = Math.max(0, stepContent.length - fence.length);
                  if (safeLength > lastEmittedIndex) {
                    const toEmit = stepContent.slice(lastEmittedIndex, safeLength);
                    await onEvent({ type: 'text_delta', data: { delta: toEmit } });
                    lastEmittedIndex = safeLength;
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          stoppedReason = 'error';
          break;
        }
        this.log.warn(`Stream read failed: ${(err as Error).message}`);
      }

      // If stream ended and we never hit the report block, emit any remaining buffered text
      if (!inReportBlock && lastEmittedIndex < stepContent.length) {
        const remaining = stepContent.slice(lastEmittedIndex);
        if (remaining) {
          await onEvent({ type: 'text_delta', data: { delta: remaining } });
          lastEmittedIndex = stepContent.length;
        }
      }

      // Check if tool calls were requested
      if (accumulatedToolCalls.length > 0) {
        // Record assistant turn in messages
        messages.push({
          role: 'assistant',
          content: stepContent || null,
          tool_calls: accumulatedToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // Execute all requested tool calls
        for (const tc of accumulatedToolCalls) {
          if (signal?.aborted) break;

          if (totalToolsInvoked >= maxTotalTools) {
            this.log.warn(`Max tool invocation limit (${maxTotalTools}) reached`);
            const errSummary = 'Tool execution budget exhausted for this query.';
            await onEvent({
              type: 'tool_result',
              data: {
                tool: tc.name,
                success: false,
                durationMs: 0,
                summary: errSummary,
                error: errSummary,
              },
            });
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: errSummary }),
            });
            continue;
          }

          totalToolsInvoked++;
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(tc.arguments || '{}');
          } catch {
            toolArgs = {};
          }

          await onEvent({
            type: 'tool_start',
            data: { tool: tc.name, args: toolArgs, step: stepCount },
          });

          const tStart = Date.now();
          const toolResult = await this.tools.execute(tc.name, toolArgs, ctx, perToolTimeoutMs);
          const tDuration = Date.now() - tStart;

          if (toolResult.evidenceSource) {
            sourceMap.set(toolResult.evidenceSource.id, toolResult.evidenceSource);
          }

          const stepObj: ToolExecutionStep = {
            tool: tc.name,
            args: toolArgs,
            durationMs: tDuration,
            success: toolResult.success,
            summary: toolResult.success
              ? `Successfully executed ${tc.name}`
              : `Failed ${tc.name}: ${toolResult.error}`,
            error: toolResult.error,
            evidenceSource: toolResult.evidenceSource,
          };
          steps.push(stepObj);

          await onEvent({
            type: 'tool_result',
            data: {
              tool: tc.name,
              success: toolResult.success,
              durationMs: tDuration,
              summary: stepObj.summary,
              error: toolResult.error,
              evidenceSource: toolResult.evidenceSource,
            },
          });

          const toolResponsePayload = toolResult.success
            ? { success: true, data: toolResult.data, provenance: toolResult.provenance }
            : { success: false, error: toolResult.error, provenance: toolResult.provenance };

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResponsePayload),
          });
        }
      } else {
        // Model reached final response without requesting more tools
        finalContent = stepContent;
        stoppedReason = 'completed';
        break;
      }
    }

    // Handle max steps fallback
    if (stepCount >= maxSteps && !finalContent && !signal?.aborted) {
      stoppedReason = 'max_steps';
      try {
        const finalPrompt = [
          ...messages,
          {
            role: 'user' as const,
            content: 'Please summarize your findings and provide your final research analysis based on all the data gathered above.',
          },
        ];
        const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            stream: true,
            messages: finalPrompt,
          }),
          signal: AbortSignal.timeout(20_000),
        });

        if (res.ok && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:') && !trimmed.includes('[DONE]')) {
                try {
                  const j = JSON.parse(trimmed.slice(5).trim());
                  const c = j.choices?.[0]?.delta?.content;
                  if (c) {
                    finalContent += c;
                    await onEvent({ type: 'text_delta', data: { delta: c } });
                  }
                } catch {}
              }
            }
          }
        }
      } catch {
        finalContent = 'Research data gathered successfully. Please see the structured research cards for details.';
        await onEvent({ type: 'text_delta', data: { delta: finalContent } });
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      finalContent,
      sources: Array.from(sourceMap.values()),
      steps,
      model: this.model,
      durationMs,
      stoppedReason,
    };
  }
}
