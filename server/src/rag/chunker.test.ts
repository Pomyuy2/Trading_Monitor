import { describe, it, expect } from 'vitest';
import { chunkSection } from './chunker.js';

describe('Document Chunker', () => {
  it('creates stable citation IDs matching SEC-{TICKER}-{FORM}-{DATE}-{SECTION}-c{N}', () => {
    const text = 'Short section content that fits in one chunk.';
    const chunks = chunkSection({
      documentId: 'sec-NVDA-10-K-2026-02-25',
      sectionId: 'sec-NVDA-10-K-2026-02-25-ITEM_7',
      symbol: 'NVDA',
      form: '10-K',
      filingDate: new Date('2026-02-25'),
      filingDateStr: '2026-02-25',
      sectionCode: 'ITEM_7',
      sectionTitle: 'Item 7. Management Discussion and Analysis',
      content: text,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('SEC-NVDA-10-K-2026-02-25-ITEM_7-c1');
    expect(chunks[0].chunkIndex).toBe(1);
    expect(chunks[0].symbol).toBe('NVDA');
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
    expect(chunks[0].content).toBe(text);
  });

  it('splits long content across multiple chunks with overlap and incremental numbering', () => {
    const paragraph1 = 'A'.repeat(1500) + ' First paragraph ending here.';
    const paragraph2 = 'B'.repeat(1500) + ' Second paragraph ending here.';
    const paragraph3 = 'C'.repeat(1500) + ' Third paragraph ending here.';
    const fullText = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

    const chunks = chunkSection(
      {
        documentId: 'sec-AAPL-10-K-2026-11-03',
        sectionId: 'sec-AAPL-10-K-2026-11-03-ITEM_1A',
        symbol: 'AAPL',
        form: '10-K',
        filingDate: new Date('2026-11-03'),
        filingDateStr: '2026-11-03',
        sectionCode: 'ITEM_1A',
        sectionTitle: 'Item 1A. Risk Factors',
        content: fullText,
      },
      {
        targetChunkChars: 1800,
        maxChunkChars: 2500,
        overlapChars: 200,
      },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].id).toBe('SEC-AAPL-10-K-2026-11-03-ITEM_1A-c1');
    expect(chunks[1].id).toBe('SEC-AAPL-10-K-2026-11-03-ITEM_1A-c2');
    expect(chunks[0].chunkIndex).toBe(1);
    expect(chunks[1].chunkIndex).toBe(2);
  });
});
