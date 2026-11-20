import { describe, expect, it } from 'vitest';
import {
  calculateFundamentalMetrics,
  calculateGrowth,
  calculateCAGR,
  safeDiv,
  type PeriodFinancials,
} from './fundamentals.js';
import {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateHistoricalVolatility,
  calculateTechnicalSummary,
} from './technicals.js';
import {
  calculateDCF,
  calculateRelativeValuation,
} from './valuation.js';
import {
  calculateBeta,
  calculateMaxDrawdown,
  calculateHistoricalVaR,
  calculateDownsideVolatility,
  calculateConcentrationRisk,
  calculateStockRiskSummary,
} from './risk.js';
import type { Candle } from '@tm/shared';

describe('Deterministic Analytics Engine — Fundamentals', () => {
  it('safely handles division by zero and nulls', () => {
    expect(safeDiv(10, 0)).toBeNull();
    expect(safeDiv(null, 5)).toBeNull();
    expect(safeDiv(10, null)).toBeNull();
    expect(safeDiv(10, 2)).toBe(5);
  });

  it('calculates YoY growth and CAGR correctly', () => {
    // 100 to 125 is 25% growth
    expect(calculateGrowth(125, 100)).toBeCloseTo(0.25, 4);
    // Negative prior is handled defensively via abs(prior)
    expect(calculateGrowth(-50, -100)).toBeCloseTo(0.50, 4);
    // CAGR: 100 to 133.1 over 3 years is 10%
    expect(calculateCAGR(133.1, 100, 3)).toBeCloseTo(0.10, 3);
  });

  it('computes margins, FCF, ROE, ROIC, and valuation multiples', () => {
    const annuals: PeriodFinancials[] = [
      {
        fiscalYear: 2026,
        revenue: 400_000,
        costOfGoodsSold: 220_000,
        operatingIncome: 120_000,
        netIncome: 100_000,
        operatingCashFlow: 110_000,
        capitalExpenditures: -10_000,
        currentAssets: 150_000,
        currentLiabilities: 100_000,
        totalDebt: 50_000,
        cashAndEquivalents: 30_000,
        stockholdersEquity: 200_000,
        epsDiluted: 5.0,
      },
      {
        fiscalYear: 2025,
        revenue: 350_000,
        netIncome: 80_000,
        epsDiluted: 4.0,
      },
    ];

    const metrics = calculateFundamentalMetrics(annuals, 2_000_000, 100);

    // Revenue growth: (400 - 350) / 350 = 14.285%
    expect(metrics.revenueGrowthYoY).toBeCloseTo(0.14285, 4);
    // EPS growth: (5 - 4) / 4 = 25%
    expect(metrics.epsGrowthYoY).toBeCloseTo(0.25, 4);
    // Gross Margin: (400 - 220) / 400 = 45%
    expect(metrics.grossMargin).toBeCloseTo(0.45, 4);
    // Operating Margin: 120 / 400 = 30%
    expect(metrics.operatingMargin).toBeCloseTo(0.30, 4);
    // Net Margin: 100 / 400 = 25%
    expect(metrics.netMargin).toBeCloseTo(0.25, 4);
    // Free Cash Flow: 110 - 10 = 100k
    expect(metrics.freeCashFlow).toBe(100_000);
    expect(metrics.fcfMargin).toBeCloseTo(0.25, 4);
    // ROE: 100 / 200 = 50%
    expect(metrics.roe).toBeCloseTo(0.50, 4);
    // Invested Capital: 50 + 200 - 30 = 220k. NOPAT: 120 * 0.79 = 94.8k. ROIC: 94.8 / 220 = 43.09%
    expect(metrics.roic).toBeCloseTo(94.8 / 220, 3);
    // Current Ratio: 150 / 100 = 1.5
    expect(metrics.currentRatio).toBe(1.5);
    // P/E Ratio: 2,000,000 / 100,000 = 20
    expect(metrics.peRatio).toBe(20);
    // P/S Ratio: 2,000,000 / 400,000 = 5
    expect(metrics.psRatio).toBe(5);
  });

  it('defensively flags negative equity and suppresses distorted metrics', () => {
    const annuals: PeriodFinancials[] = [
      {
        fiscalYear: 2026,
        revenue: 100_000,
        netIncome: 10_000,
        stockholdersEquity: -20_000, // Deficit equity
      },
    ];

    const metrics = calculateFundamentalMetrics(annuals);
    expect(metrics.roe).toBeNull();
    expect(metrics.debtToEquity).toBeNull();
    expect(metrics.warnings.some((w) => w.includes('Negative or zero stockholders equity'))).toBe(true);
  });
});

