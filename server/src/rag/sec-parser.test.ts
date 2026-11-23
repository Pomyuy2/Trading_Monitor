import { describe, it, expect } from 'vitest';
import { parseSecSections, cleanSecHtml } from './sec-parser.js';

describe('SEC Parser', () => {
  it('cleans HTML and strips inline tags while preserving paragraphs', () => {
    const html = `
      <html>
        <body>
          <h1>Item 1. Business</h1>
          <p>We are a global leader in AI hardware and software systems.</p>
          <div>Revenue increased by 100%.</div>
        </body>
      </html>
    `;
    const text = cleanSecHtml(html);
    expect(text).toContain('Item 1. Business');
    expect(text).toContain('We are a global leader');
    expect(text).toContain('Revenue increased by 100%.');
  });

  it('correctly segments 10-K sections by standard Item headers', () => {
    const documentText = `
Cover page information...
Table of contents:
Item 1.
Item 1A.
Item 7.

Item 1. Business
NVIDIA designs graphics processing units and data center accelerators.

Item 1A. Risk Factors
We face intense competition and supply chain risks in advanced semiconductor packaging.

Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations
Total revenue for fiscal year 2025 grew rapidly driven by strong compute demand.

Item 8. Financial Statements and Supplementary Data
Consolidated balance sheets and statements of operations.
    `.trim();

    const sections = parseSecSections(documentText, '10-K');
    expect(sections.length).toBeGreaterThanOrEqual(4);

    const secCodes = sections.map((s) => s.sectionCode);
    expect(secCodes).toContain('ITEM_1');
    expect(secCodes).toContain('ITEM_1A');
    expect(secCodes).toContain('ITEM_7');
    expect(secCodes).toContain('ITEM_8');

    const item1 = sections.find((s) => s.sectionCode === 'ITEM_1');
    expect(item1?.content).toContain('NVIDIA designs graphics processing units');
    expect(item1?.content).not.toContain('We face intense competition');

    const item1a = sections.find((s) => s.sectionCode === 'ITEM_1A');
    expect(item1a?.content).toContain('We face intense competition and supply chain risks');
  });

  it('correctly segments 10-Q sections distinguishing Part I and Part II', () => {
    const documentText = `
Cover page disclosures...

Part I. Financial Information

Item 1. Financial Statements (Unaudited)
Condensed consolidated balance sheets as of period end.

Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations
Revenue for the quarterly period grew 15% sequentially.

Part II. Other Information

Item 1. Legal Proceedings
There are no material pending legal proceedings.

Item 1A. Risk Factors
There have been no material changes from the risk factors disclosed in Form 10-K.
    `.trim();

    const sections = parseSecSections(documentText, '10-Q');
    const secCodes = sections.map((s) => s.sectionCode);

    expect(secCodes).toContain('PART_I_ITEM_1');
    expect(secCodes).toContain('PART_I_ITEM_2');
    expect(secCodes).toContain('PART_II_ITEM_1');
    expect(secCodes).toContain('PART_II_ITEM_1A');

    const qMda = sections.find((s) => s.sectionCode === 'PART_I_ITEM_2');
    expect(qMda?.content).toContain('Revenue for the quarterly period grew 15%');
  });
});
