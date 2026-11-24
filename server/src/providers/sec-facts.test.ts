import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from './types.js';
import { SecEdgarProvider } from './sec.js';

describe('SecEdgarProvider Company Facts', () => {
  let routes: Array<{ match: RegExp; status?: number; body: string }> = [];

  beforeEach(() => {
    routes = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      const r = routes.find((x) => x.match.test(url));
      if (!r) throw new Error(`Unexpected network call: ${url}`);
      return new Response(r.body, {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    // Mock ticker lookup
    routes.push({
      match: /company_tickers\.json/,
      body: JSON.stringify({
        '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
        '1': { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
        '2': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts official annual and quarterly company facts', async () => {
    routes.push({
      match: /companyfacts\/CIK0000320193\.json/,
      body: JSON.stringify({
        cik: 320193,
        entityName: 'Apple Inc.',
        facts: {
          'us-gaap': {
            Revenues: {
              label: 'Revenues',
              units: {
                USD: [
                  {
                    start: '2025-09-29',
                    end: '2026-09-26',
                    val: 391035000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                  {
                    start: '2026-06-28',
                    end: '2026-09-26', // ~90 days: true single quarter
                    val: 94930000000,
                    fy: 2026,
                    fp: 'Q4',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                ],
              },
            },
            NetIncomeLoss: {
              units: {
                USD: [
                  {
                    start: '2025-09-29',
                    end: '2026-09-26',
                    val: 93736000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                  {
                    start: '2026-06-28',
                    end: '2026-09-26',
                    val: 14736000000,
                    fy: 2026,
                    fp: 'Q4',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                ],
              },
            },
            EarningsPerShareDiluted: {
              units: {
                'USD/shares': [
                  {
                    start: '2025-09-29',
                    end: '2026-09-26',
                    val: 6.08,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                ],
              },
            },
            Assets: {
              units: {
                USD: [
                  {
                    end: '2026-09-26',
                    val: 364980000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                ],
              },
            },
            Liabilities: {
              units: {
                USD: [
                  {
                    end: '2026-09-26',
                    val: 308030000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                ],
              },
            },
            StockholdersEquity: {
              units: {
                USD: [
                  {
                    end: '2026-09-26',
                    val: 56950000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                ],
              },
            },
          },
          dei: {
            EntityCommonStockSharesOutstanding: {
              units: {
                shares: [
                  {
                    end: '2026-10-18',
                    val: 15115822000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: '0000320193-26-000106',
                  },
                ],
              },
            },
          },
        },
      }),
    });

    const sec = new SecEdgarProvider('TestAgent user@test.com');
    const facts = await sec.getCompanyFacts('AAPL');

    expect(facts.symbol).toBe('AAPL');
    expect(facts.cik).toBe(320193);
    expect(facts.entityName).toBe('Apple Inc.');
    expect(facts.meta.source).toBe('SEC EDGAR');
    expect(facts.meta.feed).toBe('sec');

    // Annual facts verification
    expect(facts.annual).toHaveLength(1);
    const fy26 = facts.annual[0];
    expect(fy26.fiscalYear).toBe(2026);
    expect(fy26.revenue).toBe(391035000000);
    expect(fy26.netIncome).toBe(93736000000);
    expect(fy26.epsDiluted).toBe(6.08);
    expect(fy26.assets).toBe(364980000000);
    expect(fy26.liabilities).toBe(308030000000);
    expect(fy26.equity).toBe(56950000000);
    expect(fy26.sharesOutstanding).toBe(15115822000);
    expect(fy26.accn).toBe('0000320193-26-000106');

    // Quarterly facts verification
    expect(facts.quarterly).toHaveLength(1);
    const q4_26 = facts.quarterly[0];
    expect(q4_26.fiscalYear).toBe(2026);
    expect(q4_26.fiscalPeriod).toBe('Q4');
    expect(q4_26.revenue).toBe(94930000000);
    expect(q4_26.netIncome).toBe(14736000000);
  });

  it('strictly filters out cumulative YTD 6-month or 9-month rows from quarterly facts', async () => {
    routes.push({
      match: /companyfacts\/CIK0000789019\.json/,
      body: JSON.stringify({
        cik: 789019,
        entityName: 'MICROSOFT CORP',
        facts: {
          'us-gaap': {
            Revenues: {
              units: {
                USD: [
                  // Row A: true single quarter (3 months ~ 90 days)
                  {
                    start: '2026-01-01',
                    end: '2026-03-31', // 89 days
                    val: 60000000000,
                    fy: 2026,
                    fp: 'Q3',
                    form: '10-Q',
                    filed: '2026-04-25',
                    accn: 'accn-q3-single',
                  },
                  // Row B: cumulative 9-month YTD figure reported in the same 10-Q
                  {
                    start: '2025-07-01',
                    end: '2026-03-31', // 273 days! Cumulative YTD
                    val: 180000000000,
                    fy: 2026,
                    fp: 'Q3',
                    form: '10-Q',
                    filed: '2026-04-25',
                    accn: 'accn-q3-cumulative',
                  },
                ],
              },
            },
          },
        },
      }),
    });

    const sec = new SecEdgarProvider('TestAgent user@test.com');
    const facts = await sec.getCompanyFacts('MSFT');

    expect(facts.quarterly).toHaveLength(1);
    const q3 = facts.quarterly[0];
    expect(q3.fiscalPeriod).toBe('Q3');
    // Value must be the single-quarter 60B, NEVER the cumulative YTD 180B!
    expect(q3.revenue).toBe(60000000000);
    expect(q3.accn).toBe('accn-q3-single');
  });

  it('resolves amended filings (10-K/A, 10-Q/A) by choosing the latest filed restatement', async () => {
    routes.push({
      match: /companyfacts\/CIK0000320193\.json/,
      body: JSON.stringify({
        cik: 320193,
        entityName: 'Apple Inc.',
        facts: {
          'us-gaap': {
            Revenues: {
              units: {
                USD: [
                  // Original filing
                  {
                    start: '2025-09-29',
                    end: '2026-09-26',
                    val: 391000000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: 'accn-original',
                  },
                  // Restatement in 10-K/A filed a month later
                  {
                    start: '2025-09-29',
                    end: '2026-09-26',
                    val: 391035000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K/A',
                    filed: '2026-11-30',
                    accn: 'accn-amendment',
                  },
                ],
              },
            },
          },
        },
      }),
    });

    const sec = new SecEdgarProvider('TestAgent user@test.com');
    const facts = await sec.getCompanyFacts('AAPL');

    expect(facts.annual).toHaveLength(1);
    const fy = facts.annual[0];
    expect(fy.revenue).toBe(391035000000); // Restated amended value
    expect(fy.form).toBe('10-K/A');
    expect(fy.accn).toBe('accn-amendment');
  });

  it('supports tag migration across fiscal years (modern ASC 606 revenue and legacy tag)', async () => {
    routes.push({
      match: /companyfacts\/CIK0000320193\.json/,
      body: JSON.stringify({
        cik: 320193,
        entityName: 'Apple Inc.',
        facts: {
          'us-gaap': {
            RevenueFromContractWithCustomerExcludingAssessedTax: {
              units: {
                USD: [
                  {
                    start: '2025-09-29',
                    end: '2026-09-26',
                    val: 391035000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-10-31',
                    accn: 'accn-modern-2026',
                  },
                ],
              },
            },
            Revenues: {
              units: {
                USD: [
                  {
                    start: '2016-09-25',
                    end: '2017-09-30',
                    val: 229234000000,
                    fy: 2017,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2017-11-03',
                    accn: 'accn-legacy-2017',
                  },
                ],
              },
            },
          },
        },
      }),
    });

    const sec = new SecEdgarProvider('TestAgent user@test.com');
    const facts = await sec.getCompanyFacts('AAPL');

    expect(facts.annual).toHaveLength(2);
    const fy26 = facts.annual.find((f) => f.fiscalYear === 2026);
    const fy17 = facts.annual.find((f) => f.fiscalYear === 2017);
    expect(fy26?.revenue).toBe(391035000000);
    expect(fy17?.revenue).toBe(229234000000);
  });

  it('preserves instant balance sheet facts and falls back to weighted-average shares', async () => {
    routes.push({
      match: /companyfacts\/CIK0000789019\.json/,
      body: JSON.stringify({
        cik: 789019,
        entityName: 'MICROSOFT CORP',
        facts: {
          'us-gaap': {
            Assets: {
              units: {
                USD: [
                  // Instant fact: no start date
                  {
                    end: '2026-06-30',
                    val: 512000000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-07-30',
                    accn: 'accn-instant',
                  },
                ],
              },
            },
            WeightedAverageNumberOfDilutedSharesOutstanding: {
              units: {
                shares: [
                  // Duration fact for weighted average shares
                  {
                    start: '2025-07-01',
                    end: '2026-06-30',
                    val: 7450000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-07-30',
                    accn: 'accn-shares',
                  },
                ],
              },
            },
          },
        },
      }),
    });

    const sec = new SecEdgarProvider('TestAgent user@test.com');
    const facts = await sec.getCompanyFacts('MSFT');

    expect(facts.annual).toHaveLength(1);
    const fy = facts.annual[0];
    expect(fy.assets).toBe(512000000000);
    expect(fy.sharesOutstanding).toBe(7450000000);
  });

  it('accurately resolves multi-year comparative rows in 10-K and 10-Q (NVDA audit regression)', async () => {
    routes.push({
      match: /company_tickers\.json/,
      body: JSON.stringify({
        '0': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
      }),
    });

    routes.push({
      match: /companyfacts\/CIK0001045810\.json/,
      body: JSON.stringify({
        cik: 1045810,
        entityName: 'NVIDIA CORP',
        facts: {
          'us-gaap': {
            Revenues: {
              units: {
                USD: [
                  // Form 10-K (filed 2026-02-25, filing fy=2026, fp=FY) contains 3 comparative annual rows:
                  // Oldest comparative year (FY2024) appears first in SEC JSON array!
                  {
                    start: '2023-01-30',
                    end: '2024-01-28',
                    val: 60922000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                  // Prior comparative year (FY2025)
                  {
                    start: '2024-01-29',
                    end: '2025-01-26',
                    val: 130497000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                  // Current reporting year (FY2026)
                  {
                    start: '2025-01-27',
                    end: '2026-01-25',
                    val: 215938000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                  // Form 10-Q (filed 2026-08-26, filing fy=2027, fp=Q2) contains comparative Q2 from prior year:
                  {
                    start: '2025-04-28',
                    end: '2025-07-27',
                    val: 46743000000,
                    fy: 2027,
                    fp: 'Q2',
                    form: '10-Q',
                    filed: '2026-08-26',
                    accn: '0001045810-26-000075',
                  },
                  // Current Q2 FY2027
                  {
                    start: '2026-04-27',
                    end: '2026-07-26',
                    val: 96221000000,
                    fy: 2027,
                    fp: 'Q2',
                    form: '10-Q',
                    filed: '2026-08-26',
                    accn: '0001045810-26-000075',
                  },
                ],
              },
            },
            NetCashProvidedByUsedInOperatingActivities: {
              units: {
                USD: [
                  {
                    start: '2023-01-30',
                    end: '2024-01-28',
                    val: 28090000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                  {
                    start: '2025-01-27',
                    end: '2026-01-25',
                    val: 102718000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                ],
              },
            },
            PaymentsToAcquireProductiveAssets: {
              units: {
                USD: [
                  {
                    start: '2023-01-30',
                    end: '2024-01-28',
                    val: 1306000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                  {
                    start: '2025-01-27',
                    end: '2026-01-25',
                    val: 6143000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                ],
              },
            },
            OperatingIncomeLoss: {
              units: {
                USD: [
                  {
                    start: '2025-01-27',
                    end: '2026-01-25',
                    val: 130387000000,
                    fy: 2026,
                    fp: 'FY',
                    form: '10-K',
                    filed: '2026-02-25',
                    accn: '0001045810-26-000021',
                  },
                ],
              },
            },
          },
        },
      }),
    });

    const sec = new SecEdgarProvider('TestAgent user@test.com');
    const facts = await sec.getCompanyFacts('NVDA');

    // 1. Verify that FY2026 is NOT overwritten by the older FY2024 comparative row
    const fy26 = facts.annual.find((a) => a.fiscalYear === 2026);
    expect(fy26).toBeDefined();
    expect(fy26?.revenue).toBe(215938000000); // $215.938B, NOT $60.922B
    expect(fy26?.operatingCashFlow).toBe(102718000000);
    expect(fy26?.capitalExpenditures).toBe(6143000000);
    // Base FCF must be $102.718B - $6.143B = $96.575B, NOT $26.784B!
    expect(fy26?.freeCashFlow).toBe(96575000000);
    expect(fy26?.operatingIncome).toBe(130387000000);

    // 2. Verify that FY2025 and FY2024 comparative rows mapped to their correct years
    const fy25 = facts.annual.find((a) => a.fiscalYear === 2025);
    expect(fy25).toBeDefined();
    expect(fy25?.revenue).toBe(130497000000);

    const fy24 = facts.annual.find((a) => a.fiscalYear === 2024);
    expect(fy24).toBeDefined();
    expect(fy24?.revenue).toBe(60922000000);
    expect(fy24?.freeCashFlow).toBe(28090000000 - 1306000000); // $26.784B (FY2024 FCF)

    // 3. Verify quarterly facts: Q2 FY2027 must be $96.221B, and comparative Q2 FY2026 is $46.743B
    const q2_27 = facts.quarterly.find((q) => q.fiscalYear === 2027 && q.fiscalPeriod === 'Q2');
    expect(q2_27).toBeDefined();
    expect(q2_27?.revenue).toBe(96221000000); // $96.221B, NOT $46.743B

    const q2_26 = facts.quarterly.find((q) => q.fiscalYear === 2026 && q.fiscalPeriod === 'Q2');
    expect(q2_26).toBeDefined();
    expect(q2_26?.revenue).toBe(46743000000); // $46.743B (comparative prior year)
  });

  it('throws NotFoundError for unknown or non-SEC filers', async () => {
    const sec = new SecEdgarProvider('TestAgent user@test.com');
    await expect(sec.getCompanyFacts('NONEXISTENT_XYZ')).rejects.toBeInstanceOf(NotFoundError);
  });
});
