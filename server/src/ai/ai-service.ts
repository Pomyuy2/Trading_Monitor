import type { Lang, NewsItem, Sentiment } from '@tm/shared';

export interface SummaryResult {
  text: string;
  articleCount: number;
  source: string;
}

/** Server-side AI features. Phase 3 adds an Anthropic implementation (claude-sonnet-5-5). */
export interface AiService {
  readonly name: string;
  isAvailable(): boolean;
  summarizeNews(symbol: string, lang: Lang, items: NewsItem[], changePct: number | null): Promise<SummaryResult>;
  tagSentiment(items: NewsItem[]): Promise<Sentiment[]>;
}
