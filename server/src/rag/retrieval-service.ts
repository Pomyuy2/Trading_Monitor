import { db } from '../store/db.js';
import { coverageService } from './coverage-service.js';
import { jobCoordinator } from './job-coordinator.js';

export interface SearchOptions {
  query: string;
  symbol: string;
  form?: string | string[]; // '10-K' | '10-Q' | '8-K'
  sectionCode?: string | string[];
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD (historical cutoff - strictly no lookahead)
  limit?: number; // default 5, max 20
  autoIngest?: boolean; // default true
}

export interface RetrievalChunk {
  id: string; // citation ID: SEC-NVDA-10-K-2026-02-25-ITEM_1-c3
  documentId: string;
  symbol: string;
  form: string;
  filingDate: string;
  reportDate: string | null;
  sectionCode: string;
  sectionTitle: string;
  chunkIndex: number;
  tokenCount: number;
  content: string;
  score: number; // BM25 relevance score (higher is better)
  snippet: string;
}

export interface GetSectionOptions {
  symbol: string;
  form?: string; // '10-K' | '10-Q' | '8-K'
  sectionCode: string; // 'ITEM_1', 'ITEM_1A', 'ITEM_7', 'ITEM_8', etc.
  filingDate?: string; // exact filing date
  asOfDate?: string; // latest filing date on or before asOfDate
  offsetChars?: number;
  limitChars?: number;
  autoIngest?: boolean; // default true
}

export interface GetSectionResult {
  sectionId: string;
  documentId: string;
  symbol: string;
  form: string;
  filingDate: string;
  reportDate: string | null;
  sectionCode: string;
  sectionTitle: string;
  totalLength: number;
  offsetChars: number;
  content: string;
  hasMore: boolean;
  citationId: string;
}

const STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'in', 'is', 'it',
  'its', 'me', 'much', 'of', 'on', 'or', 'tell', 'that', 'the', 'their',
  'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'would',
]);

export function sanitizeFts5Query(raw: string): { andQuery: string; orQuery: string } {
  // Extract quoted exact phrases: "data center revenue"
  const phrases: string[] = [];
  let withoutPhrases = raw.replace(/"([^"]+)"/g, (_, phrase) => {
    const cleanPhrase = phrase.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanPhrase) {
      phrases.push(`"${cleanPhrase}"`);
    }
    return ' ';
  });

  // Strip punctuation, quotes, symbols that cause FTS5 syntax errors
  const cleanTokens = withoutPhrases
    .replace(/['’`]/g, '') // remove apostrophes without adding space (e.g. NVIDIA's -> NVIDIAs)
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

  const allTokens = [...phrases, ...cleanTokens];
  if (allTokens.length === 0) {
    const fallback = raw.replace(/[^a-zA-Z0-9]/g, ' ').trim();
    return { andQuery: fallback, orQuery: fallback };
  }

  const andQuery = allTokens.join(' ');
  const orQuery = allTokens.join(' OR ');

  return { andQuery, orQuery };
}

