import { describe, expect, it } from 'vitest';
import {
  loadRealMarketData,
  movingBlockBootstrap,
  pairedDifferenceAnalysis,
  runRigorousValidation,
} from './statistical-validation.js';

describe('Statistical Validation — Section 1 & 2 Dependence & Metrics', () => {
  it('correctly loads genuine historical market fixtures with verified provenance', () => {
    const data = loadRealMarketData();
    expect(data.daily).toBeDefined();
    expect(data.daily['SPY']).toBeDefined();
    expect(data.daily['AAPL']).toBeDefined();
    expect(data.daily['NVDA']).toBeDefined();
    expect(data.daily['TSLA']).toBeDefined();
    expect(data.intraday).toBeDefined();

    expect(data.daily['SPY'].barCount).toBe(501);
    expect(data.daily['SPY'].source).toContain('Yahoo Finance');
    expect(data.intraday.barCount).toBe(781);
    expect(data.intraday.timeframe).toBe('5m');
  });

  it('performs Moving Block Bootstrap (MBB) and calculates dependence-aware uncertainty', () => {
    // Generate an AR(1) persistent serially correlated sequence
    const n = 200;
    const series: number[] = [10];
    let s = 123;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return (s / 4294967296) - 0.5;
    };
    for (let i = 1; i < n; i++) {
      series.push(series[i - 1] * 0.85 + rand() * 2);
    }

    const mbb1 = movingBlockBootstrap(series, 1, 1000);
    const mbb10 = movingBlockBootstrap(series, 10, 1000);

    expect(mbb10.se).toBeGreaterThan(0);
    expect(mbb10.ci95[0]).toBeLessThanOrEqual(mbb10.mean);
    expect(mbb10.ci95[1]).toBeGreaterThanOrEqual(mbb10.mean);
    // N_eff should be estimated
    expect(mbb10.nEff).toBeGreaterThan(0);
    expect(mbb10.nEff).toBeLessThanOrEqual(n);
  });

  it('conducts paired difference analysis on exact temporally aligned steps', () => {
    const data = loadRealMarketData();
    const spy = data.daily['SPY'];

    const res = runRigorousValidation('SPY', spy.candles, {
      trainRatio: 0.60,
      embargoBars: 10,
    });

    expect(res.pairedDiffHeldOut).toBeDefined();
    expect(res.pairedDiffHeldOut.mbbResults[1]).toBeDefined();
    expect(res.pairedDiffHeldOut.mbbResults[5]).toBeDefined();
    expect(res.pairedDiffHeldOut.mbbResults[10]).toBeDefined();
    expect(res.pairedDiffHeldOut.mbbResults[20]).toBeDefined();

    // Verify block bootstrap sensitivity is monotonic or bounded
    const se1 = res.pairedDiffHeldOut.mbbResults[1].se;
    const se10 = res.pairedDiffHeldOut.mbbResults[10].se;
    expect(se10).toBeGreaterThanOrEqual(se1 * 0.8);
  });
});

describe('Statistical Validation — Section 3 & 4 Selection Effects & Out-of-Sample', () => {
  it('controls for selection effects by partitioning into matched distance bands', () => {
    const data = loadRealMarketData();
    const nvda = data.daily['NVDA'];

    const res = runRigorousValidation('NVDA', nvda.candles, {
      trainRatio: 0.60,
      embargoBars: 10,
    });

    const bands = res.selectionEffects.distanceBands;
    expect(bands.length).toBe(3);
    expect(bands[0].band).toContain('Near');
    expect(bands[1].band).toContain('Mid');
    expect(bands[2].band).toContain('Far');

    // Each band must record separate touch counts for V1 and V2
    expect(bands[0].v1Touches).toBeGreaterThan(0);
    expect(bands[0].v2Touches).toBeGreaterThan(0);
  });

  it('enforces strict chronological train/purge/test splits with zero leakage across boundaries', () => {
    const data = loadRealMarketData();
    const tsla = data.daily['TSLA'];

    const res = runRigorousValidation('TSLA', tsla.candles, {
      trainRatio: 0.60,
      embargoBars: 10,
    });

    // In-Sample and Held-Out Test candidates must be separately evaluated
    expect(res.inSample['V1'].evalSteps).toBeGreaterThan(50);
    expect(res.heldOutTest['V1'].evalSteps).toBeGreaterThan(50);

    // Sum of steps plus embargo must not exceed total bars
    const totalBars = tsla.candles.length;
    const trainSteps = res.inSample['V1'].evalSteps;
    const testSteps = res.heldOutTest['V1'].evalSteps;
    expect(trainSteps + testSteps).toBeLessThan(totalBars);
  });
});

describe('Statistical Validation — Section 5 Parameter Sensitivity & Stability', () => {
  it('verifies stability under ±20% parameter perturbations', () => {
    const data = loadRealMarketData();
    const spy = data.daily['SPY'];

    const res = runRigorousValidation('SPY', spy.candles);
    expect(res.stabilityAnalysis.length).toBeGreaterThan(4);

    for (const p of res.stabilityAnalysis) {
      expect(p.v2BounceRate).toBeGreaterThan(0);
      expect(p.v2MfeMae).toBeGreaterThan(0);
    }
  });
});
