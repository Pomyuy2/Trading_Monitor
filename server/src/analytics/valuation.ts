/**
 * Deterministic Valuation Engine.
 * Supports multi-scenario DCF (Bull/Base/Bear), WACC sensitivity matrices, and relative valuation.
 */

export interface DcfScenarioOptions {
  growthRate5Y: number; // e.g. 0.10 for 10% annual FCF growth
  terminalGrowthRate: number; // e.g. 0.025 for 2.5%
  wacc: number; // e.g. 0.09 for 9.0% discount rate
}

export interface DcfScenarioResult {
  scenario: 'bull' | 'base' | 'bear';
  assumptions: DcfScenarioOptions;
  projectedFCF: number[]; // 5-year projected FCFs
  presentValueFCF: number; // Sum of discounted FCFs
  terminalValue: number;
  presentValueTerminalValue: number;
  enterpriseValue: number;
  equityValue: number;
  fairValuePerShare: number | null;
  upsideDownsidePercent: number | null;
}

export interface SensitivityMatrixCell {
  wacc: number;
  terminalGrowth: number;
  impliedSharePrice: number | null;
}

export interface DcfValuationSummary {
  currentPrice: number;
  sharesOutstanding: number;
  baseFCF: number;
  netDebt: number; // Total Debt - Cash
  scenarios: {
    bull: DcfScenarioResult;
    base: DcfScenarioResult;
    bear: DcfScenarioResult;
  };
  sensitivityMatrix: SensitivityMatrixCell[][]; // rows: WACC, cols: terminalGrowth
  warnings: string[];
}

export interface RelativeValuationMetric {
  metric: 'PE' | 'PS' | 'PB' | 'EV_EBITDA' | 'P_FCF';
  companyValue: number | null;
  peerOrHistoricalBenchmark: number;
  impliedSharePrice: number | null;
  discountOrPremiumPercent: number | null;
}

export interface RelativeValuationSummary {
  currentPrice: number;
  metrics: RelativeValuationMetric[];
  averageImpliedPrice: number | null;
  upsideDownsidePercent: number | null;
}

/**
 * Calculates a single DCF scenario.
 */
export function calculateDcfScenario(
  scenario: 'bull' | 'base' | 'bear',
  baseFCF: number,
  options: DcfScenarioOptions,
  netDebt: number,
  sharesOutstanding: number,
  currentPrice: number,
): DcfScenarioResult {
  const { growthRate5Y, terminalGrowthRate, wacc } = options;
  const projectedFCF: number[] = [];
  let pvFCF = 0;

  // 5-Year Forecast
  let currentFCF = baseFCF;
  for (let t = 1; t <= 5; t++) {
    currentFCF = currentFCF * (1 + growthRate5Y);
    projectedFCF.push(+currentFCF.toFixed(0));
    const discountFactor = Math.pow(1 + wacc, t);
    pvFCF += currentFCF / discountFactor;
  }

  // Terminal Value (Gordon Growth Model)
  let terminalValue = 0;
  let pvTV = 0;
  if (wacc > terminalGrowthRate) {
    const fcfYear6 = currentFCF * (1 + terminalGrowthRate);
    terminalValue = fcfYear6 / (wacc - terminalGrowthRate);
    pvTV = terminalValue / Math.pow(1 + wacc, 5);
  }

  const enterpriseValue = pvFCF + pvTV;
  // Equity Value = Enterprise Value - Net Debt (Cash increases equity value, debt decreases it)
  const equityValue = enterpriseValue - netDebt;
  const fairValuePerShare = sharesOutstanding > 0 && equityValue > 0 ? +(equityValue / sharesOutstanding).toFixed(2) : null;
  const upsideDownsidePercent =
    fairValuePerShare != null && currentPrice > 0
      ? +(((fairValuePerShare - currentPrice) / currentPrice) * 100).toFixed(2)
      : null;

  return {
    scenario,
    assumptions: options,
    projectedFCF,
    presentValueFCF: +pvFCF.toFixed(0),
    terminalValue: +terminalValue.toFixed(0),
    presentValueTerminalValue: +pvTV.toFixed(0),
    enterpriseValue: +enterpriseValue.toFixed(0),
    equityValue: +equityValue.toFixed(0),
    fairValuePerShare,
    upsideDownsidePercent,
  };
}

/**
 * Calculates full 3-scenario DCF and WACC/Terminal Growth sensitivity table.
 */
