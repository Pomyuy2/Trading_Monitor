import type { FinancialStatementFacts, PeriodFacts, SourceDocument } from '@tm/shared';
import { Memo } from '../lib/memo.js';
import { htmlToText, mdaSection } from '../lib/html-text.js';
import { BaseProvider, NotFoundError, RateLimitError, type Capability } from './types.js';

/**
 * SEC EDGAR (https://www.sec.gov/edgar) — free, official US filings. Used as the
 * free source for guidance extraction and official XBRL Company Facts:
 *   - latest 8-K with Item 2.02 (results of operations): the earnings press release (Exhibit 99.1)
 *   - latest 10-K: the Management's Discussion & Analysis section
 *   - companyfacts API: standardized 10-K and 10-Q XBRL financial statement facts
 * SEC asks automated clients to send a descriptive User-Agent and stay under 10 requests/second.
 * US-listed companies only (no ETFs; foreign issuers file 20-F / 6-K instead).
 */
const MAX_RELEASE_CHARS = 60_000;
const MAX_MDA_CHARS = 120_000;

interface Submissions {
  filings: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[]; items?: string[] } };
}

interface FactRow {
  end: string;
  val: number;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
  accn: string;
  start?: string;
}

interface FactConcept {
  label?: string;
  description?: string;
  units?: Record<string, FactRow[]>;
}

interface SecCompanyFactsResponse {
  cik: number;
  entityName: string;
  facts: {
    dei?: Record<string, FactConcept>;
    'us-gaap'?: Record<string, FactConcept>;
  };
}

export class SecEdgarProvider extends BaseProvider {
  readonly name = 'SEC EDGAR';
  protected readonly capabilities = new Set<Capability>(['transcripts', 'companyFacts']);
  private tickers = new Memo<Map<string, number>>(24 * 3600_000);
  private docs = new Memo<SourceDocument[]>(12 * 3600_000);
  private facts = new Memo<FinancialStatementFacts>(24 * 3600_000);

  constructor(private readonly userAgent: string) {
    super();
  }

  isAvailable(): boolean {
    return true; // no key needed
  }

