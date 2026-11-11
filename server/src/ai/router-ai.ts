import type { Lang, NewsItem, Sentiment, SourceDocument } from '@tm/shared';
import { z } from 'zod/v4';
import { RateLimitError } from '../providers/types.js';
import type { AiService, SummaryResult } from './ai-service.js';
import { checkSentiment, checkTranslation, guidanceTask, sentimentTask, summaryTask, toSummary, translateTask, type AiTask } from './prompts.js';

/**
 * AI features through an OpenAI-compatible endpoint (e.g. a model router: AI_BASE_URL + AI_API_KEY +
 * AI_MODEL). Such endpoints don't enforce a JSON schema, so the schema goes in the instructions and
 * the answer is parsed and validated here (one retry on a malformed answer). Server-side only.
 */
export class RouterAi implements AiService {
  readonly name: string;
  readonly sentimentMethod = 'ai' as const;
  readonly canSummarize = true;
  readonly canExtract = true;
  private readonly url: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly log: { warn(msg: string): void } = console,
  ) {
    const base = baseUrl.replace(/\/+$/, '');
    this.url = `${base}/chat/completions`;
    let host = base;
    try {
      host = new URL(base).host;
    } catch {
      /* keep as given */
    }
    this.name = `${model} · ${host}`;
  }

  /** Ask for the task's JSON; returns the validated object, or null if the model gave nothing usable. */
  private async run<T>(task: AiTask<T>, what: string, timeoutMs = 90_000): Promise<T | null> {
    const schema = JSON.stringify(z.toJSONSchema(task.schema));
    const system =
      `${task.system}\n\nAnswer with exactly one JSON object and nothing else (no markdown, no explanation). ` +
      `It must match this JSON Schema:\n${schema}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.complete(system, task.user, task.maxTokens, timeoutMs);
        if (!text.trim()) {
          this.log.warn(`${this.name} returned an empty answer for ${what}`);
          return null;
        }
        return task.schema.parse(extractJson(text));
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        lastError = err;
      }
    }
    throw new Error(`${this.name}: no usable answer for ${what} (${(lastError as Error)?.message ?? 'unknown'})`);
  }

  /** One chat completion. Handles both a plain JSON reply and a streamed (SSE) reply. */
  private async complete(system: string, user: string, maxTokens: number, timeoutMs: number): Promise<string> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`AI request failed: ${(err as Error).name}`); // never echo the key or URL
    }
    if (res.status === 429) throw new RateLimitError(this.name, Number(res.headers.get('retry-after')) * 1000 || undefined);
    if (!res.ok) throw new Error(`AI endpoint HTTP ${res.status}`);
    return readCompletion(await res.text());
  }

  async summarizeNews(symbol: string, companyName: string | null, lang: Lang, items: NewsItem[], changePct: number | null): Promise<SummaryResult | null> {
    if (items.length === 0) return null;
    return toSummary(items, await this.run(summaryTask(symbol, companyName, lang, items, changePct), `the news summary for ${symbol}`), this.name);
  }

  async extractGuidance(symbol: string, companyName: string | null, docs: SourceDocument[]): Promise<unknown | null> {
    if (docs.length === 0) return null;
    return this.run(guidanceTask(symbol, companyName, docs), `guidance extraction for ${symbol}`, 180_000);
  }

  async translate(texts: string[], lang: Lang): Promise<string[]> {
    if (lang === 'en' || texts.every((t) => !t.trim())) return texts;
    return checkTranslation(texts, await this.run(translateTask(texts, lang), 'a translation'));
  }

  async tagSentiment(symbol: string, items: NewsItem[]): Promise<Sentiment[]> {
    if (items.length === 0) return [];
    const out = await this.run(sentimentTask(symbol, items), `sentiment for ${symbol}`);
    if (!out) throw new Error(`${this.name} returned no sentiment labels`);
    return checkSentiment(items, out);
  }
}

/** The assistant text of a chat completion: either a JSON body or `data:` lines of a stream. */
export function readCompletion(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed) as { choices?: { message?: { content?: string | null } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  }
  let out = '';
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[]; error?: { message?: string } };
      if (chunk.error) throw new Error(`AI endpoint error: ${chunk.error.message ?? 'unknown'}`);
      out += chunk.choices?.[0]?.delta?.content ?? '';
    } catch (err) {
      if (err instanceof SyntaxError) continue; // keep-alive or partial line
      throw err;
    }
  }
  return out;
}

/** Pull the JSON object out of a reply that may be wrapped in a code fence or a sentence. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = fenced ? fenced[1] : text;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in the answer');
  return JSON.parse(s.slice(start, end + 1));
}
