import type { AgentStreamEvent, AskSource } from '@tm/shared';
import type { AgentContext, ToolExecutionStep, ToolResult } from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ResearchPlan, ResearchComplexity, ResearchTask } from '../planner/plan-types.js';

export interface AdaptiveExecutionBounds {
  maxSteps: number;
  maxTotalTools: number;
  totalTimeoutMs: number;
  perToolTimeoutMs: number;
}

export function getBoundsForComplexity(complexity: ResearchComplexity): AdaptiveExecutionBounds {
  switch (complexity) {
    case 'simple':
      return {
        maxSteps: 2,
        maxTotalTools: 2,
        totalTimeoutMs: 15_000,
        perToolTimeoutMs: 8_000,
      };
    case 'moderate':
      return {
        maxSteps: 5,
        maxTotalTools: 6,
        totalTimeoutMs: 35_000,
        perToolTimeoutMs: 12_000,
      };
    case 'deep':
    default:
      return {
        maxSteps: 7,
        maxTotalTools: 10,
        totalTimeoutMs: 50_000,
        perToolTimeoutMs: 15_000,
      };
  }
}

export interface AdaptiveExecutionResult {
  finalContent: string;
  sources: AskSource[];
  steps: ToolExecutionStep[];
  model: string;
  durationMs: number;
  stoppedReason: 'completed' | 'max_steps' | 'timeout' | 'error' | 'aborted';
  isPartial: boolean;
  completedTasks: string[];
  incompleteTasks: string[];
  cachedHits: number;
  tokensConsumed: number;
}

function canonicalArgsKey(toolName: string, args: Record<string, unknown>): string {
  const sortedKeys = Object.keys(args).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sortedObj[k] = args[k];
  }
  return `${toolName}:${JSON.stringify(sortedObj)}`;
}

