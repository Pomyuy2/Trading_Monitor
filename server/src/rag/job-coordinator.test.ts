import { describe, expect, it } from 'vitest';
import { IngestionJobCoordinator } from './job-coordinator.js';
import { db } from '../store/db.js';

describe('IngestionJobCoordinator — Durable Job Orchestration & Singleflight', () => {
  it('reconciles orphaned RUNNING or INDEXING jobs to RETRYABLE on startup', async () => {
    // Insert dummy orphaned job
    const orphaned = await db.ingestionJob.create({
      data: {
        symbol: 'MOCK_ORPHAN',
        cik: '0001234567',
        status: 'INDEXING',
      },
    });

    const coordinator = new IngestionJobCoordinator(undefined, { autoReconcile: false });
    const count = await coordinator.reconcileOrphanedJobs();
    expect(count).toBeGreaterThanOrEqual(1);

    const refreshed = await db.ingestionJob.findUnique({ where: { id: orphaned.id } });
    expect(refreshed?.status).toBe('RETRYABLE');
    expect(refreshed?.error).toContain('Process interrupted');

    // Clean up
    await db.ingestionJob.delete({ where: { id: orphaned.id } });
  });

  it('shares the exact same Promise for simultaneous requests for the same symbol (Singleflight)', async () => {
    // Create a mock pipeline with a delayed discovery
    let discoverCalls = 0;
    const mockPipeline: any = {
      discoverTargetFilings: async () => {
        discoverCalls++;
        await new Promise((r) => setTimeout(r, 50));
        return [];
      },
      ingestFiling: async () => ({ docId: 'test', sections: 1, chunks: 1 }),
    };

    const coordinator = new IngestionJobCoordinator(mockPipeline);

    const p1 = coordinator.enqueueOrJoin('TSLA');
    const p2 = coordinator.enqueueOrJoin('TSLA');

    // Both promises should be identical
    expect(p1).toBe(p2);
    expect(coordinator.hasActiveJob('TSLA')).toBe(true);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.jobId).toBe(res2.jobId);
    expect(coordinator.hasActiveJob('TSLA')).toBe(false);

    // Clean up created jobs
    if (res1.jobId) {
      await db.ingestionJob.deleteMany({ where: { id: res1.jobId } });
    }
  });

  it('waitForJob returns timedOut: true when job takes longer than timeout without killing background execution', async () => {
    let finished = false;
    const slowPromise: any = new Promise((resolve) => {
      setTimeout(() => {
        finished = true;
        resolve({
          jobId: 'slow-job',
          symbol: 'SLOW',
          status: 'READY',
          documentsIngested: 1,
          chunksCreated: 5,
        });
      }, 100);
    });

    const coordinator = new IngestionJobCoordinator();
    const waitResult = await coordinator.waitForJob(slowPromise, 20);

    expect(waitResult.timedOut).toBe(true);
    expect(waitResult.status).toBe('RUNNING');

    // Wait for the slow promise to finish in background
    await slowPromise;
    expect(finished).toBe(true);
  });
});
