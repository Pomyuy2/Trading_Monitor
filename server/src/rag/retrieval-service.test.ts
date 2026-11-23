import { describe, it, expect } from 'vitest';
import { sanitizeFts5Query, retrievalService } from './retrieval-service.js';

describe('Document Retrieval Service', () => {
  describe('sanitizeFts5Query', () => {
    it('strips dangerous FTS5 punctuation and extracts stop words', () => {
      const raw = "What were NVIDIA's Data Center revenue figures in fiscal 2025?";
      const { andQuery, orQuery } = sanitizeFts5Query(raw);
      expect(andQuery).not.toContain("'");
      expect(andQuery).not.toContain('?');
      expect(andQuery).toContain('nvidias');
      expect(andQuery).toContain('data');
      expect(andQuery).toContain('center');
      expect(andQuery).toContain('revenue');
      expect(orQuery).toContain(' OR ');
    });

    it('preserves exact quoted phrases', () => {
      const raw = '"Blackwell architecture" and "liquid cooled" rack design';
      const { andQuery } = sanitizeFts5Query(raw);
      expect(andQuery).toContain('"Blackwell architecture"');
      expect(andQuery).toContain('"liquid cooled"');
    });
  });

  describe('Database Retrieval', () => {
    it('finds ingested chunks matching Blackwell for NVDA', async () => {
      const results = await retrievalService.search({
        symbol: 'NVDA',
        query: 'Blackwell architecture',
        limit: 3,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].symbol).toBe('NVDA');
      expect(results[0].id).toMatch(/^SEC-NVDA-/);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('strictly respects endDate historical cutoff filtering without lookahead', async () => {
      // NVDA filings: 2024-02-21, 2025-02-26, 2026-02-25
      const cutoff = '2024-02-28';
      const results = await retrievalService.search({
        symbol: 'NVDA',
        query: 'revenue',
        endDate: cutoff,
        limit: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.filingDate <= cutoff).toBe(true);
      }
    });

    it('retrieves full section with getSection', async () => {
      const section = await retrievalService.getSection({
        symbol: 'NVDA',
        sectionCode: 'ITEM_1',
        limitChars: 1000,
      });

      expect(section).not.toBeNull();
      expect(section?.symbol).toBe('NVDA');
      expect(section?.sectionCode).toBe('ITEM_1');
      expect(section?.content.length).toBeGreaterThan(100);
      expect(section?.citationId).toMatch(/^SEC-NVDA-/);
    });
  });
});
