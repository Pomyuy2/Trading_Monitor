import { db } from '../store/db.js';
import { SecIngestionPipeline, type IngestionStats } from './sec-ingestion.js';
import { secCikService } from './sec-cik-service.js';

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'INDEXING'
  | 'READY'
  | 'FAILED'
  | 'RETRYABLE'
  | 'UNAVAILABLE';

export interface IngestionJobOptions {
  userId?: string;
  form?: string;
  endDate?: string;
  max10K?: number;
  max10Q?: number;
  max8K?: number;
  force?: boolean;
}

export interface IngestionJobResult {
  jobId: string;
  symbol: string;
  cik?: string;
  status: JobStatus;
  documentsIngested: number;
  chunksCreated: number;
  error?: string;
  timedOut?: boolean;
}

export class IngestionJobCoordinator {
  private activeJobs = new Map<string, Promise<IngestionJobResult>>();
  private runningCount = 0;
  private readonly maxConcurrent = 2;
  private queue: (() => void)[] = [];
  private pipeline: SecIngestionPipeline;
  private retryDelayBaseMs: number;

  constructor(pipeline?: SecIngestionPipeline, options?: { retryDelayBaseMs?: number; autoReconcile?: boolean }) {
    this.pipeline = pipeline ?? new SecIngestionPipeline();
    this.retryDelayBaseMs = options?.retryDelayBaseMs ?? (process.env.NODE_ENV === 'test' ? 50 : 1000);
    // Reconcile orphaned jobs on initialization
    if (options?.autoReconcile ?? true) {
      this.reconcileOrphanedJobs().catch((err) => {
        console.warn('[IngestionJobCoordinator] Orphan reconciliation warning:', err.message);
      });
    }
  }

  /**
   * Recovers jobs left in intermediate states after server restart or crash.
   */
  async reconcileOrphanedJobs(): Promise<number> {
    try {
      const result = await db.ingestionJob.updateMany({
        where: {
          status: { in: ['QUEUED', 'RUNNING', 'INDEXING'] },
        },
        data: {
          status: 'RETRYABLE',
          error: 'Process interrupted during previous runtime execution',
          completedAt: new Date(),
        },
      });
      if (result.count > 0) {
        console.log(`[IngestionJobCoordinator] Reconciled ${result.count} orphaned ingestion jobs to RETRYABLE.`);
      }
      return result.count;
    } catch (err: any) {
      console.warn('[IngestionJobCoordinator] Could not reconcile orphaned jobs:', err.message);
      return 0;
    }
  }

  /**
   * Checks whether an ingestion job is currently executing for the symbol.
   */
  hasActiveJob(symbol: string): boolean {
    return this.activeJobs.has(symbol.toUpperCase());
  }

  /**
   * Singleflight entrypoint: Enqueue or join an existing in-flight ingestion job.
   */
  enqueueOrJoin(symbol: string, options: IngestionJobOptions = {}): Promise<IngestionJobResult> {
    const sym = symbol.toUpperCase().trim();

    // Check if an existing promise is already in flight for this symbol
    const existing = this.activeJobs.get(sym);
    if (existing) {
      return existing;
    }

    // Create the shared background execution promise
    const jobPromise = this.executeJobWithSemaphore(sym, options).finally(() => {
      this.activeJobs.delete(sym);
    });

    this.activeJobs.set(sym, jobPromise);
    return jobPromise;
  }

