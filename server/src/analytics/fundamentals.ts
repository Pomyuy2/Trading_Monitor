/**
 * Deterministic Fundamental Analysis Calculations.
 * All functions handle nulls, zeros, negative denominators, and insufficient periods defensively.
 */

export interface PeriodFinancials {
  fiscalYear: number;
  fiscalPeriod?: string; // 'FY', 'Q1', 'Q2', 'Q3', 'Q4'
  endDate?: string;
  revenue?: number | null;
  netIncome?: number | null;
  operatingIncome?: number | null;
  grossProfit?: number | null;
  costOfGoodsSold?: number | null;
  operatingCashFlow?: number | null;
  capitalExpenditures?: number | null;
  freeCashFlow?: number | null;
  totalAssets?: number | null;
  currentAssets?: number | null;
  cashAndEquivalents?: number | null;
  marketableSecurities?: number | null;
  accountsReceivable?: number | null;
  totalLiabilities?: number | null;
  currentLiabilities?: number | null;
  totalDebt?: number | null;
  stockholdersEquity?: number | null;
  interestExpense?: number | null;
  ebit?: number | null;
  ebitda?: number | null;
  epsDiluted?: number | null;
  sharesDiluted?: number | null;
}

export interface FundamentalMetrics {
  // Growth
  revenueGrowthYoY: number | null;
  revenueCAGR3Y: number | null;
  netIncomeGrowthYoY: number | null;
  epsGrowthYoY: number | null;

  // Margins
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  fcfMargin: number | null;

  // Free Cash Flow
  freeCashFlow: number | null;

  // Returns
  roe: number | null;
  roic: number | null;
  roa: number | null;

  // Liquidity & Solvency
  currentRatio: number | null;
  quickRatio: number | null;
  debtToEquity: number | null;
  interestCoverage: number | null;

  // Valuation Multiples (when market price & market cap provided)
  peRatio: number | null;
  psRatio: number | null;
  pbRatio: number | null;
  pToFcfRatio: number | null;
  evToEbitda: number | null;
  evToSales: number | null;

  // Metadata & Warnings
  warnings: string[];
}

/** Safe division preventing division by zero or negative where disallowed. */
export function safeDiv(num: number | null | undefined, den: number | null | undefined): number | null {
  if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return null;
  }
  const res = num / den;
  return Number.isFinite(res) ? res : null;
}

/** Safe percentage growth (current - prior) / abs(prior). */
export function calculateGrowth(current: number | null | undefined, prior: number | null | undefined): number | null {
  if (current == null || prior == null || prior === 0 || !Number.isFinite(current) || !Number.isFinite(prior)) {
    return null;
  }
  return (current - prior) / Math.abs(prior);
}

/** Safe CAGR calculation: (valN / val0) ^ (1 / n) - 1. */
export function calculateCAGR(valN: number | null | undefined, val0: number | null | undefined, years: number): number | null {
  if (valN == null || val0 == null || val0 <= 0 || valN <= 0 || years <= 0 || !Number.isFinite(valN) || !Number.isFinite(val0)) {
    return null;
  }
  return Math.pow(valN / val0, 1 / years) - 1;
}

/**
 * Calculates comprehensive fundamental metrics given sorted annual financials (newest first).
 */
