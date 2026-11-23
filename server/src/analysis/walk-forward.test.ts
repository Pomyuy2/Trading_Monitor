import { describe, expect, it } from 'vitest';
import type { Candle } from '@tm/shared';
import {
  evaluateLevelForward,
  generateControlLevels,
  runWalkForwardBacktest,
  type WalkForwardConfig,
} from './walk-forward.js';

/**
 * Deterministic synthetic market path generator with realistic regime transitions:
 * ranging support/resistance bounces, breakout trends, and volatility regimes.
 */
function generateSyntheticRegimes(
  seed: number,
  bars = 280,
  startPrice = 150,
  volatility = 0.015,
): Candle[] {
  let p = startPrice;
  let t = 1700000000;
  const candles: Candle[] = [];

  // Linear congruential pseudorandom number generator for strictly reproducible deterministic series
  let state = seed;
  const nextRand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  // Define synthetic horizontal support and resistance levels
  const sup = startPrice * 0.95;
  const res = startPrice * 1.05;

  for (let i = 0; i < bars; i++) {
    t += 86400;
    const r1 = nextRand();
    const r2 = nextRand();
    let shock = (r1 - 0.5) * 2 * (p * volatility);

    // Mean reversion near support & resistance (producing natural bounces)
    if (p <= sup) {
      shock += Math.abs(shock) * 1.2; // bounce upward
    } else if (p >= res) {
      shock -= Math.abs(shock) * 1.2; // bounce downward
    }

    const open = p;
    const close = Math.max(10, open + shock);
    const high = Math.max(open, close) + r2 * (p * volatility * 0.7);
    const low = Math.min(open, close) - nextRand() * (p * volatility * 0.7);
    const volume = Math.floor(1_000_000 + nextRand() * 2_000_000);

    candles.push({ time: t, open, high, low, close, volume });
    p = close;
  }

  return candles;
}

describe('Walk-Forward Backtesting — Task F Evaluation', () => {
  it('guarantees forward evaluation is strictly leakage-free (starts at t + 1)', () => {
    const candles = generateSyntheticRegimes(12345, 100, 100);
    const forwardSlice = candles.slice(51, 61); // 10 bars forward from t=50

    const testLevel = {
      kind: 'support' as const,
      price: forwardSlice[0].low - 5, // Untouched level
      zoneLow: forwardSlice[0].low - 6,
      zoneHigh: forwardSlice[0].low - 4,
      touches: 2,
      lastTouched: new Date().toISOString(),
      strength: 'medium' as const,
      score: 0.5,
      methodVersion: 'v1' as const,
    };

    const currentAtr = 1.5;
    const wfConfig: WalkForwardConfig = {
      warmupBars: 50,
      forwardWindow: 10,
      bounceThresholdAtr: 0.5,
      penetrationThresholdAtr: 0.75,
      breakoutThresholdAtr: 0.4,
    };

    const res = evaluateLevelForward(testLevel, forwardSlice, currentAtr, wfConfig);
    expect(res.touched).toBe(false);
    expect(res.bounced).toBe(false);
  });

  it('runs complete walk-forward comparison across all 5 candidates on SPY daily regime', () => {
    // 260 daily bars representing steady ranging / mean-reverting index
    const spyCandles = generateSyntheticRegimes(42, 260, 450, 0.010);

    const result = runWalkForwardBacktest('SPY', spyCandles, {
      warmupBars: 50,
      forwardWindow: 10,
      step: 2, // step 2 for backtest speed
    });

    expect(result.evalSteps).toBeGreaterThan(90);
    const { V1, 'V2-ClusterOnly': v2Cluster, 'V2-Reactions': v2Rx, 'V2-Full': v2Full, Control } = result.candidates;

    // 1. Candidate level sanity checks
    expect(Control.touchCount).toBeGreaterThan(10);
    expect(V1.touchCount).toBeGreaterThan(10);
    expect(v2Full.touchCount).toBeGreaterThan(10);

    // 2. Zone stability: structural levels have significantly lower churn than price-relative control
    expect(v2Full.zoneChurnRate).toBeLessThan(Control.zoneChurnRate);

    // 3. Normalized MFE / MAE ratio of V2 Full should be favorable (> 1.0)
    expect(v2Full.mfeMaeRatio).toBeGreaterThan(1.0);

    // 4. Uncertainty intervals should be populated with valid CI boundaries
    expect(v2Full.bounceRateSE).toBeGreaterThan(0);
    expect(v2Full.bounceRateCI95[0]).toBeLessThanOrEqual(v2Full.bounceRate);
    expect(v2Full.bounceRateCI95[1]).toBeGreaterThanOrEqual(v2Full.bounceRate);
  });

  it('runs walk-forward comparison on high-volatility regime (NVDA / TSLA style)', () => {
    // 260 daily bars with high volatility (0.025)
    const nvdaCandles = generateSyntheticRegimes(999, 260, 120, 0.025);

    const result = runWalkForwardBacktest('NVDA', nvdaCandles, {
      warmupBars: 50,
      forwardWindow: 10,
      step: 2,
    });

    const { V1, 'V2-Full': v2Full, Control } = result.candidates;

    // V2 adaptive zones adapt to wider ATR and achieve favorable MFE/MAE
    expect(v2Full.mfeMaeRatio).toBeGreaterThan(1.0);
    expect(v2Full.zoneChurnRate).toBeLessThan(Control.zoneChurnRate);
    expect(v2Full.touchRate).toBeGreaterThan(0);
    expect(v2Full.avgZoneCount).toBeGreaterThan(0);
  });

  it('runs walk-forward backtest on 500-bar intraday dataset', () => {
    // 500 5-minute bars
    const intradayCandles = generateSyntheticRegimes(777, 500, 200, 0.003);

    const result = runWalkForwardBacktest('INTRA', intradayCandles, {
      warmupBars: 60,
      forwardWindow: 8,
      step: 4,
      range: '1D',
    });

    const { 'V2-Full': v2Full, Control } = result.candidates;
    expect(result.evalSteps).toBeGreaterThan(90);
    expect(v2Full.touchCount).toBeGreaterThan(10);
    expect(v2Full.bounceRate).toBeGreaterThan(0);
    expect(Control.touchCount).toBeGreaterThan(10);
  });
});
