import type { Lang, NewsItem, Sentiment, SentimentMethod } from '@tm/shared';

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
}
