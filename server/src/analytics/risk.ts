/**
 * Deterministic Risk Management Engine.
 * Calculates Beta, Max Drawdown, Historical VaR, Expected Shortfall (CVaR),
 * Downside Volatility, and Portfolio Concentration Risk.
 */

export interface MaxDrawdownResult {
  maxDrawdown: number; // e.g. -0.245 for -24.5%
  peakIndex: number;
  troughIndex: number;
  peakPrice: number;
  troughPrice: number;
}

export interface VarResult {
  confidence: number; // 0.95 or 0.99
  historicalVaR: number; // e.g. -0.035 for -3.5% 1-day VaR
  expectedShortfall: number; // e.g. -0.052 for -5.2% CVaR
}

export interface ConcentrationRiskResult {
  hhi: number; // 0 to 10,000 (Herfindahl-Hirschman Index)
  maxPositionWeight: number; // 0 to 1
  top3Concentration: number; // 0 to 1
  level: 'low' | 'moderate' | 'high';
}

export interface StockRiskSummary {
  beta: number | null; // Relative to benchmark
  annualizedVolatility: number | null;
  downsideVolatility: number | null;
  maxDrawdown: MaxDrawdownResult | null;
  var95: VarResult | null;
  var99: VarResult | null;
  riskRating: 'low' | 'moderate' | 'high' | 'very_high';
  warnings: string[];
}

/** Calculates daily percentage returns from price series: (p_t - p_{t-1}) / p_{t-1}. */
export function calculateReturns(prices: number[]): number[] {
  if (!prices || prices.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  return returns;
}

/**
 * Calculates Beta = Cov(asset, benchmark) / Var(benchmark).
 */
export function calculateBeta(assetReturns: number[], benchmarkReturns: number[]): number | null {
  const len = Math.min(assetReturns.length, benchmarkReturns.length);
  if (len < 10) return null;

  const a = assetReturns.slice(-len);
  const b = benchmarkReturns.slice(-len);

  const meanA = a.reduce((sum, v) => sum + v, 0) / len;
  const meanB = b.reduce((sum, v) => sum + v, 0) / len;

  let cov = 0;
  let varB = 0;

  for (let i = 0; i < len; i++) {
    const diffA = a[i] - meanA;
    const diffB = b[i] - meanB;
    cov += diffA * diffB;
    varB += diffB * diffB;
  }

  if (varB === 0) return null;
  return +(cov / varB).toFixed(2);
}

/**
 * Calculates Maximum Drawdown over a price series.
 */
export function calculateMaxDrawdown(prices: number[]): MaxDrawdownResult | null {
  if (!prices || prices.length < 2) return null;

  let maxDd = 0;
  let peak = prices[0];
  let peakIdx = 0;
  let troughIdx = 0;
  let currentPeakIdx = 0;

  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    if (p > peak) {
      peak = p;
      currentPeakIdx = i;
    } else {
      const dd = (p - peak) / peak;
      if (dd < maxDd) {
        maxDd = dd;
        peakIdx = currentPeakIdx;
        troughIdx = i;
      }
    }
  }

  return {
    maxDrawdown: +maxDd.toFixed(4),
    peakIndex: peakIdx,
    troughIndex: troughIdx,
    peakPrice: prices[peakIdx],
    troughPrice: prices[troughIdx],
  };
}

/**
 * Calculates Historical Value-at-Risk (VaR) and Expected Shortfall (CVaR)
 * at the given confidence level (e.g. 0.95 or 0.99).
 */
export function calculateHistoricalVaR(returns: number[], confidence = 0.95): VarResult | null {
  if (!returns || returns.length < 10) return null;

  const sorted = [...returns].sort((a, b) => a - b);
  // For 95% confidence, look at the bottom 5% of returns
  const alpha = 1 - confidence;
  const cutoffIndex = Math.max(0, Math.floor(sorted.length * alpha));
  const varVal = sorted[cutoffIndex];

  // Expected Shortfall: average of returns below or equal to VaR
  const tailReturns = sorted.slice(0, cutoffIndex + 1);
  const esVal = tailReturns.length > 0 ? tailReturns.reduce((a, b) => a + b, 0) / tailReturns.length : varVal;

  return {
    confidence,
    historicalVaR: +varVal.toFixed(4),
    expectedShortfall: +esVal.toFixed(4),
  };
}

