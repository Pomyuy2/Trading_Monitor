import type { Lang, NewsItem, Sentiment } from '@tm/shared';
import { COMPANIES, GENERIC_TOPICS } from '../providers/mock/fixtures.js';
import type { AiService, SummaryResult } from './ai-service.js';
import { keywordSentiment } from './keyword-ai.js';

/** Canned outputs for MockProvider's fake news only (never used on real headlines). Labelled "Mock AI". */
export class MockAi implements AiService {
  readonly name = 'Mock AI';
  readonly sentimentMethod = 'mock' as const;
  readonly canSummarize = true;
  readonly canExtract = false;

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

  async ask(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const isThai = /[\u0E00-\u0E7F]/.test(lastUser) || messages.some((m) => m.role === 'system' && m.content.includes('Respond in Thai'));
    if (isThai) {
      return (
        '**AAPL** ปรับตัวลดลงในวันนี้ โดยลดลง **$5.47 (-3.14%)** มาอยู่ที่ **$168.89** จากแรงกดดันในกลุ่มเทคโนโลยีและปัจจัยเฉพาะตัว:\n\n' +
        '• **แรงเทขายกลุ่มเทคโนโลยี**: ดัชนี Nasdaq ปรับตัวลงภาพรวมตามอัตราผลตอบแทนพันธบัตร 10 ปีที่สูงขึ้น\n' +
        '• **รายงานห่วงโซ่อุปทาน**: มีรายงานการปรับลดกำลังการผลิต iPhone 16 เล็กน้อยในซัพพลายเออร์หลัก\n' +
        '• **ระดับราคาสำคัญ**: ราคาหลุดแนวรับ Pivot รายวันที่ **$172.50** และกำลังทดสอบแนวรับ **S1 $166.10** โดยมีแนวต้านถัดไปอยู่ที่ **R1 $171.40**\n' +
        '• **เหตุการณ์ที่ต้องจับตา**: กำหนดการรายงานผลประกอบการครั้งถัดไปคือวันที่ **2 พ.ค. 2026**'
      );
    }
    return (
      '**Apple (AAPL)** is trading lower today, down **$5.47 (-3.14%)** at **$168.89**, following broader tech market weakness and a few company-specific headwinds:\n\n' +
      '• **Tech sector pullback**: Nasdaq is broadly down 1.8% today amid rising 10-year Treasury yields.\n' +
      '• **Supply chain reports**: Reports indicate modest production adjustments for iPhone 16 in select Asian manufacturing hubs.\n' +
      '• **Key price levels**: The stock broke below its daily pivot point at **$172.50** and is now testing support at **S1 $166.10**. The next major resistance sits at **R1 $171.40**.\n' +
      '• **Upcoming catalysts**: Next earnings report is scheduled for **May 2, 2026**.'
    );
  }
}