export class AdaptiveExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly log: { info?(msg: string): void; warn(msg: string): void } = console,
  ) {}

  /**
   * Executes adaptive research reasoning with in-request memoization,
   * multi-ticker fair allocation, complexity bounds, and partial-result disclosures.
   */
  async execute(
    initialMessages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: any[] }[],
    ctx: AgentContext,
    plan?: ResearchPlan,
    onEvent?: (event: AgentStreamEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<AdaptiveExecutionResult> {
    const startTime = Date.now();
    const complexity: ResearchComplexity = plan?.complexity ?? 'deep';
    const bounds = getBoundsForComplexity(complexity);

    const messages = [...initialMessages];
    const steps: ToolExecutionStep[] = [];
    const sourceMap = new Map<string, AskSource>();
    const openAiTools = this.tools.getOpenAiToolDefinitions();

    // In-request cache to avoid duplicate tool calls
    const requestCache = new Map<string, ToolResult>();
    let cachedHits = 0;

    // Per-symbol allocation counters for multi-stock requests
    const symbolInvocations = new Map<string, number>();
    const targetCompanies = plan?.targetCompanies ?? [];
    const maxPerCompany =
      targetCompanies.length > 1
        ? Math.max(2, Math.floor(bounds.maxTotalTools / targetCompanies.length))
        : bounds.maxTotalTools;

    // Plan task tracking
    const planTasks: ResearchTask[] = plan ? [...plan.tasks] : [];
    const completedTasks: string[] = [];
    const incompleteTasks: string[] = [];

    let stepCount = 0;
    let totalToolsInvoked = 0;
    let finalContent = '';
    let stoppedReason: AdaptiveExecutionResult['stoppedReason'] = 'completed';
    let isPartial = false;
    let tokensConsumed = 0;

    while (stepCount < bounds.maxSteps) {
      if (signal?.aborted) {
        stoppedReason = 'aborted';
        break;
      }

      stepCount++;
      const elapsed = Date.now() - startTime;
      if (elapsed >= bounds.totalTimeoutMs) {
        stoppedReason = 'timeout';
        isPartial = true;
        this.log.warn(`AdaptiveExecutor timed out after ${elapsed}ms`);
        break;
      }

      const remainingTimeout = Math.max(4000, bounds.totalTimeoutMs - elapsed);
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
            stream: Boolean(onEvent),
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
          stoppedReason = 'aborted';
          break;
        }
        this.log.warn(`Model request failed during step ${stepCount}: ${(err as Error).message}`);
        stoppedReason = 'error';
        isPartial = true;
        if (!finalContent) {
          finalContent = `I encountered an issue communicating with the AI service: ${(err as Error).message}`;
          if (onEvent) await onEvent({ type: 'text_delta', data: { delta: finalContent } });
        }
        break;
      }

      // Handle streaming or non-streaming response
      let stepContent = '';
      interface ToolCallAcc {
        id: string;
        name: string;
        arguments: string;
      }
      const accumulatedToolCalls: ToolCallAcc[] = [];

      if (onEvent && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
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

              // Tool calls
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

              // Text content
              if (typeof delta.content === 'string') {
                stepContent += delta.content;
                tokensConsumed += Math.ceil(delta.content.length / 4);

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
            stoppedReason = 'aborted';
            break;
          }
          this.log.warn(`Stream read failed: ${(err as Error).message}`);
        }

        if (!inReportBlock && lastEmittedIndex < stepContent.length) {
          const remaining = stepContent.slice(lastEmittedIndex);
          if (remaining) {
            await onEvent({ type: 'text_delta', data: { delta: remaining } });
          }
        }
      } else {
        // Non-streaming response
        const json = await res.json();
        const choice = json.choices?.[0];
        const msg = choice?.message;
        stepContent = msg?.content || '';
        tokensConsumed += Math.ceil((stepContent.length + JSON.stringify(messages).length) / 4);

        if (msg?.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            accumulatedToolCalls.push({
              id: tc.id,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '{}',
            });
          }
        }
      }

      // Check if tool calls were requested
      if (accumulatedToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: stepContent || null,
          tool_calls: accumulatedToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const tc of accumulatedToolCalls) {
          if (signal?.aborted) break;

          // Check global tool budget
          if (totalToolsInvoked >= bounds.maxTotalTools) {
            isPartial = true;
            this.log.warn(`Max tool limit (${bounds.maxTotalTools}) reached`);
            const errSummary = 'Tool execution budget exhausted for this research request.';
            if (onEvent) {
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
            }
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: errSummary, partialBudgetReached: true }),
            });
            continue;
          }

          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(tc.arguments || '{}');
          } catch {
            toolArgs = {};
          }

          // Check multi-ticker fair share allocation
          const argSymbol = typeof toolArgs.symbol === 'string' ? toolArgs.symbol.toUpperCase() : undefined;
          if (argSymbol && targetCompanies.length > 1) {
            const currentSymCount = symbolInvocations.get(argSymbol) ?? 0;
            if (currentSymCount >= maxPerCompany) {
              this.log.warn(`Fair allocation cap reached for ${argSymbol} (${currentSymCount}/${maxPerCompany})`);
              const allocErr = `Tool budget for ${argSymbol} reached fair allocation limit (${maxPerCompany}). Please focus on remaining companies: ${targetCompanies.filter((s) => s !== argSymbol).join(', ')}`;
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ error: allocErr, allocationCapReached: true }),
              });
              continue;
            }
          }

          if (onEvent) {
            await onEvent({
              type: 'tool_start',
              data: { tool: tc.name, args: toolArgs, step: stepCount },
            });
          }

          // Check in-request memoization cache
          const cacheKey = canonicalArgsKey(tc.name, toolArgs);
          let toolResult: ToolResult;
          let isCached = false;

          if (requestCache.has(cacheKey)) {
            toolResult = requestCache.get(cacheKey)!;
            isCached = true;
            cachedHits++;
          } else {
            totalToolsInvoked++;
            if (argSymbol) {
              symbolInvocations.set(argSymbol, (symbolInvocations.get(argSymbol) ?? 0) + 1);
            }

            const tStart = Date.now();
            toolResult = await this.tools.execute(tc.name, toolArgs, ctx, bounds.perToolTimeoutMs);
            const tDuration = Date.now() - tStart;

            requestCache.set(cacheKey, toolResult);

            if (toolResult.evidenceSource) {
              sourceMap.set(toolResult.evidenceSource.id, toolResult.evidenceSource);
            }

            const stepObj: ToolExecutionStep = {
              tool: tc.name,
              args: toolArgs,
              durationMs: tDuration,
              success: toolResult.success,
              summary: toolResult.success
                ? `Executed ${tc.name}${argSymbol ? ` for ${argSymbol}` : ''}`
                : `Failed ${tc.name}: ${toolResult.error}`,
              error: toolResult.error,
              evidenceSource: toolResult.evidenceSource,
              data: toolResult.data,
            };
            steps.push(stepObj);

            // Update matching plan task
            if (planTasks.length > 0) {
              const matchedTask = planTasks.find(
                (t) =>
                  t.status === 'pending' &&
                  (t.toolHint === tc.name || (!t.toolHint && t.targetSymbol === argSymbol)),
              );
              if (matchedTask) {
                matchedTask.status = toolResult.success ? 'completed' : 'failed';
                matchedTask.resultSummary = stepObj.summary;
                if (toolResult.success) {
                  completedTasks.push(matchedTask.id);
                }
              }
            }
          }

          if (onEvent) {
            await onEvent({
              type: 'tool_result',
              data: {
                tool: tc.name,
                success: toolResult.success,
                durationMs: isCached ? 0 : steps[steps.length - 1]?.durationMs ?? 0,
                summary: isCached ? `[Cached] Reused ${tc.name} result` : steps[steps.length - 1]?.summary ?? '',
                error: toolResult.error,
                evidenceSource: toolResult.evidenceSource,
              },
            });
          }

          const toolResponsePayload = toolResult.success
            ? { success: true, data: toolResult.data, provenance: toolResult.provenance, cached: isCached }
            : { success: false, error: toolResult.error, provenance: toolResult.provenance, cached: isCached };

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResponsePayload),
          });
        }
      } else {
        // Model reached final response
        finalContent = stepContent;
        stoppedReason = 'completed';
        break;
      }
    }

    // Identify incomplete tasks
    for (const t of planTasks) {
      if (t.status === 'pending' || t.status === 'in_progress') {
        incompleteTasks.push(t.id);
      }
    }

    // Handle max steps fallback
    if (stepCount >= bounds.maxSteps && !finalContent && !signal?.aborted) {
      stoppedReason = 'max_steps';
      isPartial = true;
      try {
        const finalPrompt = [
          ...messages,
          {
            role: 'user' as const,
            content:
              'Summarize your research findings based on all data gathered so far. Note any topics that were only partially covered due to execution bounds.',
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
            stream: Boolean(onEvent),
            messages: finalPrompt,
          }),
          signal: AbortSignal.timeout(18_000),
        });

        if (res.ok && res.body && onEvent) {
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
                    tokensConsumed += Math.ceil(c.length / 4);
                    await onEvent({ type: 'text_delta', data: { delta: c } });
                  }
                } catch {}
              }
            }
          }
        } else if (res.ok) {
          const j = await res.json();
          finalContent = j.choices?.[0]?.message?.content ?? '';
          tokensConsumed += Math.ceil(finalContent.length / 4);
        }
      } catch {
        finalContent = 'Research data gathered. Please see structured cards for partial findings.';
        if (onEvent) await onEvent({ type: 'text_delta', data: { delta: finalContent } });
      }
    }

    // Never report unfinished research as comprehensive: append limitation disclosure if partial
    if (isPartial && finalContent) {
      const incompleteDesc =
        incompleteTasks.length > 0
          ? planTasks
              .filter((t) => incompleteTasks.includes(t.id))
              .map((t) => t.description)
              .join('; ')
          : 'Further in-depth investigations truncated due to execution budget';
      const totalPlanned = planTasks.length > 0 ? planTasks.length : bounds.maxSteps;
      const limitationNotice = `\n\n> ⚠️ **Research Horizon & Budget Limitation**: Due to execution budget constraints, this analysis is based on partial findings. Completed tasks: ${completedTasks.length}/${totalPlanned}. Unfinished investigations: ${incompleteDesc}.`;
      if (!finalContent.includes('Limitation')) {
        finalContent += limitationNotice;
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
      isPartial,
      completedTasks,
      incompleteTasks,
      cachedHits,
      tokensConsumed,
    };
  }
}