export class DocumentRetrievalService {
  /**
   * Search chunks using SQLite FTS5 BM25 with metadata filtering.
   */
  async search(options: SearchOptions): Promise<RetrievalChunk[]> {
    const symbol = options.symbol.toUpperCase();
    const limit = Math.max(1, Math.min(20, options.limit ?? 5));
    const autoIngest = options.autoIngest ?? true;

    if (autoIngest) {
      try {
        const coverage = await coverageService.checkCoverage(symbol, {
          form: typeof options.form === 'string' ? options.form : undefined,
          endDate: options.endDate,
        });

        if (coverage.status === 'MISSING' || coverage.status === 'STALE') {
          const jobPromise = jobCoordinator.enqueueOrJoin(symbol, {
            form: typeof options.form === 'string' ? options.form : undefined,
            endDate: options.endDate,
          });
          await jobCoordinator.waitForJob(jobPromise, 12_000);
        }
      } catch (err: any) {
        console.warn(`[DocumentRetrievalService] Auto-ingest check warning for ${symbol}: ${err.message}`);
      }
    }

    const { andQuery, orQuery } = sanitizeFts5Query(options.query);

    if (!andQuery) return [];

    const forms = options.form
      ? Array.isArray(options.form) ? options.form : [options.form]
      : [];
    const sectionCodes = options.sectionCode
      ? Array.isArray(options.sectionCode) ? options.sectionCode : [options.sectionCode]
      : [];

    // Helper to execute query with parameters
    const executeFtsQuery = async (ftsMatchQuery: string): Promise<any[]> => {
      let whereClauses: string[] = [
        'DocumentChunkFts MATCH ?',
        'c.symbol = ?',
      ];
      const params: any[] = [ftsMatchQuery, symbol];

      if (options.endDate) {
        whereClauses.push('c.filingDateStr <= ?');
        params.push(options.endDate);
      }

      if (options.startDate) {
        whereClauses.push('c.filingDateStr >= ?');
        params.push(options.startDate);
      }

      if (forms.length > 0) {
        const placeholders = forms.map(() => '?').join(', ');
        whereClauses.push(`c.form IN (${placeholders})`);
        params.push(...forms);
      }

      if (sectionCodes.length > 0) {
        const placeholders = sectionCodes.map(() => '?').join(', ');
        whereClauses.push(`c.sectionCode IN (${placeholders})`);
        params.push(...sectionCodes);
      }

      const sql = `
        SELECT
          c.id,
          c.documentId,
          c.symbol,
          c.form,
          c.filingDateStr,
          c.reportDateStr,
          c.sectionCode,
          c.sectionTitle,
          c.chunkIndex,
          c.tokenCount,
          c.content,
          bm25(DocumentChunkFts) as rank,
          snippet(DocumentChunkFts, 6, '<b>', '</b>', '...', 24) as snippet
        FROM DocumentChunk c
        JOIN DocumentChunkFts ON c.id = DocumentChunkFts.id
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY rank ASC
        LIMIT ?
      `;
      params.push(limit);

      return db.$queryRawUnsafe(sql, ...params);
    };

    // First try strict AND query
    let rows: any[] = [];
    try {
      rows = await executeFtsQuery(andQuery);
    } catch (err: any) {
      console.warn(`[DocumentRetrievalService] AND query failed, retrying OR: ${err.message}`);
    }

    // If AND query returned 0 results, fall back to OR query
    if (rows.length === 0 && orQuery !== andQuery) {
      try {
        rows = await executeFtsQuery(orQuery);
      } catch (err: any) {
        console.warn(`[DocumentRetrievalService] OR query failed: ${err.message}`);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      symbol: r.symbol,
      form: r.form,
      filingDate: r.filingDateStr,
      reportDate: r.reportDateStr,
      sectionCode: r.sectionCode,
      sectionTitle: r.sectionTitle,
      chunkIndex: Number(r.chunkIndex),
      tokenCount: Number(r.tokenCount),
      content: r.content,
      // SQLite BM25 returns negative values where lower is better; invert for positive score
      score: Math.round((-Number(r.rank)) * 100) / 100,
      snippet: r.snippet ?? '',
    }));
  }

  /**
   * Retrieve full section content or large contiguous window by sectionCode.
   */
  async getSection(options: GetSectionOptions): Promise<GetSectionResult | null> {
    const symbol = options.symbol.toUpperCase();
    const sectionCode = options.sectionCode.toUpperCase();
    const offset = Math.max(0, options.offsetChars ?? 0);
    const limit = Math.max(500, Math.min(12000, options.limitChars ?? 8000));
    const autoIngest = options.autoIngest ?? true;

    if (autoIngest) {
      try {
        const coverage = await coverageService.checkCoverage(symbol, {
          form: options.form,
          endDate: options.asOfDate ?? options.filingDate,
        });

        if (coverage.status === 'MISSING' || coverage.status === 'STALE') {
          const jobPromise = jobCoordinator.enqueueOrJoin(symbol, {
            form: options.form,
            endDate: options.asOfDate ?? options.filingDate,
          });
          await jobCoordinator.waitForJob(jobPromise, 12_000);
        }
      } catch (err: any) {
        console.warn(`[DocumentRetrievalService] Auto-ingest check warning for ${symbol}: ${err.message}`);
      }
    }

    // Find the matching document first
    const docWhere: any = { symbol };
    if (options.form) {
      docWhere.form = options.form;
    }
    if (options.filingDate) {
      docWhere.filingDateStr = options.filingDate;
    } else if (options.asOfDate) {
      docWhere.filingDateStr = { lte: options.asOfDate };
    }

    const doc = await db.financialDocument.findFirst({
      where: docWhere,
      orderBy: { filingDateStr: 'desc' },
      include: {
        sections: {
          where: { sectionCode },
        },
      },
    });

    if (!doc || doc.sections.length === 0) {
      // Try finding by partial sectionCode if exact match not found (e.g. ITEM_7 matching PART_I_ITEM_2)
      const fallbackSection = await db.documentSection.findFirst({
        where: {
          document: docWhere,
          OR: [
            { sectionCode: { contains: sectionCode } },
            { sectionTitle: { contains: sectionCode } },
          ],
        },
        include: { document: true },
      });

      if (!fallbackSection) return null;

      const fullText = fallbackSection.content;
      const slice = fullText.slice(offset, offset + limit);
      const citationId = `SEC-${fallbackSection.document.symbol}-${fallbackSection.document.form}-${fallbackSection.document.filingDateStr}-${fallbackSection.sectionCode}`;

      return {
        sectionId: fallbackSection.id,
        documentId: fallbackSection.documentId,
        symbol: fallbackSection.document.symbol,
        form: fallbackSection.document.form,
        filingDate: fallbackSection.document.filingDateStr,
        reportDate: fallbackSection.document.reportDateStr,
        sectionCode: fallbackSection.sectionCode,
        sectionTitle: fallbackSection.sectionTitle,
        totalLength: fullText.length,
        offsetChars: offset,
        content: slice,
        hasMore: offset + limit < fullText.length,
        citationId,
      };
    }

    const sec = doc.sections[0];
    const fullText = sec.content;
    const slice = fullText.slice(offset, offset + limit);
    const citationId = `SEC-${doc.symbol}-${doc.form}-${doc.filingDateStr}-${sec.sectionCode}`;

    return {
      sectionId: sec.id,
      documentId: doc.id,
      symbol: doc.symbol,
      form: doc.form,
      filingDate: doc.filingDateStr,
      reportDate: doc.reportDateStr,
      sectionCode: sec.sectionCode,
      sectionTitle: sec.sectionTitle,
      totalLength: fullText.length,
      offsetChars: offset,
      content: slice,
      hasMore: offset + limit < fullText.length,
      citationId,
    };
  }
}

export const retrievalService = new DocumentRetrievalService();
