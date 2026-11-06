import type { Lang, NewsItem, Sentiment } from '@tm/shared';
import { COMPANIES, GENERIC_TOPICS } from '../providers/mock/fixtures.js';
import type { AiService, SummaryResult } from './ai-service.js';
import { keywordSentiment } from './keyword-ai.js';

/** Canned outputs for MockProvider's fake news only (never used on real headlines). Labelled "Mock AI". */
export class MockAi implements AiService {
  readonly name = 'Mock AI';
  readonly sentimentMethod = 'mock' as const;
  readonly canSummarize = true;

  async summarizeNews(symbol: string, _companyName: string | null, lang: Lang, items: NewsItem[], changePct: number | null): Promise<SummaryResult> {
    const c = COMPANIES.find((x) => x.symbol === symbol);
    const topics = c?.summaryTopics ?? GENERIC_TOPICS;
    const name = c?.name ?? symbol;
    const up = (changePct ?? 0) >= 0;
    const text =
      lang === 'th'
        ? `หุ้น ${name} ${up ? 'ปรับตัวขึ้น' : 'ปรับตัวลง'}ในวันนี้ โดยข่าวล่าสุดเน้นไปที่${topics.drivers.th} ความเสี่ยงหลักที่ข่าวกล่าวถึงคือ${topics.risk.th}`
        : `${name} is trading ${up ? 'higher' : 'lower'} today, with recent coverage focused on ${topics.drivers.en}. The main risk flagged in the headlines is ${topics.risk.en}.`;
    return { text, articleCount: items.length, source: this.name };
  }

  async tagSentiment(_symbol: string, items: NewsItem[]): Promise<Sentiment[]> {
    return items.map((i) => i.sentiment ?? keywordSentiment(i.headline));
  }
}