describe('Deterministic Analytics Engine — Technicals', () => {
  const samplePrices = [
    100, 102, 101, 103, 105, 104, 106, 108, 107, 109,
    111, 110, 112, 114, 113, 115, 117, 116, 118, 120,
    122, 121, 123, 125, 124, 126, 128, 127, 129, 131,
  ];

  it('calculates SMA and EMA properly', () => {
    const sma5 = calculateSMA(samplePrices, 5);
    // Last 5: 126, 128, 127, 129, 131 -> sum = 641, mean = 128.2
    expect(sma5).toBeCloseTo(128.2, 2);

    const ema5 = calculateEMA(samplePrices, 5);
    expect(ema5).toBeGreaterThan(120);
    expect(calculateSMA(samplePrices, 50)).toBeNull(); // Insufficient data guard
  });

  it('calculates Wilder RSI within bounds [0, 100]', () => {
    const rsi = calculateRSI(samplePrices, 14);
    expect(rsi).toBeDefined();
    expect(rsi!).toBeGreaterThanOrEqual(0);
    expect(rsi!).toBeLessThanOrEqual(100);
    // Because prices generally trended upward from 100 to 131, RSI should be elevated
    expect(rsi!).toBeGreaterThan(60);
  });

  it('calculates MACD and Bollinger Bands', () => {
    const macd = calculateMACD(samplePrices);
    expect(macd.macd).toBeDefined();

    const bb = calculateBollingerBands(samplePrices, 20, 2);
    expect(bb.upper).toBeGreaterThan(bb.middle!);
    expect(bb.middle).toBeGreaterThan(bb.lower!);
    expect(bb.bandwidth).toBeGreaterThan(0);
  });

  it('calculates ATR from candle series', () => {
    const candles: Candle[] = samplePrices.map((p, idx) => ({
      time: 1700000000 + idx * 86400,
      open: p - 1,
      high: p + 2,
      low: p - 2,
      close: p,
      volume: 1000,
    }));

    const atr = calculateATR(candles, 14);
    expect(atr).toBeDefined();
    expect(atr!).toBeGreaterThan(0);
  });

  it('calculates technical summary with trend determination', () => {
    const candles: Candle[] = samplePrices.map((p, idx) => ({
      time: 1700000000 + idx * 86400,
      open: p - 0.5,
      high: p + 1.5,
      low: p - 1.5,
      close: p,
      volume: 50000,
    }));

    const summary = calculateTechnicalSummary(candles);
    expect(summary.price).toBe(131);
    expect(summary.sma20).toBeDefined();
    expect(summary.rsi14).toBeDefined();
    expect(summary.trend).toBe('bullish');
  });
});

describe('Deterministic Analytics Engine — Valuation', () => {
  it('computes 3-scenario DCF and checks upside/downside', () => {
    const currentPrice = 150;
    const baseFCF = 10_000_000;
    const sharesOutstanding = 1_000_000; // 10 per share base FCF
    const netDebt = 0;

    const dcf = calculateDCF(currentPrice, baseFCF, sharesOutstanding, netDebt, {
      growthRate5Y: 0.10,
      terminalGrowthRate: 0.025,
      wacc: 0.09,
    });

    expect(dcf.scenarios.base.fairValuePerShare).toBeGreaterThan(0);
    expect(dcf.scenarios.bull.fairValuePerShare!).toBeGreaterThan(dcf.scenarios.base.fairValuePerShare!);
    expect(dcf.scenarios.base.fairValuePerShare!).toBeGreaterThan(dcf.scenarios.bear.fairValuePerShare!);
    expect(dcf.sensitivityMatrix.length).toBe(5);
    expect(dcf.sensitivityMatrix[0].length).toBe(4);
  });

  it('computes Relative Valuation across multiple multiples', () => {
    const rel = calculateRelativeValuation(
      100, // currentPrice
      5, // eps (P/E = 20)
      20, // revPerShare (P/S = 5)
      25, // bookValuePerShare (P/B = 4)
      6, // fcfPerShare (P/FCF = 16.6)
      {
        pe: 25, // Peer PE benchmark
        ps: 6, // Peer PS benchmark
        pb: 5, // Peer PB benchmark
      },
    );

    expect(rel.metrics.length).toBe(3);
    // Implied by PE: 5 * 25 = 125
    const peMetric = rel.metrics.find((m) => m.metric === 'PE');
    expect(peMetric?.impliedSharePrice).toBe(125);
    expect(peMetric?.discountOrPremiumPercent).toBe(25);
    expect(rel.averageImpliedPrice).toBeGreaterThan(100);
  });
});

describe('Deterministic Analytics Engine — Risk Management', () => {
  const stockPrices = [100, 102, 101, 105, 103, 108, 112, 110, 106, 104, 109, 114, 118, 115, 112, 116, 120, 122, 119, 125];
  const benchmarkPrices = [200, 202, 201, 204, 203, 206, 208, 207, 205, 204, 207, 209, 212, 210, 209, 211, 213, 214, 213, 216];

  it('computes Beta, Drawdown, and VaR accurately', () => {
    const risk = calculateStockRiskSummary(stockPrices, benchmarkPrices);

    expect(risk.beta).toBeDefined();
    expect(risk.beta!).toBeGreaterThan(0);
    expect(risk.maxDrawdown).toBeDefined();
    expect(risk.maxDrawdown!.maxDrawdown).toBeLessThan(0); // Peak 112 to 104 is ~ -7.1%
    expect(risk.var95).toBeDefined();
    expect(risk.var95!.historicalVaR).toBeLessThan(0);
    expect(risk.var95!.expectedShortfall).toBeLessThanOrEqual(risk.var95!.historicalVaR);
  });

  it('evaluates portfolio concentration risk with HHI', () => {
    // Highly concentrated portfolio: 70% AAPL, 20% MSFT, 10% GOOG
    const highConc = calculateConcentrationRisk([0.7, 0.2, 0.1]);
    expect(highConc.level).toBe('high');
    expect(highConc.hhi).toBe(4900 + 400 + 100); // 5400

    // Diversified portfolio: 10 stocks at 10% each
    const lowConc = calculateConcentrationRisk([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    expect(lowConc.level).toBe('low');
    expect(lowConc.hhi).toBe(1000);
  });
});