export function calculateDCF(
  currentPrice: number,
  baseFCF: number,
  sharesOutstanding: number,
  netDebt: number,
  customBaseOptions?: Partial<DcfScenarioOptions>,
): DcfValuationSummary {
  const warnings: string[] = [];

  if (baseFCF <= 0) {
    warnings.push('Base Free Cash Flow is zero or negative; DCF assumes normalized FCF');
  }
  if (sharesOutstanding <= 0) {
    warnings.push('Shares outstanding count is non-positive; share price calculation restricted');
  }

  const baseWacc = customBaseOptions?.wacc ?? 0.09;
  const baseGrowth = customBaseOptions?.growthRate5Y ?? 0.10;
  const baseTerminalGrowth = customBaseOptions?.terminalGrowthRate ?? 0.025;

  const baseOptions: DcfScenarioOptions = {
    wacc: baseWacc,
    growthRate5Y: baseGrowth,
    terminalGrowthRate: baseTerminalGrowth,
  };

  const bullOptions: DcfScenarioOptions = {
    wacc: Math.max(0.06, baseWacc - 0.015),
    growthRate5Y: baseGrowth + 0.05,
    terminalGrowthRate: Math.min(0.04, baseTerminalGrowth + 0.005),
  };

  const bearOptions: DcfScenarioOptions = {
    wacc: baseWacc + 0.015,
    growthRate5Y: Math.max(-0.05, baseGrowth - 0.05),
    terminalGrowthRate: Math.max(0.01, baseTerminalGrowth - 0.005),
  };

  const baseScenario = calculateDcfScenario('base', baseFCF, baseOptions, netDebt, sharesOutstanding, currentPrice);
  const bullScenario = calculateDcfScenario('bull', baseFCF, bullOptions, netDebt, sharesOutstanding, currentPrice);
  const bearScenario = calculateDcfScenario('bear', baseFCF, bearOptions, netDebt, sharesOutstanding, currentPrice);

  // Sensitivity Matrix: 5 WACC steps x 4 Terminal Growth steps
  const waccSteps = [baseWacc - 0.02, baseWacc - 0.01, baseWacc, baseWacc + 0.01, baseWacc + 0.02];
  const terminalSteps = [
    Math.max(0.01, baseTerminalGrowth - 0.01),
    baseTerminalGrowth - 0.005,
    baseTerminalGrowth,
    baseTerminalGrowth + 0.005,
  ];

  const sensitivityMatrix: SensitivityMatrixCell[][] = [];
  for (const w of waccSteps) {
    const row: SensitivityMatrixCell[] = [];
    for (const g of terminalSteps) {
      if (w <= g) {
        row.push({ wacc: +w.toFixed(3), terminalGrowth: +g.toFixed(3), impliedSharePrice: null });
        continue;
      }
      const res = calculateDcfScenario(
        'base',
        baseFCF,
        { wacc: w, growthRate5Y: baseGrowth, terminalGrowthRate: g },
        netDebt,
        sharesOutstanding,
        currentPrice,
      );
      row.push({
        wacc: +w.toFixed(3),
        terminalGrowth: +g.toFixed(3),
        impliedSharePrice: res.fairValuePerShare,
      });
    }
    sensitivityMatrix.push(row);
  }

  return {
    currentPrice,
    sharesOutstanding,
    baseFCF,
    netDebt,
    scenarios: {
      bull: bullScenario,
      base: baseScenario,
      bear: bearScenario,
    },
    sensitivityMatrix,
    warnings,
  };
}

/**
 * Calculates Relative Valuation against peer or sector benchmark multiples.
 */
export function calculateRelativeValuation(
  currentPrice: number,
  eps: number | null,
  revenuePerShare: number | null,
  bookValuePerShare: number | null,
  fcfPerShare: number | null,
  benchmarks: {
    pe?: number;
    ps?: number;
    pb?: number;
    pFcf?: number;
  },
): RelativeValuationSummary {
  const metrics: RelativeValuationMetric[] = [];

  if (eps != null && eps > 0 && benchmarks.pe != null && benchmarks.pe > 0) {
    const implied = +(eps * benchmarks.pe).toFixed(2);
    const diff = +(((implied - currentPrice) / currentPrice) * 100).toFixed(2);
    metrics.push({
      metric: 'PE',
      companyValue: +(currentPrice / eps).toFixed(2),
      peerOrHistoricalBenchmark: benchmarks.pe,
      impliedSharePrice: implied,
      discountOrPremiumPercent: diff,
    });
  }

  if (revenuePerShare != null && revenuePerShare > 0 && benchmarks.ps != null && benchmarks.ps > 0) {
    const implied = +(revenuePerShare * benchmarks.ps).toFixed(2);
    const diff = +(((implied - currentPrice) / currentPrice) * 100).toFixed(2);
    metrics.push({
      metric: 'PS',
      companyValue: +(currentPrice / revenuePerShare).toFixed(2),
      peerOrHistoricalBenchmark: benchmarks.ps,
      impliedSharePrice: implied,
      discountOrPremiumPercent: diff,
    });
  }

  if (bookValuePerShare != null && bookValuePerShare > 0 && benchmarks.pb != null && benchmarks.pb > 0) {
    const implied = +(bookValuePerShare * benchmarks.pb).toFixed(2);
    const diff = +(((implied - currentPrice) / currentPrice) * 100).toFixed(2);
    metrics.push({
      metric: 'PB',
      companyValue: +(currentPrice / bookValuePerShare).toFixed(2),
      peerOrHistoricalBenchmark: benchmarks.pb,
      impliedSharePrice: implied,
      discountOrPremiumPercent: diff,
    });
  }

  if (fcfPerShare != null && fcfPerShare > 0 && benchmarks.pFcf != null && benchmarks.pFcf > 0) {
    const implied = +(fcfPerShare * benchmarks.pFcf).toFixed(2);
    const diff = +(((implied - currentPrice) / currentPrice) * 100).toFixed(2);
    metrics.push({
      metric: 'P_FCF',
      companyValue: +(currentPrice / fcfPerShare).toFixed(2),
      peerOrHistoricalBenchmark: benchmarks.pFcf,
      impliedSharePrice: implied,
      discountOrPremiumPercent: diff,
    });
  }

  const validPrices = metrics.map((m) => m.impliedSharePrice).filter((p): p is number => p != null);
  const averageImpliedPrice =
    validPrices.length > 0 ? +(validPrices.reduce((a, b) => a + b, 0) / validPrices.length).toFixed(2) : null;
  const upsideDownsidePercent =
    averageImpliedPrice != null && currentPrice > 0
      ? +(((averageImpliedPrice - currentPrice) / currentPrice) * 100).toFixed(2)
      : null;

  return {
    currentPrice,
    metrics,
    averageImpliedPrice,
    upsideDownsidePercent,
  };
}