  private async fetchText(url: string, accept = 'application/json'): Promise<string> {
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: accept }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) throw new RateLimitError(this.name, 10_000);
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    return res.text();
  }

  private cik(symbol: string): Promise<number | undefined> {
    return this.tickers
      .get('all', async () => {
        const j = JSON.parse(await this.fetchText('https://www.sec.gov/files/company_tickers.json')) as Record<string, { cik_str: number; ticker: string }>;
        return new Map(Object.values(j).map((r) => [r.ticker.toUpperCase(), r.cik_str]));
      })
      .then((m) => m.get(symbol.toUpperCase()) ?? m.get(symbol.toUpperCase().replace('.', '-')));
  }

  async getGuidanceDocuments(symbol: string): Promise<SourceDocument[]> {
    return this.docs.get(symbol, async () => {
      const cik = await this.cik(symbol);
      if (!cik) throw new NotFoundError(`SEC filer for ${symbol}`);
      const sub = JSON.parse(await this.fetchText(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`)) as Submissions;
      const r = sub.filings.recent;
      const out: SourceDocument[] = [];

      // Latest earnings release: 8-K with Item 2.02, exhibit 99.1.
      const i8k = r.form.findIndex((f, i) => f === '8-K' && (r.items?.[i] ?? '').split(',').includes('2.02'));
      if (i8k >= 0) {
        const acc = r.accessionNumber[i8k].replace(/-/g, '');
        const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}`;
        let docName = r.primaryDocument[i8k];
        try {
          // File names vary (ex99-1.htm, a8-kex991q4….htm, q2fy27pr.htm …), so read each document's
          // official type from the filing index page and take EX-99.1 (else the first EX-99.x).
          const page = await this.fetchText(`${base}/${r.accessionNumber[i8k]}-index.html`, 'text/html');
          const rows = [...page.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
          const docOf = (re: RegExp) => {
            const row = rows.find((x) => re.test(x));
            return row?.match(/href="[^"]*\/([^"/]+\.html?)"/i)?.[1];
          };
          docName = docOf(/>\s*EX-99\.1\s*</i) ?? docOf(/>\s*EX-99(\.\d+)?\s*</i) ?? docName;
        } catch {
          // fall back to the primary document
        }
        const url = `${base}/${docName}`;
        const text = htmlToText(await this.fetchText(url, 'text/html')).slice(0, MAX_RELEASE_CHARS);
        if (text.length > 500) out.push({ title: `Earnings press release (Form 8-K, Exhibit 99.1)`, date: r.filingDate[i8k], url, text });
      }

      // Latest annual report: 10-K, MD&A section only.
      const i10k = r.form.findIndex((f) => f === '10-K');
      if (i10k >= 0) {
        const acc = r.accessionNumber[i10k].replace(/-/g, '');
        const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${r.primaryDocument[i10k]}`;
        const full = htmlToText(await this.fetchText(url, 'text/html'));
        const mda = mdaSection(full).slice(0, MAX_MDA_CHARS);
        if (mda.length > 500) out.push({ title: `Annual report (Form 10-K), MD&A`, date: r.filingDate[i10k], url, text: mda });
      }
      return out;
    });
  }

  /**
   * Fetches and normalizes official SEC EDGAR XBRL Company Facts.
   * Handles tag fallback, restatements/amendments, and strictly filters out cumulative YTD figures.
   */
  async getCompanyFacts(symbol: string): Promise<FinancialStatementFacts> {
    return this.facts.get(symbol, async () => {
      const cik = await this.cik(symbol);
      if (!cik) throw new NotFoundError(`SEC filer for ${symbol}`);

      const paddedCik = String(cik).padStart(10, '0');
      const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;
      const rawText = await this.fetchText(url);
      const data = JSON.parse(rawText) as SecCompanyFactsResponse;

      const usGaap = data.facts?.['us-gaap'] ?? {};
      const dei = data.facts?.['dei'] ?? {};

      interface MetricConcept {
        category: Record<string, FactConcept>;
        tag: string;
      }

      const metricConfigs: Record<string, MetricConcept[]> = {
        revenue: [
          { category: usGaap, tag: 'RevenueFromContractWithCustomerExcludingAssessedTax' },
          { category: usGaap, tag: 'SalesRevenueNet' },
          { category: usGaap, tag: 'Revenues' },
          { category: usGaap, tag: 'SalesRevenueServicesGross' },
        ],
        netIncome: [
          { category: usGaap, tag: 'NetIncomeLoss' },
          { category: usGaap, tag: 'ProfitLoss' },
          { category: usGaap, tag: 'NetIncomeLossAvailableToCommonStockholdersBasic' },
        ],
        epsBasic: [
          { category: usGaap, tag: 'EarningsPerShareBasic' },
        ],
        epsDiluted: [
          { category: usGaap, tag: 'EarningsPerShareDiluted' },
        ],
        assets: [
          { category: usGaap, tag: 'Assets' },
        ],
        liabilities: [
          { category: usGaap, tag: 'Liabilities' },
        ],
        equity: [
          { category: usGaap, tag: 'StockholdersEquity' },
          { category: usGaap, tag: 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest' },
        ],
        sharesOutstanding: [
          { category: dei, tag: 'EntityCommonStockSharesOutstanding' },
          { category: usGaap, tag: 'CommonStockSharesOutstanding' },
          { category: usGaap, tag: 'WeightedAverageNumberOfDilutedSharesOutstanding' },
          { category: usGaap, tag: 'WeightedAverageNumberOfSharesOutstandingBasic' },
        ],
      };

      interface MetricSlot {
        val: number;
        tagIndex: number;
        filed: string;
        form: string;
        accn: string;
        start?: string;
        end: string;
      }

      const annualSlots = new Map<number, Record<string, MetricSlot>>();
      const quarterlySlots = new Map<string, Record<string, MetricSlot>>();

      for (const [metricKey, tagList] of Object.entries(metricConfigs)) {
        tagList.forEach((item, tagIndex) => {
          const concept = item.category[item.tag];
          if (!concept?.units) return;
          for (const rows of Object.values(concept.units)) {
            if (!Array.isArray(rows)) continue;
            for (const r of rows) {
              if (r.val == null || !Number.isFinite(r.val)) continue;
              const isAnnual = r.fp === 'FY';
              const isQuarter = r.fp === 'Q1' || r.fp === 'Q2' || r.fp === 'Q3' || r.fp === 'Q4';
              if (!isAnnual && !isQuarter) continue;

              // Filter out cumulative YTD 6-month or 9-month figures from quarterly slots
              if (r.start && r.end) {
                const durationDays = (Date.parse(r.end) - Date.parse(r.start)) / 86400_000;
                if (durationDays > 0) {
                  if (isQuarter && durationDays > 110) continue; // Exclude cumulative YTD
                  if (isAnnual && durationDays < 300) continue; // Exclude partial year
                }
              }

              const targetMap = isAnnual ? annualSlots : quarterlySlots;
              const periodKey = isAnnual ? r.fy : `${r.fy}:${r.fp}`;
              let periodRecord = targetMap.get(periodKey as never);
              if (!periodRecord) {
                periodRecord = {};
                targetMap.set(periodKey as never, periodRecord);
              }

              const existing = periodRecord[metricKey];
              if (!existing) {
                periodRecord[metricKey] = {
                  val: r.val,
                  tagIndex,
                  filed: r.filed,
                  form: r.form,
                  accn: r.accn,
                  start: r.start,
                  end: r.end,
                };
              } else if (tagIndex < existing.tagIndex) {
                // Higher-priority concept tag (e.g. modern ASC 606 revenue vs legacy)
                periodRecord[metricKey] = {
                  val: r.val,
                  tagIndex,
                  filed: r.filed,
                  form: r.form,
                  accn: r.accn,
                  start: r.start,
                  end: r.end,
                };
              } else if (tagIndex === existing.tagIndex) {
                // Same concept tag: choose latest filed amendment or restatement
                const isAmended = r.form?.includes('/A') ?? false;
                const existingAmended = existing.form?.includes('/A') ?? false;
                if (r.filed > existing.filed || (r.filed === existing.filed && isAmended && !existingAmended)) {
                  periodRecord[metricKey] = {
                    val: r.val,
                    tagIndex,
                    filed: r.filed,
                    form: r.form,
                    accn: r.accn,
                    start: r.start,
                    end: r.end,
                  };
                }
              }
            }
          }
        });
      }

      const baseUrl = `https://www.sec.gov/edgar/browse/?CIK=${cik}`;

      const buildPeriodFacts = (
        fy: number,
        fp: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'FY',
        slots: Record<string, MetricSlot>,
      ): PeriodFacts => {
        const allSlots = Object.values(slots);
        const latestSlot = allSlots.reduce((prev, curr) => (curr.filed > prev.filed ? curr : prev), allSlots[0]);

        return {
          fiscalYear: fy,
          fiscalPeriod: fp,
          endDate: latestSlot?.end ?? '',
          startDate: latestSlot?.start,
          form: latestSlot?.form ?? '',
          filed: latestSlot?.filed ?? '',
          accn: latestSlot?.accn ?? '',
          url: baseUrl,
          revenue: slots.revenue?.val,
          netIncome: slots.netIncome?.val,
          epsBasic: slots.epsBasic?.val,
          epsDiluted: slots.epsDiluted?.val,
          assets: slots.assets?.val,
          liabilities: slots.liabilities?.val,
          equity: slots.equity?.val,
          sharesOutstanding: slots.sharesOutstanding?.val,
        };
      };

      const annual: PeriodFacts[] = Array.from(annualSlots.entries())
        .map(([fy, slots]) => buildPeriodFacts(fy, 'FY', slots))
        .sort((a, b) => b.fiscalYear - a.fiscalYear);

      const quarterly: PeriodFacts[] = Array.from(quarterlySlots.entries())
        .map(([key, slots]) => {
          const [fyStr, fpStr] = key.split(':');
          return buildPeriodFacts(Number(fyStr), fpStr as 'Q1' | 'Q2' | 'Q3' | 'Q4', slots);
        })
        .sort((a, b) => {
          if (a.fiscalYear !== b.fiscalYear) return b.fiscalYear - a.fiscalYear;
          const qNum = (p: string) => parseInt(p.slice(1), 10) || 0;
          return qNum(b.fiscalPeriod) - qNum(a.fiscalPeriod);
        });

      return {
        symbol: symbol.toUpperCase(),
        cik,
        entityName: data.entityName,
        annual,
        quarterly,
        meta: {
          source: this.name,
          updatedAt: new Date().toISOString(),
          feed: 'sec',
          latency: 'eod',
        },
      };
    });
  }
}
