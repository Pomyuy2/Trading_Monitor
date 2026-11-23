import { z } from 'zod/v4';
import type { ToolDefinition, ToolResult } from '../types.js';
import { retrievalService } from '../../rag/retrieval-service.js';
import { coverageService } from '../../rag/coverage-service.js';
import { jobCoordinator } from '../../rag/job-coordinator.js';

function cleanSymbol(sym: string): string {
  return sym.trim().toUpperCase();
}

/**
 * 1. search_financial_documents
 * Full-text BM25 search over SEC 10-K and 10-Q filings with section-level citations and cutoff date filtering.
 */
export const searchFinancialDocumentsTool: ToolDefinition<{
  query: string;
  symbol: string;
  form?: '10-K' | '10-Q' | 'all';
  section?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}> = {
  name: 'search_financial_documents',
  description:
    'Search official SEC financial filings (10-K annual reports and 10-Q quarterly reports) for business disclosures, management commentary (MD&A), risk factors, accounting footnotes, and financial disclosures. Supports strict historical date cutoff filtering (endDate) to prevent lookahead bias.',
  parameters: z.object({
    query: z
      .string()
      .min(2)
      .max(300)
      .describe('Financial search keywords or concept phrase, e.g. "Data Center revenue", "Blackwell architecture", "gross margin guidance", "customer concentration"'),
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol, e.g. NVDA, AAPL, MSFT'),
    form: z.enum(['10-K', '10-Q', 'all']).optional().describe('Filter by filing form type: 10-K (annual), 10-Q (quarterly), or all'),
    section: z
      .string()
      .optional()
      .describe('Optional section filter, e.g. ITEM_1 (Business), ITEM_1A (Risk Factors), ITEM_7 (MD&A), ITEM_8 (Financials), PART_I_ITEM_2 (10-Q MD&A)'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional().describe('Exclude filings accepted before this date (YYYY-MM-DD)'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
      .optional()
      .describe('CRITICAL for historical questions: strictly exclude filings accepted after this date (YYYY-MM-DD) to prevent lookahead bias'),
    limit: z.number().int().min(1).max(10).optional().describe('Maximum number of relevant chunks to return (default: 5)'),
  }),
  async execute(args, _ctx): Promise<ToolResult> {
    const sym = cleanSymbol(args.symbol);
    const formFilter = args.form === 'all' || !args.form ? undefined : args.form;

    try {
      const chunks = await retrievalService.search({
        symbol: sym,
        query: args.query,
        form: formFilter,
        sectionCode: args.section,
        startDate: args.startDate,
        endDate: args.endDate,
        limit: args.limit ?? 5,
      });

      if (chunks.length === 0) {
        return {
          success: true,
          data: {
            symbol: sym,
            query: args.query,
            totalFound: 0,
            chunks: [],
            message: `No matching financial filing disclosures found for ${sym} matching "${args.query}"${args.endDate ? ` with cutoff on or before ${args.endDate}` : ''}.`,
          },
          provenance: {
            source: 'SEC EDGAR (FTS5 BM25 Index)',
            updatedAt: new Date().toISOString(),
          },
        };
      }

      // Format chunks safely with untrusted document boundaries
      const formattedChunks = chunks.map((c) => ({
        citationId: c.id,
        form: c.form,
        filingDate: c.filingDate,
        reportDate: c.reportDate,
        sectionCode: c.sectionCode,
        sectionTitle: c.sectionTitle,
        relevanceScore: c.score,
        snippet: c.snippet,
        content: `<<<UNTRUSTED_FINANCIAL_DOCUMENT_START citationId="${c.id}" form="${c.form}" filingDate="${c.filingDate}" section="${c.sectionCode}">>>\n${c.content}\n<<<UNTRUSTED_FINANCIAL_DOCUMENT_END>>>`,
      }));

      const topChunk = chunks[0];

      return {
        success: true,
        data: {
          symbol: sym,
          query: args.query,
          totalFound: chunks.length,
          chunks: formattedChunks,
          citationInstructions:
            'When citing facts or numbers from these documents, you MUST use the exact citation format [SEC-{TICKER}-{FORM}-{DATE}-{SECTION}-c{N}] corresponding to the citationId.',
        },
        provenance: {
          source: 'SEC EDGAR (FTS5 BM25 Index)',
          updatedAt: new Date().toISOString(),
        },
        evidenceSource: {
          id: topChunk.id,
          label: `${sym} ${topChunk.form} (${topChunk.filingDate}) ${topChunk.sectionCode}`,
          type: 'guidance',
          symbol: sym,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to search financial documents: ${err.message}`,
        provenance: {
          source: 'SEC EDGAR (FTS5 BM25 Index)',
          updatedAt: new Date().toISOString(),
          warnings: [err.message],
        },
      };
    }
  },
};

/**
 * 2. get_document_section
 * Retrieves a complete or windowed logical section from an official SEC filing.
 */
export const getDocumentSectionTool: ToolDefinition<{
  symbol: string;
  form?: '10-K' | '10-Q';
  sectionCode: string;
  filingDate?: string;
  asOfDate?: string;
  offset?: number;
  limit?: number;
}> = {
  name: 'get_document_section',
  description:
    'Retrieve an entire logical section from an official SEC filing (e.g. Item 1A Risk Factors, Item 7 MD&A, Item 8 Financial Statements, or Part I Item 2) by ticker and section code. Supports asOfDate for time-aware historical queries.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol, e.g. NVDA, AAPL, MSFT'),
    form: z.enum(['10-K', '10-Q']).optional().describe('Form type: 10-K (annual) or 10-Q (quarterly)'),
    sectionCode: z
      .string()
      .min(2)
      .max(40)
      .describe('Section code, e.g. ITEM_1 (Business), ITEM_1A (Risk Factors), ITEM_1C (Cybersecurity), ITEM_7 (MD&A), ITEM_8 (Financials), PART_I_ITEM_2 (10-Q MD&A)'),
    filingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional().describe('Exact filing date (YYYY-MM-DD)'),
    asOfDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
      .optional()
      .describe('Cutoff date: retrieves the latest available filing on or before this date (YYYY-MM-DD) to prevent lookahead bias'),
    offset: z.number().int().min(0).optional().describe('Character offset to skip for pagination (default: 0)'),
    limit: z.number().int().min(500).max(10000).optional().describe('Maximum number of characters to return (default: 5000, max: 10000)'),
  }),
  async execute(args, _ctx): Promise<ToolResult> {
    const sym = cleanSymbol(args.symbol);

    try {
      const section = await retrievalService.getSection({
        symbol: sym,
        form: args.form,
        sectionCode: args.sectionCode,
        filingDate: args.filingDate,
        asOfDate: args.asOfDate,
        offsetChars: args.offset ?? 0,
        limitChars: args.limit ?? 5000,
      });

      if (!section) {
        return {
          success: true,
          data: {
            symbol: sym,
            sectionCode: args.sectionCode,
            found: false,
            message: `No section "${args.sectionCode}" found for ${sym}${args.form ? ` in ${args.form}` : ''}${args.asOfDate ? ` as of ${args.asOfDate}` : ''}.`,
          },
          provenance: {
            source: 'SEC EDGAR (Section Store)',
            updatedAt: new Date().toISOString(),
          },
        };
      }

      return {
        success: true,
        data: {
          symbol: sym,
          form: section.form,
          filingDate: section.filingDate,
          reportDate: section.reportDate,
          sectionCode: section.sectionCode,
          sectionTitle: section.sectionTitle,
          totalSectionCharacters: section.totalLength,
          offsetCharacters: section.offsetChars,
          returnedCharacters: section.content.length,
          hasMore: section.hasMore,
          citationId: section.citationId,
          content: `<<<UNTRUSTED_FINANCIAL_DOCUMENT_START citationId="${section.citationId}" form="${section.form}" filingDate="${section.filingDate}" section="${section.sectionCode}">>>\n${section.content}\n<<<UNTRUSTED_FINANCIAL_DOCUMENT_END>>>`,
          nextPageOffset: section.hasMore ? section.offsetChars + section.content.length : null,
        },
        provenance: {
          source: 'SEC EDGAR (Section Store)',
          updatedAt: new Date().toISOString(),
        },
        evidenceSource: {
          id: section.citationId,
          label: `${sym} ${section.form} (${section.filingDate}) ${section.sectionCode}`,
          type: 'guidance',
          symbol: sym,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to retrieve document section: ${err.message}`,
        provenance: {
          source: 'SEC EDGAR (Section Store)',
          updatedAt: new Date().toISOString(),
          warnings: [err.message],
        },
      };
    }
  },
};

/**
 * 3. ensure_financial_document_coverage
 * Inspects SEC EDGAR filing coverage and autonomously ingests missing or stale filings.
 */
export const ensureFinancialDocumentCoverageTool: ToolDefinition<{
  symbol: string;
  form?: '10-K' | '10-Q' | '8-K' | 'all';
  endDate?: string;
  force?: boolean;
}> = {
  name: 'ensure_financial_document_coverage',
  description:
    'Inspect SEC EDGAR document coverage for an equity ticker and autonomously discover, ingest, and index missing or stale 10-K, 10-Q, and 8-K filings into the local financial knowledge base. Supports strict historical cutoff filtering (endDate).',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol, e.g. TSLA, NVDA, AAPL, AMZN, GOOGL'),
    form: z.enum(['10-K', '10-Q', '8-K', 'all']).optional().describe('Filter by filing form type: 10-K (annual), 10-Q (quarterly), 8-K (current), or all'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
      .optional()
      .describe('CRITICAL for historical questions: strictly exclude filings accepted after this date (YYYY-MM-DD) to prevent lookahead bias'),
    force: z.boolean().optional().describe('Whether to force re-ingestion of already indexed documents'),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const sym = cleanSymbol(args.symbol);
    const formFilter = args.form === 'all' || !args.form ? undefined : args.form;

    try {
      // 1. Initial coverage inspection
      const initialCoverage = await coverageService.checkCoverage(sym, {
        form: formFilter,
        endDate: args.endDate,
      });

      if (initialCoverage.status === 'UNSUPPORTED') {
        return {
          success: true,
          data: {
            symbol: sym,
            status: 'UNSUPPORTED',
            message: initialCoverage.reason,
            availableFilings: [],
            missingFilings: [],
            isNewlyIngested: false,
          },
          provenance: {
            source: 'SEC EDGAR Ingestion Pipeline',
            updatedAt: new Date().toISOString(),
          },
        };
      }

      if (initialCoverage.status === 'AVAILABLE') {
        return {
          success: true,
          data: {
            symbol: sym,
            status: 'AVAILABLE',
            message: `Document coverage satisfied for ${sym}. ${initialCoverage.availableCount} filings are indexed and ready for retrieval.`,
            availableFilings: initialCoverage.availableFilings,
            missingFilings: [],
            isNewlyIngested: false,
          },
          provenance: {
            source: 'SEC EDGAR Ingestion Pipeline',
            updatedAt: new Date().toISOString(),
          },
        };
      }

      // 2. If MISSING or STALE, enqueue or join ingestion job
      if (initialCoverage.status === 'MISSING' || initialCoverage.status === 'STALE' || args.force) {
        const jobPromise = jobCoordinator.enqueueOrJoin(sym, {
          userId: ctx.userId,
          form: formFilter,
          endDate: args.endDate,
          force: args.force,
        });

        // Bounded wait in foreground (up to 12s, inside 20s per-tool limit)
        const jobResult = await jobCoordinator.waitForJob(jobPromise, 12_000);

        if (jobResult.timedOut) {
          return {
            success: true,
            data: {
              symbol: sym,
              status: 'INGESTING',
              message: `Ingestion job for ${sym} is currently running in the background. Documents will be ready shortly.`,
              availableFilings: initialCoverage.availableFilings,
              missingFilings: initialCoverage.missingFilings,
              isNewlyIngested: false,
            },
            provenance: {
              source: 'SEC EDGAR Ingestion Pipeline',
              updatedAt: new Date().toISOString(),
            },
          };
        }

        // Re-check coverage post-ingestion
        const updatedCoverage = await coverageService.checkCoverage(sym, {
          form: formFilter,
          endDate: args.endDate,
        });

        return {
          success: true,
          data: {
            symbol: sym,
            status: updatedCoverage.status,
            message:
              jobResult.status === 'READY'
                ? `Successfully ingested ${jobResult.documentsIngested} filings and created ${jobResult.chunksCreated} searchable chunks for ${sym}.`
                : `Ingestion job finished with status ${jobResult.status}: ${jobResult.error ?? updatedCoverage.reason}`,
            availableFilings: updatedCoverage.availableFilings,
            missingFilings: updatedCoverage.missingFilings,
            isNewlyIngested: jobResult.documentsIngested > 0,
            documentsIngested: jobResult.documentsIngested,
            chunksCreated: jobResult.chunksCreated,
          },
          provenance: {
            source: 'SEC EDGAR Ingestion Pipeline',
            updatedAt: new Date().toISOString(),
          },
        };
      }

      // If already INGESTING or UNAVAILABLE
      return {
        success: true,
        data: {
          symbol: sym,
          status: initialCoverage.status,
          message: initialCoverage.reason,
          availableFilings: initialCoverage.availableFilings,
          missingFilings: initialCoverage.missingFilings,
          isNewlyIngested: false,
        },
        provenance: {
          source: 'SEC EDGAR Ingestion Pipeline',
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to ensure document coverage for ${sym}: ${err.message}`,
        provenance: {
          source: 'SEC EDGAR Ingestion Pipeline',
          updatedAt: new Date().toISOString(),
          warnings: [err.message],
        },
      };
    }
  },
};
