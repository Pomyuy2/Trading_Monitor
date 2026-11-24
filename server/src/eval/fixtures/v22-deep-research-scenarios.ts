import type { BenchmarkQuestion } from '../types.js';

export const V22_DEEP_RESEARCH_SCENARIOS: BenchmarkQuestion[] = [
  // 1. Single-stock deep research
  {
    id: 'DR01',
    category: 'deep_research_planning',
    question:
      'Conduct a comprehensive investment analysis on Nvidia (NVDA). Synthesize business segment growth in Compute & Networking, DCF valuation under baseline WACC assumptions, Item 1A customer concentration risks, and define explicit thesis invalidation conditions.',
    symbols: ['NVDA'],
    expectedDocuments: [{ symbol: 'NVDA', form: '10-K' }],
    expectedSections: ['Item 1. Business', 'Item 1A. Risk Factors', 'Item 7. MD&A'],
    expectedPassageKeywords: ['Compute & Networking', 'Data Center', 'customer concentration', 'Hopper'],
    requiredFactualClaims: [
      'Compute & Networking segment growth is the primary driver of revenue expansion.',
      'Customer concentration disclosures in Item 1A indicate significant revenue comes from a limited number of cloud service providers.',
      'Explicit thesis invalidation conditions include deceleration in Data Center demand or margin compression.',
    ],
    requiredNumericalValues: [
      { metric: 'Compute & Networking revenue', value: 109842, unit: 'million USD', tolerancePercent: 5 },
    ],
    expectAbstention: false,
    split: 'eval_frozen',
  },

  // 2. Multi-stock balanced comparison
  {
    id: 'DR02',
    category: 'cross_company_comparison',
    question:
      'Compare Apple (AAPL) and Microsoft (MSFT) across services and cloud profitability, capital expenditure intensity, and valuation multiples. Ensure balanced comparative findings across both companies.',
    symbols: ['AAPL', 'MSFT'],
    expectedDocuments: [
      { symbol: 'AAPL', form: '10-K' },
      { symbol: 'MSFT', form: '10-K' },
    ],
    expectedSections: ['Item 7. MD&A', 'Item 8. Financial Statements'],
    expectedPassageKeywords: ['Services', 'Intelligent Cloud', 'capital expenditures', 'operating margin'],
    requiredFactualClaims: [
      'Both Apple Services and Microsoft Intelligent Cloud deliver high operating margins.',
      'Microsoft exhibits higher CapEx intensity due to cloud and AI infrastructure buildout.',
    ],
    expectAbstention: false,
    split: 'eval_frozen',
  },

  // 3. Conflicting SEC disclosures
  {
    id: 'DR03',
    category: 'contradiction_detection',
    question:
      "Analyze Tesla's (TSLA) automotive profitability in Form 10-K. Highlight whether vehicle delivery growth conflicts with declining automotive gross margins or reliance on automotive regulatory credits.",
    symbols: ['TSLA'],
    expectedDocuments: [{ symbol: 'TSLA', form: '10-K' }],
    expectedSections: ['Item 7. MD&A', 'Item 1A. Risk Factors'],
    expectedPassageKeywords: ['regulatory credits', 'automotive gross margin', 'average selling price'],
    requiredFactualClaims: [
      'Automotive gross margins experienced pressure due to price reductions and mix.',
      'Regulatory credits contribute material profitability to the automotive segment.',
    ],
    expectAbstention: false,
    split: 'eval_frozen',
  },

  // 4. Outdated financial data & Historical cutoff enforcement
  {
    id: 'DR04',
    category: 'historical_filing_comparison',
    question:
      "What were Nvidia's (NVDA) revenue and business segment contributions as of FY2023? Strictly do not cite or reference FY2024 or FY2025 results.",
    symbols: ['NVDA'],
    expectedDocuments: [{ symbol: 'NVDA', form: '10-K', reportPeriod: '2023-01-29' }],
    expectedSections: ['Item 7. MD&A', 'Item 8. Financial Statements'],
    expectedPassageKeywords: ['fiscal 2023', 'Graphics', 'Compute & Networking'],
    requiredFactualClaims: [
      'In fiscal 2023, total revenue was approximately $27.0 billion.',
      'Gaming and Compute & Networking were more balanced prior to the fiscal 2024-2025 generative AI acceleration.',
    ],
    requiredNumericalValues: [
      { metric: 'FY2023 Total Revenue', value: 26974, unit: 'million USD', tolerancePercent: 3 },
    ],
    expectAbstention: false,
    historicalCutoff: '2023-12-31',
    split: 'eval_frozen',
  },

  // 5. Missing documents & Autonomous on-demand ingestion
  {
    id: 'DR05',
    category: 'financial_statement_interpretation',
    question:
      "In Amazon's (AMZN) Form 10-K, what was AWS net sales and operating income, and what proportion of total company operating income did AWS represent?",
    symbols: ['AMZN'],
    expectedDocuments: [{ symbol: 'AMZN', form: '10-K' }],
    expectedSections: ['Item 7. MD&A', 'Item 8. Financial Statements'],
    expectedPassageKeywords: ['AWS', 'North America', 'International', 'operating income'],
    requiredFactualClaims: [
      'AWS is the primary driver of Amazon operating profit.',
      'AWS generates a disproportionate share of total operating income relative to its percentage of net sales.',
    ],
    expectAbstention: false,
    split: 'eval_frozen',
  },

  // 6. Contradictory management statements vs audited facts
  {
    id: 'DR06',
    category: 'contradiction_detection',
    question:
      'If an aggressive market commentary claims that NVDA has zero customer concentration and negligible debt risk, how do official Form 10-K Item 1A disclosures contradict this assertion?',
    symbols: ['NVDA'],
    expectedDocuments: [{ symbol: 'NVDA', form: '10-K' }],
    expectedSections: ['Item 1A. Risk Factors'],
    expectedPassageKeywords: ['customer concentration', 'top customer', 'cloud service provider'],
    requiredFactualClaims: [
      'Official SEC filings disclose that top customers account for a significant percentage of total revenue.',
      'Item 1A explicitly identifies customer concentration as a material risk factor.',
    ],
    expectAbstention: false,
    split: 'eval_frozen',
  },

  // 7. Unsupported investment conclusions & claim support verification
  {
    id: 'DR07',
    category: 'unsupported_abstention',
    question:
      "Does Microsoft's Form 10-K support the claim that OpenAI equity investments account for 90% of Microsoft's operating profits?",
    symbols: ['MSFT'],
    expectedDocuments: [{ symbol: 'MSFT', form: '10-K' }],
    expectedSections: ['Item 7. MD&A', 'Item 8. Financial Statements'],
    expectedPassageKeywords: ['OpenAI', 'operating income', 'Intelligent Cloud'],
    requiredFactualClaims: [
      'Official filings do not support the claim that OpenAI represents 90% of operating profit.',
      'Intelligent Cloud and Productivity segments generate the vast majority of operating income.',
    ],
    expectAbstention: true,
    split: 'eval_frozen',
  },

  // 8. Non-public entity & appropriate abstention
  {
    id: 'DR08',
    category: 'unsupported_abstention',
    question:
      'Provide audited SEC Form 10-K financial statement figures and Item 7 MD&A segment revenue breakdown for OpenAI Inc.',
    symbols: ['OPENAI'],
    expectedDocuments: [],
    expectedSections: [],
    expectedPassageKeywords: [],
    requiredFactualClaims: [
      'OpenAI is a private entity and does not file periodic Form 10-K reports with the SEC.',
      'Audited SEC financial filings are unavailable for non-public reporting entities.',
    ],
    expectAbstention: true,
    split: 'eval_frozen',
  },
];