export function calculateFundamentalMetrics(
  annuals: PeriodFinancials[],
  marketCap?: number | null,
  sharePrice?: number | null,
): FundamentalMetrics {
  const warnings: string[] = [];
  if (!annuals || annuals.length === 0) {
    return {
      revenueGrowthYoY: null,
      revenueCAGR3Y: null,
      netIncomeGrowthYoY: null,
      epsGrowthYoY: null,
      grossMargin: null,
      operatingMargin: null,
      netMargin: null,
      fcfMargin: null,
      freeCashFlow: null,
      roe: null,
      roic: null,
      roa: null,
      currentRatio: null,
      quickRatio: null,
      debtToEquity: null,
      interestCoverage: null,
      peRatio: null,
      psRatio: null,
      pbRatio: null,
      pToFcfRatio: null,
      evToEbitda: null,
      evToSales: null,
      warnings: ['No financial periods provided'],
    };
  }

  const latest = annuals[0];
  const prior = annuals.length > 1 ? annuals[1] : null;
  const threeYearsAgo = annuals.length >= 4 ? annuals[3] : annuals.length >= 3 ? annuals[2] : null;

  // 1. Growth Metrics
  const revenueGrowthYoY = prior ? calculateGrowth(latest.revenue, prior.revenue) : null;
  const netIncomeGrowthYoY = prior ? calculateGrowth(latest.netIncome, prior.netIncome) : null;
  const epsGrowthYoY = prior ? calculateGrowth(latest.epsDiluted, prior.epsDiluted) : null;
  const cagrYears = annuals.length >= 4 ? 3 : annuals.length >= 3 ? 2 : 0;
  const revenueCAGR3Y = threeYearsAgo && cagrYears > 0 ? calculateCAGR(latest.revenue, threeYearsAgo.revenue, cagrYears) : null;

  // 2. Margins
  const rev = latest.revenue;
  const grossProfit = latest.grossProfit ?? (rev != null && latest.costOfGoodsSold != null ? rev - latest.costOfGoodsSold : null);
  const grossMargin = safeDiv(grossProfit, rev);
  const operatingMargin = safeDiv(latest.operatingIncome ?? latest.ebit, rev);
  const netMargin = safeDiv(latest.netIncome, rev);

  // 3. Free Cash Flow
  let freeCashFlow: number | null = null;
  if (latest.operatingCashFlow != null) {
    const capex = latest.capitalExpenditures != null ? Math.abs(latest.capitalExpenditures) : 0;
    freeCashFlow = latest.operatingCashFlow - capex;
  } else if (latest.freeCashFlow != null) {
    freeCashFlow = latest.freeCashFlow;
  }
  const fcfMargin = safeDiv(freeCashFlow, rev);

  // 4. Returns
  const equity = latest.stockholdersEquity;
  if (equity != null && equity <= 0) {
    warnings.push('Negative or zero stockholders equity; ROE and D/E distorted or invalid');
  }
  const roe = equity != null && equity > 0 ? safeDiv(latest.netIncome, equity) : null;
  const roa = safeDiv(latest.netIncome, latest.totalAssets);

  // Invested Capital for ROIC: Total Debt + Stockholders Equity - Cash
  let roic: number | null = null;
  const debt = latest.totalDebt ?? 0;
  const cash = latest.cashAndEquivalents ?? 0;
  if (equity != null && equity > 0) {
    const investedCapital = debt + equity - cash;
    if (investedCapital > 0) {
      // NOPAT approximated as Operating Income * (1 - 21% US statutory tax) or Net Income + after-tax interest
      const ebit = latest.ebit ?? latest.operatingIncome;
      const nopat = ebit != null ? ebit * 0.79 : latest.netIncome;
      roic = safeDiv(nopat, investedCapital);
    } else {
      warnings.push('Invested capital is non-positive; ROIC calculation suppressed');
    }
  }

  // 5. Liquidity & Solvency
  const currentRatio = safeDiv(latest.currentAssets, latest.currentLiabilities);
  const liquidCash = (latest.cashAndEquivalents ?? 0) + (latest.marketableSecurities ?? 0) + (latest.accountsReceivable ?? 0);
  const quickRatio = latest.currentLiabilities ? safeDiv(liquidCash, latest.currentLiabilities) : null;
  const debtToEquity = equity != null && equity > 0 ? safeDiv(latest.totalDebt, equity) : null;
  const interestExpense = latest.interestExpense != null ? Math.abs(latest.interestExpense) : null;
  const ebitForCoverage = latest.ebit ?? latest.operatingIncome;
  const interestCoverage = safeDiv(ebitForCoverage, interestExpense);

  // 6. Valuation Multiples
  let peRatio: number | null = null;
  let psRatio: number | null = null;
  let pbRatio: number | null = null;
  let pToFcfRatio: number | null = null;
  let evToEbitda: number | null = null;
  let evToSales: number | null = null;

  if (marketCap != null && marketCap > 0) {
    psRatio = safeDiv(marketCap, rev);
    if (equity != null && equity > 0) {
      pbRatio = safeDiv(marketCap, equity);
    }
    if (freeCashFlow != null && freeCashFlow > 0) {
      pToFcfRatio = safeDiv(marketCap, freeCashFlow);
    }
    if (latest.netIncome != null && latest.netIncome > 0) {
      peRatio = safeDiv(marketCap, latest.netIncome);
    }

    // Enterprise Value = Market Cap + Debt - Cash
    const ev = marketCap + (latest.totalDebt ?? 0) - (latest.cashAndEquivalents ?? 0);
    if (ev > 0) {
      evToSales = safeDiv(ev, rev);
      const ebitda = latest.ebitda ?? (latest.operatingIncome != null ? latest.operatingIncome * 1.15 : null);
      if (ebitda != null && ebitda > 0) {
        evToEbitda = safeDiv(ev, ebitda);
      }
    }
  } else if (sharePrice != null && sharePrice > 0 && latest.epsDiluted != null && latest.epsDiluted > 0) {
    peRatio = safeDiv(sharePrice, latest.epsDiluted);
  }

  return {
    revenueGrowthYoY,
    revenueCAGR3Y,
    netIncomeGrowthYoY,
    epsGrowthYoY,
    grossMargin,
    operatingMargin,
    netMargin,
    fcfMargin,
    freeCashFlow,
    roe,
    roic,
    roa,
    currentRatio,
    quickRatio,
    debtToEquity,
    interestCoverage,
    peRatio,
    psRatio,
    pbRatio,
    pToFcfRatio,
    evToEbitda,
    evToSales,
    warnings,
  };
}
