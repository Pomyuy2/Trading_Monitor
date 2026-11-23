import { db } from '../store/db.js';
import { secCikService, SecCikService } from './sec-cik-service.js';
import { SecClient } from './sec-client.js';
import { jobCoordinator, IngestionJobCoordinator } from './job-coordinator.js';

export type CoverageStatus =
  | 'AVAILABLE'
  | 'MISSING'
  | 'STALE'
  | 'INGESTING'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED';

export interface CoverageReport {
  status: CoverageStatus;
  symbol: string;
  companyName: string | null;
  cik: string | null;
  availableCount: number;
  availableFilings: { form: string; filingDate: string; chunkCount: number; id: string }[];
  missingCount: number;
  missingFilings: { form: string; filingDate: string; accessionNumber: string }[];
  jobId?: string;
  reason: string;
}

export interface CheckCoverageOptions {
  form?: string;
  endDate?: string;
  max10K?: number;
  max10Q?: number;
  max8K?: number;
}

export class DocumentCoverageService {
  private cikService: SecCikService;
  private secClient: SecClient;
  private coordinator: IngestionJobCoordinator;

  constructor(
    cikService?: SecCikService,
    secClient?: SecClient,
    coordinator?: IngestionJobCoordinator
  ) {
    this.cikService = cikService ?? secCikService;
    this.secClient = secClient ?? new SecClient();
    this.coordinator = coordinator ?? jobCoordinator;
  }