/**
 * Calculates Downside Volatility (semi-deviation below target return).
 */
export function calculateDownsideVolatility(
  returns: number[],
  targetReturn = 0,
  annualizeDays = 252,
): number | null {
  if (!returns || returns.length < 10) return null;

  const downsideDiffs: number[] = [];
  for (const r of returns) {
    if (r < targetReturn) {
      downsideDiffs.push(Math.pow(r - targetReturn, 2));
    } else {
      downsideDiffs.push(0);
    }
  }

  const meanSquareDiff = downsideDiffs.reduce((a, b) => a + b, 0) / returns.length;
  const dailyDownside = Math.sqrt(meanSquareDiff);
  return +(dailyDownside * Math.sqrt(annualizeDays)).toFixed(4);
}

/**
 * Calculates Concentration Risk metrics for portfolio asset weights.
 * @param weights Array of decimal weights summing to ~1.0 (e.g. [0.4, 0.3, 0.2, 0.1])
 */
export function calculateConcentrationRisk(weights: number[]): ConcentrationRiskResult {
  if (!weights || weights.length === 0) {
    return { hhi: 10000, maxPositionWeight: 1, top3Concentration: 1, level: 'high' };
  }

  // Normalize weights in case sum != 1
  const total = weights.reduce((a, b) => a + b, 0);
  const normalized = total > 0 ? weights.map((w) => w / total) : weights;
  const sorted = [...normalized].sort((a, b) => b - a);

  // HHI is calculated on percentages (0-100) -> 0 to 10,000 scale
  const hhi = Math.round(sorted.reduce((acc, w) => acc + Math.pow(w * 100, 2), 0));
  const maxPositionWeight = +sorted[0].toFixed(4);
  const top3Concentration = +(sorted.slice(0, 3).reduce((a, b) => a + b, 0)).toFixed(4);

  let level: 'low' | 'moderate' | 'high' = 'low';
  if (hhi > 2500 || maxPositionWeight > 0.35) {
    level = 'high';
  } else if (hhi > 1500 || maxPositionWeight > 0.20) {
    level = 'moderate';
  }

  return {
    hhi,
    maxPositionWeight,
    top3Concentration,
    level,
  };
}

/**
 * Compiles a comprehensive risk summary for a single stock.
 */
export function calculateStockRiskSummary(
  prices: number[],
  benchmarkPrices?: number[],
): StockRiskSummary {
  const warnings: string[] = [];
  if (!prices || prices.length < 15) {
    return {
      beta: null,
      annualizedVolatility: null,
      downsideVolatility: null,
      maxDrawdown: null,
      var95: null,
      var99: null,
      riskRating: 'moderate',
      warnings: ['Insufficient historical observations for risk metrics'],
    };
  }

  const returns = calculateReturns(prices);
  const benchmarkReturns = benchmarkPrices ? calculateReturns(benchmarkPrices) : [];

  const beta = benchmarkReturns.length >= 10 ? calculateBeta(returns, benchmarkReturns) : null;
  const maxDrawdown = calculateMaxDrawdown(prices);
  const var95 = calculateHistoricalVaR(returns, 0.95);
  const var99 = calculateHistoricalVaR(returns, 0.99);
  const downsideVolatility = calculateDownsideVolatility(returns, 0);

  // Annualized Volatility
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1);
  const annualizedVolatility = +(Math.sqrt(variance) * Math.sqrt(252)).toFixed(4);

  // Overall Risk Rating
  let riskRating: 'low' | 'moderate' | 'high' | 'very_high' = 'moderate';
  if (annualizedVolatility > 0.50 || (maxDrawdown && maxDrawdown.maxDrawdown < -0.45)) {
    riskRating = 'very_high';
  } else if (annualizedVolatility > 0.30 || (maxDrawdown && maxDrawdown.maxDrawdown < -0.30) || (beta && beta > 1.4)) {
    riskRating = 'high';
  } else if (annualizedVolatility < 0.18 && (beta == null || beta < 0.9)) {
    riskRating = 'low';
  }

  return {
    beta,
    annualizedVolatility,
    downsideVolatility,
    maxDrawdown,
    var95,
    var99,
    riskRating,
    warnings,
  };
}
