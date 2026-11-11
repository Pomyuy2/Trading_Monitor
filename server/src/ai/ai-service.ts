import type { Lang, NewsItem, Sentiment, SentimentMethod, SourceDocument } from '@tm/shared';

export interface SummaryResult {
  text: string;
  articleCount: number;
  source: string;
}

/**
 * Server-side AI features. Implementations:
 * - AnthropicAi: Claude (needs ANTHROPIC_API_KEY)
 * - KeywordAi:   no AI — keyword-rule sentiment, no summaries
 * - MockAi:      canned outputs for MockProvider's fake news
 */
export interface AiService {
  readonly name: string;
  readonly sentimentMethod: SentimentMethod;
  /** Whether this service can write news summaries at all. */
  readonly canSummarize: boolean;
  /** Returns null when the model declined or produced nothing usable. */
  summarizeNews(symbol: string, companyName: string | null, lang: Lang, items: NewsItem[], changePct: number | null): Promise<SummaryResult | null>;
  /** One label per input item, same order. */
  tagSentiment(symbol: string, items: NewsItem[]): Promise<Sentiment[]>;

  /** Whether this service can extract guidance and translate (needs a real model). */
  readonly canExtract: boolean;
  /** Raw draft (validated + quote-checked by finalizeGuidance), or null if the model declined. */
  extractGuidance?(symbol: string, companyName: string | null, docs: SourceDocument[]): Promise<unknown | null>;
  /** Translate display strings; same count and order. Empty strings stay empty. */
  translate?(texts: string[], lang: Lang): Promise<string[]>;

  /** Conversational Q&A grounded in stock data. */
  ask?(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string>;
}