  async checkCoverage(
    symbol: string,
    options: CheckCoverageOptions = {}
  ): Promise<CoverageReport> {
    const sym = symbol.toUpperCase().trim();

    // 1. Check eligibility via SecCikService
    const resolved = await this.cikService.resolveTicker(sym);
    if (!resolved) {
      return {
        status: 'UNSUPPORTED',
        symbol: sym,
        companyName: null,
        cik: null,
        availableCount: 0,
        availableFilings: [],
        missingCount: 0,
        missingFilings: [],
        reason: `Ticker "${sym}" is not registered as an SEC EDGAR reporting public company.`,
      };
    }

    // 2. Check if an ingestion job is currently running or indexing
    if (this.coordinator.hasActiveJob(sym)) {
      const activeJob = await db.ingestionJob.findFirst({
        where: { symbol: sym, status: { in: ['RUNNING', 'INDEXING', 'QUEUED'] } },
        orderBy: { createdAt: 'desc' },
      });

      return {
        status: 'INGESTING',
        symbol: sym,
        companyName: resolved.companyName,
        cik: resolved.cik,
        availableCount: 0,
        availableFilings: [],
        missingCount: 0,
        missingFilings: [],
        jobId: activeJob?.id,
        reason: `An SEC ingestion job is currently in progress for ${sym}.`,
      };
    }

    // 3. Query existing documents in SQLite
    const docWhere: any = { symbol: sym };
    if (options.form && options.form !== 'all') {
      if (options.form === '10-K') {
        docWhere.form = { in: ['10-K', '10-K/A'] };
      } else if (options.form === '10-Q') {
        docWhere.form = { in: ['10-Q', '10-Q/A'] };
      } else {
        docWhere.form = options.form;
      }
    }
    if (options.endDate) {
      docWhere.filingDateStr = { lte: options.endDate };
    }

    const existingDocs = await db.financialDocument.findMany({
      where: docWhere,
      orderBy: { filingDateStr: 'desc' },
      select: { id: true, form: true, filingDateStr: true, chunkCount: true },
    });

    const availableFilings = existingDocs.map((d) => ({
      form: d.form,
      filingDate: d.filingDateStr,
      chunkCount: d.chunkCount,
      id: d.id,
    }));

    // 4. Inspect SEC submissions to determine if newer filings exist or if filings are missing
    let submissions: any = null;
    try {
      submissions = await this.secClient.getCompanySubmissions(resolved.cik);
    } catch (err: any) {
      // If SEC submissions fetch fails (e.g. network outage)
      if (existingDocs.length > 0) {
        return {
          status: 'AVAILABLE',
          symbol: sym,
          companyName: resolved.companyName,
          cik: resolved.cik,
          availableCount: availableFilings.length,
          availableFilings,
          missingCount: 0,
          missingFilings: [],
          reason: `Indexed documents available in database (${availableFilings.length} filings). SEC online refresh skipped: ${err.message}`,
        };
      }
      return {
        status: 'FAILED',
        symbol: sym,
        companyName: resolved.companyName,
        cik: resolved.cik,
        availableCount: 0,
        availableFilings: [],
        missingCount: 0,
        missingFilings: [],
        reason: `Failed to query SEC EDGAR submissions: ${err.message}`,
      };
    }

    const r = submissions?.filings?.recent;
    if (!r || !r.form || r.form.length === 0) {
      if (existingDocs.length > 0) {
        return {
          status: 'AVAILABLE',
          symbol: sym,
          companyName: resolved.companyName,
          cik: resolved.cik,
          availableCount: availableFilings.length,
          availableFilings,
          missingCount: 0,
          missingFilings: [],
          reason: `Document coverage satisfied (${availableFilings.length} filings indexed).`,
        };
      }
      return {
        status: 'UNAVAILABLE',
        symbol: sym,
        companyName: resolved.companyName,
        cik: resolved.cik,
        availableCount: 0,
        availableFilings: [],
        missingCount: 0,
        missingFilings: [],
        reason: `No recent SEC filings found on EDGAR for ${sym}.`,
      };
    }

    // Build target filing list from SEC submissions
    const max10K = options.max10K ?? 2;
    const max10Q = options.max10Q ?? 3;
    const max8K = options.max8K ?? 2;

    const targetFilings: { form: string; filingDate: string; accessionNumber: string }[] = [];
    let count10K = 0;
    let count10Q = 0;
    let count8K = 0;

    for (let i = 0; i < r.form.length; i++) {
      const form = r.form[i];
      const filingDate = r.filingDate[i];
      const accessionNumber = r.accessionNumber[i];

      if (options.endDate && filingDate > options.endDate) {
        continue;
      }
      if (options.form && options.form !== 'all') {
        const matchesForm =
          (options.form === '10-K' && (form === '10-K' || form === '10-K/A')) ||
          (options.form === '10-Q' && (form === '10-Q' || form === '10-Q/A')) ||
          form === options.form;
        if (!matchesForm) continue;
      }

      if ((form === '10-K' || form === '10-K/A') && count10K < max10K) {
        targetFilings.push({ form, filingDate, accessionNumber });
        count10K++;
      } else if ((form === '10-Q' || form === '10-Q/A') && count10Q < max10Q) {
        targetFilings.push({ form, filingDate, accessionNumber });
        count10Q++;
      } else if (form === '8-K' && count8K < max8K) {
        const items = r.items?.[i] || '';
        const isEarningsOrMaterial = items.includes('2.02') || items.includes('7.01') || items.length === 0;
        if (isEarningsOrMaterial || count8K < 1) {
          targetFilings.push({ form, filingDate, accessionNumber });
          count8K++;
        }
      }

      if (count10K >= max10K && count10Q >= max10Q && count8K >= max8K) {
        break;
      }
    }

    if (targetFilings.length === 0 && existingDocs.length === 0) {
      return {
        status: 'UNAVAILABLE',
        symbol: sym,
        companyName: resolved.companyName,
        cik: resolved.cik,
        availableCount: 0,
        availableFilings: [],
        missingCount: 0,
        missingFilings: [],
        reason: `No matching ${options.form ?? '10-K/10-Q/8-K'} filings found for ${sym}${options.endDate ? ` prior to ${options.endDate}` : ''}.`,
      };
    }

    // Check which target filings are missing from DB
    const indexedDateSet = new Set(existingDocs.map((d) => `${d.form}:${d.filingDateStr}`));
    const missingFilings = targetFilings.filter(
      (tf) => !indexedDateSet.has(`${tf.form}:${tf.filingDate}`)
    );

    if (existingDocs.length === 0) {
      return {
        status: 'MISSING',
        symbol: sym,
        companyName: resolved.companyName,
        cik: resolved.cik,
        availableCount: 0,
        availableFilings: [],
        missingCount: missingFilings.length,
        missingFilings,
        reason: `Required filings for ${sym} are missing from database (${missingFilings.length} filings available on SEC EDGAR).`,
      };
    }

    if (missingFilings.length > 0) {
      // Check if missing filings include newer filings than what we have indexed
      const latestIndexedDate = existingDocs[0].filingDateStr;
      const hasNewer = missingFilings.some((mf) => mf.filingDate > latestIndexedDate);

      if (hasNewer) {
        return {
          status: 'STALE',
          symbol: sym,
          companyName: resolved.companyName,
          cik: resolved.cik,
          availableCount: availableFilings.length,
          availableFilings,
          missingCount: missingFilings.length,
          missingFilings,
          reason: `Newer SEC filings are available on EDGAR that have not yet been ingested (${missingFilings.length} missing).`,
        };
      }
    }

    return {
      status: 'AVAILABLE',
      symbol: sym,
      companyName: resolved.companyName,
      cik: resolved.cik,
      availableCount: availableFilings.length,
      availableFilings,
      missingCount: missingFilings.length,
      missingFilings,
      reason: `Document coverage satisfied (${availableFilings.length} filings indexed).`,
    };
  }
}

export const coverageService = new DocumentCoverageService();
