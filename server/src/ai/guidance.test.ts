import type { SourceDocument } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { mdaSection } from '../lib/html-text.js';
import { finalizeGuidance, guidanceTexts, withTexts } from './guidance.js';

const docs: SourceDocument[] = [
  {
    title: 'Earnings press release (Form 8-K, Exhibit 99.1)',
    date: '2026-10-28',
    url: 'https://example.com/ex99.htm',
    text: 'For fiscal year 2027 we expect revenue growth in the low double digits.\nCapital expenditures are expected to be approximately $14 billion.\nOur priorities are AI infrastructure, cloud growth and operating margins.',
  },
];
const meta = { source: 'Test', updatedAt: '2026-11-06T00:00:00Z' };

const draft = {
  revenueGuidance: { value: 'Low double-digit growth', quote: 'we expect revenue growth in the low double digits' },
  epsGuidance: null,
  capexBudget: { value: 'About $14B', quote: 'Capital expenditures are expected to be approximately $14 billion.' },
  rndBudget: { value: 'R&D up 20%', quote: 'We will raise R&D spending by 20%' }, // NOT in the source
  priorities: [{ value: 'AI infrastructure', quote: 'Our priorities are AI infrastructure, cloud growth and operating margins.' }],
  fiscalYear: 2027,
  sourceTitle: 'Earnings press release (Form 8-K, Exhibit 99.1)',
  sourceDate: '2026-10-28',
};

describe('finalizeGuidance', () => {
  it('keeps fields whose quote is in the source', () => {
    const g = finalizeGuidance(draft, docs, meta);
    expect(g.revenueGuidance?.value).toBe('Low double-digit growth');
    expect(g.capexBudget?.value).toBe('About $14B');
    expect(g.fiscalYear).toBe(2027);
  });

  it('drops a field whose quote does not appear in the source (never shows unbacked values)', () => {
    expect(finalizeGuidance(draft, docs, meta).rndBudget).toBeNull();
  });

  it('keeps null fields null', () => {
    expect(finalizeGuidance(draft, docs, meta).epsGuidance).toBeNull();
  });

  it('matches quotes despite case, curly quotes and whitespace differences', () => {
    const d = { ...draft, revenueGuidance: { value: 'x', quote: '“WE EXPECT   revenue growth in the low double digits.”' } };
    expect(finalizeGuidance(d, docs, meta).revenueGuidance).not.toBeNull();
  });

  it('pads priorities to exactly 3 with nulls', () => {
    const g = finalizeGuidance(draft, docs, meta);
    expect(g.priorities).toHaveLength(3);
    expect(g.priorities[0]?.value).toBe('AI infrastructure');
    expect(g.priorities[1]).toBeNull();
    expect(g.priorities[2]).toBeNull();
  });

  it('pins the source title and date to a provided document', () => {
    const g = finalizeGuidance({ ...draft, sourceTitle: 'Something invented', sourceDate: '1999-01-01' }, docs, meta);
    expect(g.sourceTitle).toBe(docs[0].title);
    expect(g.sourceDate).toBe('2026-10-28');
  });

  it('rejects output that does not match the schema', () => {
    expect(() => finalizeGuidance({ ...draft, fiscalYear: 'next year' }, docs, meta)).toThrow();
    expect(() => finalizeGuidance({ ...draft, priorities: [null, null, null, null] }, docs, meta)).toThrow();
    expect(() => finalizeGuidance({ revenueGuidance: { value: 'x' } }, docs, meta)).toThrow();
  });
});

describe('guidance translation helpers', () => {
  it('round-trips display texts in order, leaving quotes untouched', () => {
    const g = finalizeGuidance(draft, docs, meta);
    const texts = guidanceTexts(g);
    expect(texts).toHaveLength(7);
    const th = withTexts(g, texts.map((t) => (t ? `TH:${t}` : '')));
    expect(th.revenueGuidance?.value).toBe('TH:Low double-digit growth');
    expect(th.revenueGuidance?.quote).toBe(g.revenueGuidance?.quote);
    expect(th.priorities[0]?.value).toBe('TH:AI infrastructure');
    expect(th.epsGuidance).toBeNull();
  });
});

describe('mdaSection', () => {
  it('skips the table of contents and cross-references to Item 8', () => {
    const text = [
      'Item 7.\nManagement’s Discussion and Analysis 20',
      'Item 7A.\nQuantitative and Qualitative Disclosures 30',
      'Item 8.\nFinancial Statements 31',
      '... body ...',
      'Item 7. Management’s Discussion and Analysis of Financial Condition',
      'The following discussion should be read with Part II, Item 8 of this Form 10-K.',
      'Revenue grew. We plan to invest in data centers. '.repeat(20),
      'Item 7A. Quantitative and Qualitative Disclosures About Market Risk',
      'Market risk text.',
    ].join('\n');
    const mda = mdaSection(text);
    expect(mda.startsWith('Item 7. Management’s Discussion and Analysis of Financial Condition')).toBe(true);
    expect(mda).toContain('We plan to invest in data centers.');
    expect(mda).not.toContain('Market risk text.');
  });
});
