import { describe, expect, it } from 'vitest';
import { DocumentCoverageService } from './coverage-service.js';
import { SecCikService } from './sec-cik-service.js';

describe('DocumentCoverageService — Coverage-Aware Retrieval', () => {
  const coverageService = new DocumentCoverageService();

  it('reports AVAILABLE for core reference universe 10-K filings already indexed (NVDA)', async () => {
    const report = await coverageService.checkCoverage('NVDA', { form: '10-K' });
    expect(report.symbol).toBe('NVDA');
    expect(report.status).toBe('AVAILABLE');
    expect(report.availableCount).toBeGreaterThan(0);
    expect(report.availableFilings.length).toBeGreaterThan(0);
    expect(report.reason).toContain('coverage satisfied');
  });

  it('reports STALE or AVAILABLE for general query when newer 8-K filings exist on SEC', async () => {
    const report = await coverageService.checkCoverage('NVDA');
    expect(report.symbol).toBe('NVDA');
    expect(['AVAILABLE', 'STALE']).toContain(report.status);
    expect(report.availableCount).toBeGreaterThan(0);
  });

  it('reports UNSUPPORTED for non-public or crypto assets without triggering ingestion', async () => {
    const report1 = await coverageService.checkCoverage('DOGE-USD');
    expect(report1.symbol).toBe('DOGE-USD');
    expect(report1.status).toBe('UNSUPPORTED');
    expect(report1.availableCount).toBe(0);
    expect(report1.reason).toContain('not registered as an SEC EDGAR reporting public company');

    const report2 = await coverageService.checkCoverage('NONEXISTENT_TICKER_999');
    expect(report2.status).toBe('UNSUPPORTED');
  });

  it('reports UNAVAILABLE when a valid company has no filings matching an impossible date filter', async () => {
    // NVDA filings before 1980 do not exist
    const report = await coverageService.checkCoverage('NVDA', { endDate: '1980-01-01' });
    expect(report.status).toBe('UNAVAILABLE');
    expect(report.reason).toContain('No matching');
  });

  it('correctly handles ticker casing and whitespace', async () => {
    const report = await coverageService.checkCoverage('  nvda  ', { form: '10-K' });
    expect(report.symbol).toBe('NVDA');
    expect(report.status).toBe('AVAILABLE');
  });
});
