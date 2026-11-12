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

  it('throws NotFoundError for unknown or non-SEC filers', async () => {
    const sec = new SecEdgarProvider('TestAgent user@test.com');
    await expect(sec.getCompanyFacts('NONEXISTENT_XYZ')).rejects.toBeInstanceOf(NotFoundError);
  });
});
