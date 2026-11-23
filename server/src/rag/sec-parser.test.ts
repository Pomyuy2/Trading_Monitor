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

  it('correctly segments Form 8-K current reports with Item 2.02 and Item 7.01', () => {
    const documentText = `
UNITED STATES SECURITIES AND EXCHANGE COMMISSION
Washington, D.C. 20549
FORM 8-K
CURRENT REPORT

Item 2.02 Results of Operations and Financial Condition
On May 22, 2024, NVIDIA Corporation issued a press release announcing its financial results for the first quarter of fiscal 2025.
Revenue for the quarter was $26.0 billion, up 262% from a year ago.

Item 7.01 Regulation FD Disclosure
NVIDIA management will host a conference call discussing first quarter financial performance and future expectations.

Item 9.01 Financial Statements and Exhibits
(d) Exhibits: Press Release dated May 22, 2024.
    `.trim();

    const sections = parseSecSections(documentText, '8-K');
    expect(sections.length).toBeGreaterThanOrEqual(3);

    const secCodes = sections.map((s) => s.sectionCode);
    expect(secCodes).toContain('ITEM_2.02');
    expect(secCodes).toContain('ITEM_7.01');
    expect(secCodes).toContain('ITEM_9.01');

    const item202 = sections.find((s) => s.sectionCode === 'ITEM_2.02');
    expect(item202?.content).toContain('Revenue for the quarter was $26.0 billion');
    expect(item202?.content).not.toContain('Regulation FD Disclosure');
  });
});
