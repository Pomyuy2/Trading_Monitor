import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Lang, NewsItem, Sentiment, SourceDocument } from '@tm/shared';
import type { AiService, SummaryResult } from './ai-service.js';
import { checkSentiment, checkTranslation, guidanceTask, sentimentTask, summaryTask, toSummary, translateTask, type AiTask } from './prompts.js';

/**
 * Claude-backed AI features (server-side only; the key never reaches the browser).
 * Model per spec: claude-sonnet-5-5. Prompts and output shapes live in prompts.ts.
 */
const MODEL = 'claude-sonnet-5-5';

export class AnthropicAi implements AiService {
  readonly name = 'Claude Sonnet 5.5';
  readonly sentimentMethod = 'ai' as const;
  readonly canSummarize = true;
  readonly canExtract = true;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly log: { warn(msg: string): void } = console) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  /** Structured output: the answer is validated against the task's schema. Null when Claude declines. */
  private async run<T>(task: AiTask<T>, what: string): Promise<T | null> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: task.maxTokens,
      output_config: { effort: task.effort, format: zodOutputFormat(task.schema) },
      system: task.system,
      messages: [{ role: 'user', content: task.user }],
    });
    if (response.stop_reason === 'refusal') {
      this.log.warn(`Claude declined ${what} (${response.stop_details?.category ?? 'no category'})`);
      return null;
    }
    return (response.parsed_output as T | null) ?? null;
  }

  async summarizeNews(symbol: string, companyName: string | null, lang: Lang, items: NewsItem[], changePct: number | null): Promise<SummaryResult | null> {
    if (items.length === 0) return null;
    return toSummary(items, await this.run(summaryTask(symbol, companyName, lang, items, changePct), `the news summary for ${symbol}`), this.name);
  }

  async extractGuidance(symbol: string, companyName: string | null, docs: SourceDocument[]): Promise<unknown | null> {
    if (docs.length === 0) return null;
    return this.run(guidanceTask(symbol, companyName, docs), `guidance extraction for ${symbol}`);
  }

  async translate(texts: string[], lang: Lang): Promise<string[]> {
    if (lang === 'en' || texts.every((t) => !t.trim())) return texts;
    return checkTranslation(texts, await this.run(translateTask(texts, lang), 'a translation'));
  }

  async tagSentiment(symbol: string, items: NewsItem[]): Promise<Sentiment[]> {
    if (items.length === 0) return [];
    const out = await this.run(sentimentTask(symbol, items), `sentiment for ${symbol}`);
    if (!out) throw new Error('Claude returned no sentiment labels');
    return checkSentiment(items, out);
  }
}
