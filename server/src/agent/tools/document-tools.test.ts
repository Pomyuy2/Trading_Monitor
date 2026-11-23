import { describe, it, expect } from 'vitest';
import { searchFinancialDocumentsTool, getDocumentSectionTool } from './document-tools.js';

describe('Document Agent Tools', () => {
  it('search_financial_documents wraps content with UNTRUSTED delimiters and evidenceSource', async () => {
    const mockCtx = {} as any;
    const result = await searchFinancialDocumentsTool.execute(
      {
        symbol: 'NVDA',
        query: 'Blackwell architecture',
        limit: 2,
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const data = result.data as any;
    expect(data.chunks.length).toBeGreaterThan(0);
    expect(data.chunks[0].content).toContain('<<<UNTRUSTED_FINANCIAL_DOCUMENT_START');
    expect(data.chunks[0].content).toContain('<<<UNTRUSTED_FINANCIAL_DOCUMENT_END>>>');
    expect(result.evidenceSource?.type).toBe('guidance');
    expect(result.evidenceSource?.id).toMatch(/^SEC-NVDA-/);
  });

  it('search_financial_documents strictly enforces historical endDate cutoff', async () => {
    const mockCtx = {} as any;
    const cutoff = '2024-02-28';
    const result = await searchFinancialDocumentsTool.execute(
      {
        symbol: 'NVDA',
        query: 'revenue',
        endDate: cutoff,
        limit: 5,
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.chunks.length).toBeGreaterThan(0);
    for (const chunk of data.chunks) {
      expect(chunk.filingDate <= cutoff).toBe(true);
    }
  });

  it('get_document_section returns section content with pagination offset', async () => {
    const mockCtx = {} as any;
    const result = await getDocumentSectionTool.execute(
      {
        symbol: 'NVDA',
        sectionCode: 'ITEM_1',
        limit: 1000,
      },
      mockCtx,
    );

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.found).not.toBe(false);
    expect(data.sectionCode).toBe('ITEM_1');
    expect(data.content).toContain('<<<UNTRUSTED_FINANCIAL_DOCUMENT_START');
    expect(data.citationId).toMatch(/^SEC-NVDA-/);
  });
});