  /**
   * Await an in-flight job with a bounded foreground timeout (e.g. 15s).
   * If the timeout expires, the job continues uninterrupted in the background.
   */
  async waitForJob(
    jobPromise: Promise<IngestionJobResult>,
    timeoutMs = 15_000
  ): Promise<IngestionJobResult> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<IngestionJobResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          jobId: 'timeout',
          symbol: '',
          status: 'RUNNING',
          documentsIngested: 0,
          chunksCreated: 0,
          timedOut: true,
        });
      }, timeoutMs);
    });

    try {
      const res = await Promise.race([jobPromise, timeoutPromise]);
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.runningCount < this.maxConcurrent) {
      this.runningCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.runningCount++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  private async executeJobWithSemaphore(
    symbol: string,
    options: IngestionJobOptions
  ): Promise<IngestionJobResult> {
    // 1. Resolve CIK first
    const resolved = await secCikService.resolveTicker(symbol);
    if (!resolved) {
      const dbJob = await db.ingestionJob.create({
        data: {
          symbol,
          cik: 'UNKNOWN',
          status: 'UNAVAILABLE',
          error: `Ticker ${symbol} is not registered as an SEC reporting entity.`,
          userId: options.userId,
          completedAt: new Date(),
        },
      });
      return {
        jobId: dbJob.id,
        symbol,
        status: 'UNAVAILABLE',
        documentsIngested: 0,
        chunksCreated: 0,
        error: dbJob.error ?? undefined,
      };
    }

    const cik = resolved.cik;

    // 2. Create durable DB job record in QUEUED status
    const dbJob = await db.ingestionJob.create({
      data: {
        symbol,
        cik,
        form: options.form,
        status: 'QUEUED',
        userId: options.userId,
      },
    });

    await this.acquireSlot();

    try {
      // 3. Mark RUNNING
      await db.ingestionJob.update({
        where: { id: dbJob.id },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });

      // 4. Execute ingestion with transient error retry
      let retries = 0;
      const maxRetries = 3;
      let lastError: any = null;
      let stats: IngestionStats | null = null;

      while (retries < maxRetries) {
        try {
          // Discover filings
          const filings = await this.pipeline.discoverTargetFilings(
            symbol,
            options.max10K ?? 2,
            options.max10Q ?? 3,
            options.max8K ?? 2,
            options.endDate
          );

          if (filings.length === 0) {
            await db.ingestionJob.update({
              where: { id: dbJob.id },
              data: {
                status: 'UNAVAILABLE',
                error: `No SEC filings found for ${symbol}${options.endDate ? ` prior to ${options.endDate}` : ''}`,
                completedAt: new Date(),
              },
            });
            return {
              jobId: dbJob.id,
              symbol,
              cik,
              status: 'UNAVAILABLE',
              documentsIngested: 0,
              chunksCreated: 0,
              error: 'No matching filings found on SEC EDGAR',
            };
          }

          // Mark INDEXING
          await db.ingestionJob.update({
            where: { id: dbJob.id },
            data: { status: 'INDEXING' },
          });

          // Ingest each discovered filing
          let docsIngested = 0;
          let chunksTotal = 0;

          for (const filing of filings) {
            const res = await this.pipeline.ingestFiling(filing, options.force);
            docsIngested++;
            chunksTotal += res.chunks;
          }

          // Mark READY
          await db.ingestionJob.update({
            where: { id: dbJob.id },
            data: {
              status: 'READY',
              documentsIngested: docsIngested,
              chunksCreated: chunksTotal,
              completedAt: new Date(),
            },
          });

          return {
            jobId: dbJob.id,
            symbol,
            cik,
            status: 'READY',
            documentsIngested: docsIngested,
            chunksCreated: chunksTotal,
          };
        } catch (err: any) {
          lastError = err;
          const msg = err.message || '';
          const isTransient =
            msg.includes('429') ||
            msg.includes('503') ||
            msg.includes('timeout') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('ECONNRESET');

          if (!isTransient) {
            // Non-transient failure
            break;
          }

          retries++;
          const delayMs = Math.pow(2, retries) * this.retryDelayBaseMs;
          await db.ingestionJob.update({
            where: { id: dbJob.id },
            data: {
              retryCount: retries,
              error: `Transient error (attempt ${retries}/${maxRetries}): ${msg}`,
            },
          });
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      // If loop exited without returning, mark FAILED
      const errorMsg = lastError?.message || 'Ingestion execution failed';
      await db.ingestionJob.update({
        where: { id: dbJob.id },
        data: {
          status: 'FAILED',
          error: errorMsg,
          completedAt: new Date(),
        },
      });

      return {
        jobId: dbJob.id,
        symbol,
        cik,
        status: 'FAILED',
        documentsIngested: 0,
        chunksCreated: 0,
        error: errorMsg,
      };
    } finally {
      this.releaseSlot();
    }
  }
}

export const jobCoordinator = new IngestionJobCoordinator();
