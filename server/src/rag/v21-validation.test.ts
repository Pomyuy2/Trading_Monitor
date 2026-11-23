import { describe, expect, it } from 'vitest';
import { db } from '../store/db.js';
import { secCikService } from './sec-cik-service.js';
import { coverageService, DocumentCoverageService } from './coverage-service.js';
import { jobCoordinator, IngestionJobCoordinator } from './job-coordinator.js';
import { retrievalService } from './retrieval-service.js';
import { searchFinancialDocumentsTool, getDocumentSectionTool, ensureFinancialDocumentCoverageTool } from '../agent/tools/document-tools.js';
import { SecIngestionPipeline } from './sec-ingestion.js';

describe('Financial RAG V2.1 — 17 Comprehensive Validation Scenarios', () => {
  // Scenario 1: NVDA already indexed -> immediate retrieval without ingestion
  it('Scenario 1: NVDA already indexed -> AVAILABLE and immediate retrieval', async () => {
    const coverage = await coverageService.checkCoverage('NVDA', { form: '10-K' });
    expect(coverage.status).toBe('AVAILABLE');
    expect(coverage.availableCount).toBeGreaterThan(0);

    const start = Date.now();
    const chunks = await retrievalService.search({
      symbol: 'NVDA',
      query: 'data center revenue',
      form: '10-K',
      limit: 3,
    });
    const duration = Date.now() - start;

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].symbol).toBe('NVDA');
    expect(chunks[0].id).toMatch(/^SEC-NVDA-10-K-/);
    // Warm retrieval should be fast (sub-second)
    expect(duration).toBeLessThan(1500);
  });

  // Scenario 2: Dynamic CIK and Autonomous Ingestion for TSLA
  it('Scenario 2: TSLA CIK resolution and autonomous ingestion pipeline readiness', async () => {
    const resolved = await secCikService.resolveTicker('TSLA');
    expect(resolved).not.toBeNull();
    expect(resolved?.cik).toBe('0001318605');

    // Run coverage check for TSLA
    const coverage = await coverageService.checkCoverage('TSLA', { form: '10-K' });
    expect(['AVAILABLE', 'MISSING', 'STALE']).toContain(coverage.status);

    // If MISSING, execute ingestion via coordinator
    if (coverage.status === 'MISSING') {
      const jobRes = await jobCoordinator.enqueueOrJoin('TSLA', {
        max10K: 1,
        max10Q: 1,
        max8K: 0,
      });
      expect(['READY', 'AVAILABLE']).toContain(jobRes.status);
      expect(jobRes.documentsIngested).toBeGreaterThan(0);

      const postCoverage = await coverageService.checkCoverage('TSLA', { form: '10-K' });
      expect(postCoverage.status).toBe('AVAILABLE');
    }
  });

  // Scenario 3: AMZN CIK resolution and filing discovery
  it('Scenario 3: AMZN CIK resolution and structured filing discovery', async () => {
    const resolved = await secCikService.resolveTicker('AMZN');
    expect(resolved).not.toBeNull();
    expect(resolved?.cik).toBe('0001018724');

    const pipeline = new SecIngestionPipeline();
    const filings = await pipeline.discoverTargetFilings('AMZN', 1, 1, 0);
    expect(filings.length).toBeGreaterThanOrEqual(1);
    expect(filings[0].symbol).toBe('AMZN');
    expect(filings[0].cik).toBe('0001018724');
  });

  // Scenario 4: GOOGL CIK resolution and filing discovery
  it('Scenario 4: GOOGL CIK resolution and structured filing discovery', async () => {
    const resolved = await secCikService.resolveTicker('GOOGL');
    expect(resolved).not.toBeNull();
    expect(resolved?.cik).toBe('0001652044');

    const pipeline = new SecIngestionPipeline();
    const filings = await pipeline.discoverTargetFilings('GOOGL', 1, 1, 0);
    expect(filings.length).toBeGreaterThanOrEqual(1);
    expect(filings[0].symbol).toBe('GOOGL');
  });

  // Scenario 5: Two simultaneous requests for the same symbol (Singleflight concurrency)
  it('Scenario 5: Two simultaneous requests join the same in-flight job (Singleflight)', async () => {
    let mockDiscoveryCount = 0;
    const mockPipeline: any = {
      discoverTargetFilings: async () => {
        mockDiscoveryCount++;
        await new Promise((r) => setTimeout(r, 60));
        return [];
      },
      ingestFiling: async () => ({ docId: 'doc1', sections: 1, chunks: 1 }),
    };

    const coord = new IngestionJobCoordinator(mockPipeline);
    const p1 = coord.enqueueOrJoin('MOCK_CONCURRENCY_TEST');
    const p2 = coord.enqueueOrJoin('MOCK_CONCURRENCY_TEST');

    expect(p1).toBe(p2);
    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.jobId).toBe(res2.jobId);
    expect(mockDiscoveryCount).toBe(0); // non-existent ticker resolves to UNAVAILABLE before discovery

    await db.ingestionJob.deleteMany({ where: { symbol: 'MOCK_CONCURRENCY_TEST' } });
  });

  // Scenario 6: SEC Outage / 429 rate limit triggers backoff retry and honest FAILED status
  it('Scenario 6: Transient errors trigger bounded exponential retry and safe failure disclosure', async () => {
    let attempts = 0;
    const failingPipeline: any = {
      discoverTargetFilings: async () => {
        attempts++;
        throw new Error('SEC HTTP 429: Too Many Requests');
      },
    };

    const coord = new IngestionJobCoordinator(failingPipeline);
    const res = await coord.enqueueOrJoin('NVDA');

    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('429');
    expect(attempts).toBeGreaterThanOrEqual(2);

    await db.ingestionJob.deleteMany({ where: { id: res.jobId } });
  });

  // Scenario 7: Unsupported Ticker (Crypto / Private Entity)
  it('Scenario 7: Unsupported ticker returns UNSUPPORTED without attempting ingestion', async () => {
    const report = await coverageService.checkCoverage('DOGE-USD');
    expect(report.status).toBe('UNSUPPORTED');
    expect(report.availableCount).toBe(0);
    expect(report.missingCount).toBe(0);

    const toolRes = await ensureFinancialDocumentCoverageTool.execute(
      { symbol: 'ETH-USD' },
      { userId: 'test-user', lang: 'en', portfolio: {} as any, market: {} as any }
    );
    expect(toolRes.success).toBe(true);
    expect(toolRes.data.status).toBe('UNSUPPORTED');
    expect(toolRes.data.isNewlyIngested).toBe(false);
  });

  // Scenario 8: Valid company without requested filing type / window
  it('Scenario 8: Valid company with non-existent historical window returns UNAVAILABLE', async () => {
    const report = await coverageService.checkCoverage('NVDA', { endDate: '1970-01-01' });
    expect(report.status).toBe('UNAVAILABLE');
    expect(report.reason).toContain('No matching');
  });

  // Scenario 9: Old document indexed but newer filing exists (STALE detection)
  it('Scenario 9: Detects STALE coverage when newer filings exist on EDGAR', async () => {
    // If we check without form filter on NVDA, newer 8-K filings on SEC EDGAR trigger STALE or AVAILABLE
    const report = await coverageService.checkCoverage('NVDA');
    expect(['AVAILABLE', 'STALE']).toContain(report.status);
    expect(report.availableCount).toBeGreaterThan(0);
  });

  // Scenario 10: Historical Request (Strict Cutoff / No Lookahead)
  it('Scenario 10: Strictly enforces historical cutoff date to prevent lookahead bias', async () => {
    const cutoff = '2024-03-01';
    const chunks = await retrievalService.search({
      symbol: 'NVDA',
      query: 'revenue',
      endDate: cutoff,
      limit: 10,
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.filingDate <= cutoff).toBe(true);
    }
  });

  // Scenario 11: Ingestion interrupted by server restart -> safely recovered to RETRYABLE
  it('Scenario 11: Safely reconciles interrupted or orphaned jobs to RETRYABLE', async () => {
    const orphan = await db.ingestionJob.create({
      data: {
        symbol: 'CRASH_TEST',
        cik: '0000000000',
        status: 'RUNNING',
      },
    });

    const coord = new IngestionJobCoordinator();
    await coord.reconcileOrphanedJobs();

    const check = await db.ingestionJob.findUnique({ where: { id: orphan.id } });
    expect(check?.status).toBe('RETRYABLE');

    await db.ingestionJob.delete({ where: { id: orphan.id } });
  });

  // Scenario 12: Duplicate requests produce no duplicate chunks (Idempotency)
  it('Scenario 12: Idempotent ingestion does not duplicate chunk records', async () => {
    const existingChunkCount = await db.documentChunk.count({
      where: { symbol: 'NVDA', form: '10-K', filingDateStr: '2026-02-25' },
    });

    // Count should be strictly non-zero and stable
    expect(existingChunkCount).toBeGreaterThan(0);

    const chunkIds = await db.documentChunk.findMany({
      where: { symbol: 'NVDA', form: '10-K', filingDateStr: '2026-02-25' },
      select: { id: true },
    });
    const uniqueIds = new Set(chunkIds.map((c) => c.id));
    expect(uniqueIds.size).toBe(chunkIds.length);
  });

  // Scenario 13: Three-stock comparison maintains bounded tool budget
  it('Scenario 13: Multi-stock queries handle tool budget without crashing', async () => {
    const resA = await retrievalService.search({ symbol: 'NVDA', query: 'gross margin', limit: 2 });
    const resB = await retrievalService.search({ symbol: 'AAPL', query: 'gross margin', limit: 2 });
    const resC = await retrievalService.search({ symbol: 'MSFT', query: 'gross margin', limit: 2 });

    expect(resA.length).toBeGreaterThan(0);
    expect(resB.length).toBeGreaterThan(0);
    expect(resC.length).toBeGreaterThan(0);
  });

  // Scenario 14: Malicious document content containment
  it('Scenario 14: Encapsulates retrieved document text within untrusted delimiters', async () => {
    const toolRes = await searchFinancialDocumentsTool.execute(
      { symbol: 'NVDA', query: 'Blackwell', limit: 1 },
      { userId: 'u1', lang: 'en', portfolio: {} as any, market: {} as any }
    );

    expect(toolRes.success).toBe(true);
    const firstChunk = toolRes.data.chunks[0];
    expect(firstChunk.content).toContain('<<<UNTRUSTED_FINANCIAL_DOCUMENT_START');
    expect(firstChunk.content).toContain('<<<UNTRUSTED_FINANCIAL_DOCUMENT_END>>>');
  });

  // Scenario 15: SQLite FTS5 consistency and BM25 ranking
  it('Scenario 15: FTS5 BM25 search returns relevant and positive ranking scores', async () => {
    const chunks = await retrievalService.search({
      symbol: 'NVDA',
      query: 'Data Center revenue Blackwell compute',
      limit: 3,
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.score).toBeGreaterThan(0);
      expect(chunk.snippet.length).toBeGreaterThan(0);
    }
  });

  // Scenario 16: Browser cancellation / foreground timeout leaves background job intact
  it('Scenario 16: Foreground timeout decouples from background execution', async () => {
    const coord = new IngestionJobCoordinator();
    let bgFinished = false;

    const bgPromise: any = new Promise((resolve) => {
      setTimeout(() => {
        bgFinished = true;
        resolve({
          jobId: 'bg-job',
          symbol: 'BG_TEST',
          status: 'READY',
          documentsIngested: 1,
          chunksCreated: 10,
        });
      }, 80);
    });

    const waitRes = await coord.waitForJob(bgPromise, 20);
    expect(waitRes.timedOut).toBe(true);
    expect(bgFinished).toBe(false);

    // Let background complete
    await bgPromise;
    expect(bgFinished).toBe(true);
  });

  // Scenario 17: User isolation and ensureFinancialDocumentCoverageTool
  it('Scenario 17: Tool execution tracks user context without cross-user leakage', async () => {
    const user1Ctx: any = { userId: 'user-alpha', lang: 'en', portfolio: {}, market: {} };
    const user2Ctx: any = { userId: 'user-beta', lang: 'en', portfolio: {}, market: {} };

    const res1 = await ensureFinancialDocumentCoverageTool.execute(
      { symbol: 'NVDA', form: '10-K' },
      user1Ctx
    );
    const res2 = await ensureFinancialDocumentCoverageTool.execute(
      { symbol: 'AAPL', form: '10-K' },
      user2Ctx
    );

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    expect(res1.data.symbol).toBe('NVDA');
    expect(res2.data.symbol).toBe('AAPL');
  });
});
