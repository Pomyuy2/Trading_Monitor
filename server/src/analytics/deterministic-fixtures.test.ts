import { describe, expect, it } from 'vitest';
import { calculateDcfScenario, calculateDCF } from './valuation.js';
import {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
} from './technicals.js';
import {
  calculateBeta,
  calculateMaxDrawdown,
  calculateHistoricalVaR,
  calculateConcentrationRisk,
} from './risk.js';
import type { Candle } from '@tm/shared';

describe('Acceptance Test 4: Financial Calculations Deterministic Reference Fixtures', () => {
  // 1. DCF Reference Fixture
  it('Fixture 1: DCF matches hand-calculated ground truth to within $0.05 per share', () => {
    // Ground truth: FCF = 100M, Shares = 10M, Net Debt = 0, Growth = 8%, WACC = 10%, Terminal = 2.5%
    // PV(FCF 1..5) = 473.395M, TV = 2008.082M, PV(TV) = 1246.878M, Equity = 1720.273M -> $172.03 / share
    const res = calculateDcfScenario(
      'base',
      100_000_000,
      { growthRate5Y: 0.08, terminalGrowthRate: 0.025, wacc: 0.10 },
      0, // net debt
      10_000_000, // shares
      100, // current price
    );

    expect(res.fairValuePerShare).toBeCloseTo(172.03, 1);
    expect(res.upsideDownsidePercent).toBeCloseTo(72.03, 1);
  });

  // 2. Wilder's RSI (14) Reference Fixture
  it('Fixture 2: RSI boundary and symmetry fixtures', () => {
    // 15 prices strictly increasing: RSI must be 100
    const risingPrices = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    expect(calculateRSI(risingPrices, 14)).toBe(100);

    // 15 prices strictly decreasing: RSI must be 0
    const fallingPrices = Array.from({ length: 20 }, (_, i) => 100 - i * 2);
    expect(calculateRSI(fallingPrices, 14)).toBe(0);

    // Symmetric alternating prices (+2, -2, +2, -2...): RSI must be near 50
    const alternating = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 2 : 0));
    const rsiAlt = calculateRSI(alternating, 14);
    expect(rsiAlt).toBeDefined();
    expect(rsiAlt!).toBeGreaterThan(45);
    expect(rsiAlt!).toBeLessThan(55);
  });

  // 3. MACD Reference Fixture
  it('Fixture 3: MACD flat baseline fixture', () => {
    // 35 identical prices: MACD line and Signal line must be identically 0
    const flatPrices = Array.from({ length: 35 }, () => 150);
    const macd = calculateMACD(flatPrices);
    expect(macd.macd).toBe(0);
    expect(macd.signal).toBe(0);
    expect(macd.histogram).toBe(0);
  });

  // 4. Bollinger Bands (20, 2) Reference Fixture
  it('Fixture 4: Bollinger Bands flat and step fixtures', () => {
    // 20 identical prices: StdDev = 0, Upper = Lower = Middle = 100
    const flat = Array.from({ length: 20 }, () => 100);
    const bbFlat = calculateBollingerBands(flat, 20, 2);
    expect(bbFlat.middle).toBe(100);
    expect(bbFlat.upper).toBe(100);
    expect(bbFlat.lower).toBe(100);
    expect(bbFlat.bandwidth).toBe(0);

    // 10 prices at 90 and 10 prices at 110: Mean = 100, Population StdDev = sqrt(2000/20) = 10
    const step = [...Array(10).fill(90), ...Array(10).fill(110)];
    const bbStep = calculateBollingerBands(step, 20, 2);
    expect(bbStep.middle).toBe(100);
    expect(bbStep.upper).toBe(120);
    expect(bbStep.lower).toBe(80);
  });

  // 5. ATR (14) Reference Fixture
  it('Fixture 5: ATR constant true range fixture', () => {
    // 20 candles with High = 105, Low = 95, Close = 100 (True Range = 10)
    const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: 1700000000 + i * 86400,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 1000,
    }));
    const atr = calculateATR(candles, 14);
    expect(atr).toBe(10);
  });

  // 6. ADX (14) Reference Fixture
  it('Fixture 6: ADX trend strength fixture', () => {
    // Strongly trending candle series: each day higher high and higher low (+3 high, +3 low)
    const strongTrend: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      time: 1700000000 + i * 86400,
      open: 100 + i * 3,
      high: 105 + i * 3,
      low: 98 + i * 3,
      close: 103 + i * 3,
      volume: 10000,
    }));
    const adx = calculateADX(strongTrend, 14);
    expect(adx.adx).toBeDefined();
    // Strong trend should yield high ADX (> 25 is trending)
    expect(adx.adx!).toBeGreaterThan(30);
    // In strong uptrend, +DI must dominate -DI
    expect(adx.plusDI!).toBeGreaterThan(adx.minusDI!);
  });

  // 7. Beta Reference Fixture
  it('Fixture 7: Beta proportionality fixture', () => {
    const benchReturns = [0.01, -0.02, 0.015, -0.01, 0.03, -0.025, 0.02, -0.005, 0.012, -0.018];
    // Asset with exact 2x leverage
    const leveragedReturns = benchReturns.map((r) => r * 2);
    expect(calculateBeta(leveragedReturns, benchReturns)).toBeCloseTo(2.0, 4);

    // Asset with exact -1x inverse
    const inverseReturns = benchReturns.map((r) => -r);
    expect(calculateBeta(inverseReturns, benchReturns)).toBeCloseTo(-1.0, 4);
  });

  // 8. Max Drawdown Reference Fixture
  it('Fixture 8: Max Drawdown peak-to-trough fixture', () => {
    // Peak: 150, Trough: 90 -> Drawdown = (90 - 150) / 150 = -40%
    const prices = [100, 120, 150, 130, 90, 110, 140, 160];
    const mdd = calculateMaxDrawdown(prices);
    expect(mdd).toBeDefined();
    expect(mdd!.maxDrawdown).toBeCloseTo(-0.40, 4);
    expect(mdd!.peakPrice).toBe(150);
    expect(mdd!.troughPrice).toBe(90);
  });

  // 9. Historical VaR (95%) and Expected Shortfall Reference Fixture
  it('Fixture 9: Historical VaR and Expected Shortfall fixture', () => {
    // 20 returns sorted from -10% to +10%
    const returns = [
      -0.10, -0.08, -0.06, -0.05, -0.04,
      -0.03, -0.02, -0.01, -0.005, 0.00,
      0.005, 0.01, 0.02, 0.03, 0.04,
      0.05, 0.06, 0.07, 0.08, 0.10,
    ];
    const var95 = calculateHistoricalVaR(returns, 0.95);
    expect(var95).toBeDefined();
    // 95% 1-day VaR should be negative (indicating loss threshold)
    expect(var95!.historicalVaR).toBeLessThan(0);
    // Expected shortfall (CVaR) must be at least as severe as VaR
    expect(var95!.expectedShortfall).toBeLessThanOrEqual(var95!.historicalVaR);
  });

  // 10. HHI Concentration Reference Fixture
  it('Fixture 10: Herfindahl-Hirschman Index (HHI) concentration fixture', () => {
    // Single asset (100%): HHI = 10,000
    expect(calculateConcentrationRisk([1.0]).hhi).toBe(10000);
    expect(calculateConcentrationRisk([1.0]).level).toBe('high');

    // 4 equal assets (25% each): HHI = 4 * (25^2) = 2,500
    expect(calculateConcentrationRisk([0.25, 0.25, 0.25, 0.25]).hhi).toBe(2500);

    // 10 equal assets (10% each): HHI = 10 * (10^2) = 1,000
    expect(calculateConcentrationRisk(Array(10).fill(0.10)).hhi).toBe(1000);
    expect(calculateConcentrationRisk(Array(10).fill(0.10)).level).toBe('low');
  });
});
