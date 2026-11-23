/**
 * Walk-Forward Backtesting Harness for Support & Resistance Detection.
 *
 * Provides strictly leakage-free chronological rolling evaluation comparing:
 * 1. V1 baseline (fixed 0.75%, 5-bar fractals, original scoring)
 * 2. V2-ClusterOnly (ATR dynamic clustering without reaction scoring)
 * 3. V2-Reactions (ATR dynamic clustering + reaction event detection)
 * 4. V2-Full (Full V2 including MTF confluence and penalty scoring)
 * 5. Control (Distance-matched synthetic horizontal levels)
 */

import type { Candle, PriceLevel, Range } from '@tm/shared';
import { computeLevels, splitLevels } from './levels.js';
import {
  calculateAtrSeries,
  clusterSwingsAdaptive,
  computeLevelsV2,
  configForRange,
  DAILY_CONFIG,
  detectPriceReactions,
  findSwingsV2,
  scoreLevelV2,
  splitLevelsV2,
  validateAndSortCandles,
  type AdaptiveClusterConfig,
  type ScoredLevelV2,
} from './levels-v2.js';

export type CandidateType = 'V1' | 'V2-ClusterOnly' | 'V2-Reactions' | 'V2-Full' | 'Control';

export interface WalkForwardConfig {
  warmupBars: number;
  forwardWindow: number;
  step?: number;
  range?: Range;
  bounceThresholdAtr: number;
  penetrationThresholdAtr: number;
  breakoutThresholdAtr: number;
}

export const DEFAULT_WF_CONFIG: WalkForwardConfig = {
  warmupBars: 50,
  forwardWindow: 10,
  step: 1,
  range: '1Y',
  bounceThresholdAtr: 0.5,
  penetrationThresholdAtr: 0.75,
  breakoutThresholdAtr: 0.4,
};

export interface CandidateMetrics {
  candidate: CandidateType;
  totalLevelsEvaluated: number;
  touchCount: number;
  touchRate: number; // touches / totalLevelsEvaluated
  bounceCount: number;
  bounceRate: number; // bounces / touches
  bounceRateSE: number;
  bounceRateCI95: [number, number];
  breakoutCount: number;
  breakoutRate: number; // breakouts / touches
  falseBreakoutCount: number;
  falseBreakoutRate: number; // falseBreakouts / breakouts
  meanMfeAtr: number;
  meanMaeAtr: number;
  mfeMaeRatio: number;
  mfeMaeSE: number;
  mfeMaeCI95: [number, number];
  avgZoneCount: number;
  zoneChurnRate: number;
}

export interface WalkForwardResult {
  symbol: string;
  candleCount: number;
  evalSteps: number;
  config: WalkForwardConfig;
  candidates: Record<CandidateType, CandidateMetrics>;
}

/**
 * Computes V2 levels using only ATR clustering and basic touch/volume/recency scoring
 * (no price reaction events engine).
 */
export function computeLevelsV2ClusterOnly(
  rawCandles: Candle[],
  config: AdaptiveClusterConfig = DAILY_CONFIG,
): ScoredLevelV2[] {
  const candles = validateAndSortCandles(rawCandles);
  if (candles.length < 5) return [];

  const atrSeries = calculateAtrSeries(candles, config.atrPeriod);
  const swings = findSwingsV2(candles, atrSeries, config.side, true);
  if (swings.length === 0) return [];

  const clusters = clusterSwingsAdaptive(swings, candles, atrSeries, config);
  const n = candles.length;
  const avgVol = n > 0 ? candles.reduce((sum, c) => sum + c.volume, 0) / n : 1;

  return clusters.map((cl) => {
    // Basic scoring without reaction engine:
    // 50% touches + 30% recency + 20% volume (like V1, but on ATR-clustered zones)
    const touchScore = Math.min(cl.swings.length / 4, 1.0) * 0.50;
    const recencyScore = n > 1 ? (cl.lastConfirmedIndex / (n - 1)) * 0.30 : 0.30;
    const swingVol = cl.swings.reduce((sum, s) => sum + s.volume, 0) / cl.swings.length;
    const volumeScore = Math.min(swingVol / (avgVol || 1), 2.0) / 2.0 * 0.20;
    const score = Math.max(0.05, Math.min(0.99, Number((touchScore + recencyScore + volumeScore).toFixed(3))));

    const strength = score >= 0.65 ? 'strong' : score >= 0.40 ? 'medium' : 'weak';
    const minHalf = (cl.price * config.minZonePct) / 200;

    return {
      price: cl.price,
      zoneLow: Math.min(cl.zoneLow, cl.price - minHalf),
      zoneHigh: Math.max(cl.zoneHigh, cl.price + minHalf),
      touches: cl.swings.length,
      lastTouched: candles[cl.lastConfirmedIndex]?.time ?? 0,
      score,
      strength,
      methodVersion: 'v2',
      zoneStatus: 'active',
      atrAtDetection: Number(cl.atrAtCluster.toFixed(2)),
      confirmedReactions: 0,
      breakoutCount: 0,
      confluenceCount: 1,
      scoreComponents: {
        touchScore: Number(touchScore.toFixed(3)),
        reactionScore: 0,
        recencyScore: Number(recencyScore.toFixed(3)),
        volumeScore: Number(volumeScore.toFixed(3)),
        confluenceBonus: 0,
        penalty: 0,
      },
      explanation: `V2-ClusterOnly level at $${cl.price.toFixed(2)} (${strength})`,
    };
  });
}

/**
 * Generates distance-matched synthetic control levels around current price.
 */
export function generateControlLevels(price: number, atr: number): PriceLevel[] {
  const offsets = [-3, -2, -1, 1, 2, 3];
  const halfZone = Math.max(atr * 0.15, price * 0.002);

  return offsets.map((k) => {
    const p = price + k * atr;
    const kind = k < 0 ? 'support' : 'resistance';
    return {
      kind,
      price: Number(p.toFixed(2)),
      zoneLow: Number((p - halfZone).toFixed(2)),
      zoneHigh: Number((p + halfZone).toFixed(2)),
      touches: 1,
      lastTouched: new Date().toISOString(),
      strength: 'medium',
      score: 0.5,
      methodVersion: 'v1',
    };
  });
}

interface ForwardEvalOutcome {
  touched: boolean;
  bounced: boolean;
  breakout: boolean;
  falseBreakout: boolean;
  mfeAtr: number;
  maeAtr: number;
}

/**
 * Strictly leakage-free forward evaluation of a price level over forwardCandles.
 */
export function evaluateLevelForward(
  level: PriceLevel,
  forwardCandles: Candle[],
  currentAtr: number,
  config: WalkForwardConfig,
): ForwardEvalOutcome {
  const outcome: ForwardEvalOutcome = {
    touched: false,
    bounced: false,
    breakout: false,
    falseBreakout: false,
    mfeAtr: 0,
    maeAtr: 0,
  };

  const H = forwardCandles.length;
  if (H === 0) return outcome;

  const atr = Math.max(currentAtr, 1e-4);
  const zLow = level.zoneLow;
  const zHigh = level.zoneHigh;

  let touchBarIdx = -1;
  for (let i = 0; i < H; i++) {
    const c = forwardCandles[i];
    if (c.high >= zLow && c.low <= zHigh) {
      touchBarIdx = i;
      break;
    }
  }

  if (touchBarIdx === -1) {
    return outcome;
  }

  outcome.touched = true;
  const subsequentBars = forwardCandles.slice(touchBarIdx + 1);
  if (subsequentBars.length === 0) {
    // Touch occurred on the very last bar of forward window
    return outcome;
  }

  if (level.kind === 'support') {
    let maxHigh = -Infinity;
    let minLow = forwardCandles[touchBarIdx].low; // include touch bar's low for MAE
    let brokeOut = false;
    let breakIdx = -1;

    for (let k = 0; k < subsequentBars.length; k++) {
      const c = subsequentBars[k];
      if (c.high > maxHigh) maxHigh = c.high;
      if (c.low < minLow) minLow = c.low;

      if (!brokeOut && c.close < zLow - config.breakoutThresholdAtr * atr) {
        brokeOut = true;
        breakIdx = k;
      }
    }

    const mfe = Math.max(0, maxHigh - zHigh);
    const mae = Math.max(0, zLow - minLow);
    outcome.mfeAtr = mfe / atr;
    outcome.maeAtr = mae / atr;

    // Confirmed bounce: MFE reached threshold while MAE stayed under penetration
    if (outcome.mfeAtr >= config.bounceThresholdAtr && outcome.maeAtr <= config.penetrationThresholdAtr) {
      outcome.bounced = true;
    }

    if (brokeOut) {
      outcome.breakout = true;
      // False breakout check: did it reclaim zLow within 3 bars?
      const checkLimit = Math.min(subsequentBars.length, breakIdx + 4);
      for (let k = breakIdx + 1; k < checkLimit; k++) {
        if (subsequentBars[k].close >= zLow) {
          outcome.falseBreakout = true;
          break;
        }
      }
    }
  } else {
    // Resistance
    let maxHigh = forwardCandles[touchBarIdx].high; // include touch bar's high for MAE
    let minLow = Infinity;
    let brokeOut = false;
    let breakIdx = -1;

    for (let k = 0; k < subsequentBars.length; k++) {
      const c = subsequentBars[k];
      if (c.high > maxHigh) maxHigh = c.high;
      if (c.low < minLow) minLow = c.low;

      if (!brokeOut && c.close > zHigh + config.breakoutThresholdAtr * atr) {
        brokeOut = true;
        breakIdx = k;
      }
    }

    const mfe = Math.max(0, zLow - minLow);
    const mae = Math.max(0, maxHigh - zHigh);
    outcome.mfeAtr = mfe / atr;
    outcome.maeAtr = mae / atr;

    if (outcome.mfeAtr >= config.bounceThresholdAtr && outcome.maeAtr <= config.penetrationThresholdAtr) {
      outcome.bounced = true;
    }

    if (brokeOut) {
      outcome.breakout = true;
      // False breakout check: did it reclaim zHigh within 3 bars?
      const checkLimit = Math.min(subsequentBars.length, breakIdx + 4);
      for (let k = breakIdx + 1; k < checkLimit; k++) {
        if (subsequentBars[k].close <= zHigh) {
          outcome.falseBreakout = true;
          break;
        }
      }
    }
  }

  return outcome;
}

interface RawCandidateAccumulator {
  totalLevels: number;
  touches: number;
  bounces: number;
  breakouts: number;
  falseBreakouts: number;
  mfeValues: number[];
  maeValues: number[];
  ratios: number[];
  zoneCounts: number[];
  churnCounts: number[];
}

function initAccumulator(): RawCandidateAccumulator {
  return {
    totalLevels: 0,
    touches: 0,
    bounces: 0,
    breakouts: 0,
    falseBreakouts: 0,
    mfeValues: [],
    maeValues: [],
    ratios: [],
    zoneCounts: [],
    churnCounts: [],
  };
}

/**
 * Runs the rolling walk-forward backtest for all 5 candidates over a candle series.
 */
export function runWalkForwardBacktest(
  symbol: string,
  rawCandles: Candle[],
  options: Partial<WalkForwardConfig> = {},
  higherTfCandles?: Candle[],
): WalkForwardResult {
  const config: WalkForwardConfig = { ...DEFAULT_WF_CONFIG, ...options };
  const candles = validateAndSortCandles(rawCandles);
  const N = candles.length;
  const H = config.forwardWindow;
  const warmup = config.warmupBars;
  const step = config.step ?? 1;

  if (N < warmup + H + 5) {
    throw new Error(`Insufficient candles for walk-forward backtest: got ${N}, required at least ${warmup + H + 5}`);
  }

  const atrSeries = calculateAtrSeries(candles, 14);

  const accumulators: Record<CandidateType, RawCandidateAccumulator> = {
    V1: initAccumulator(),
    'V2-ClusterOnly': initAccumulator(),
    'V2-Reactions': initAccumulator(),
    'V2-Full': initAccumulator(),
    Control: initAccumulator(),
  };

  const priorLevels: Record<CandidateType, PriceLevel[]> = {
    V1: [],
    'V2-ClusterOnly': [],
    'V2-Reactions': [],
    'V2-Full': [],
    Control: [],
  };

  let evalSteps = 0;

  for (let t = warmup; t <= N - H - 1; t += step) {
    evalSteps++;
    const trainSlice = candles.slice(0, t + 1);
    const forwardSlice = candles.slice(t + 1, t + 1 + H);
    const currentPrice = trainSlice[t].close;
    const currentAtr = atrSeries[t];

    // 1. Candidate V1 Baseline
    const v1Scored = computeLevels(trainSlice);
    const v1Split = splitLevels(v1Scored, currentPrice, 3);
    const v1Levels = [...v1Split.supports, ...v1Split.resistances];

    // 2. Candidate V2-ClusterOnly
    const v2ClusterScored = computeLevelsV2ClusterOnly(trainSlice, configForRange(config.range));
    const v2ClusterSplit = splitLevelsV2(v2ClusterScored, currentPrice, 3);
    const v2ClusterLevels = [...v2ClusterSplit.supports, ...v2ClusterSplit.resistances];

    // 3. Candidate V2-Reactions
    const v2RxScored = computeLevelsV2(trainSlice, { range: config.range });
    const v2RxSplit = splitLevelsV2(v2RxScored, currentPrice, 3);
    const v2RxLevels = [...v2RxSplit.supports, ...v2RxSplit.resistances];

    // 4. Candidate V2-Full (with MTF confluence if higherTfCandles available up to t's time)
    let filteredHigherCandles: Candle[] | undefined;
    if (higherTfCandles && higherTfCandles.length > 0) {
      const barTime = trainSlice[t].time;
      filteredHigherCandles = higherTfCandles.filter((hc) => hc.time <= barTime);
    }
    const v2FullScored = computeLevelsV2(trainSlice, {
      range: config.range,
      higherTfCandles: filteredHigherCandles,
    });
    const v2FullSplit = splitLevelsV2(v2FullScored, currentPrice, 3);
    const v2FullLevels = [...v2FullSplit.supports, ...v2FullSplit.resistances];

    // 5. Candidate Control
    const controlLevels = generateControlLevels(currentPrice, currentAtr);

    const candidatesMap: Record<CandidateType, PriceLevel[]> = {
      V1: v1Levels,
      'V2-ClusterOnly': v2ClusterLevels,
      'V2-Reactions': v2RxLevels,
      'V2-Full': v2FullLevels,
      Control: controlLevels,
    };

    // Evaluate each candidate
    for (const type of ['V1', 'V2-ClusterOnly', 'V2-Reactions', 'V2-Full', 'Control'] as CandidateType[]) {
      const levels = candidatesMap[type];
      const acc = accumulators[type];
      const prior = priorLevels[type];

      acc.zoneCounts.push(levels.length);
      acc.totalLevels += levels.length;

      // Zone churn calculation: fraction of levels that are new (price > 0.5 * atr from any prior level)
      if (prior.length > 0) {
        let newCount = 0;
        for (const l of levels) {
          const match = prior.some((p) => Math.abs(p.price - l.price) <= currentAtr * 0.5);
          if (!match) newCount++;
        }
        acc.churnCounts.push(newCount / Math.max(levels.length, 1));
      } else {
        acc.churnCounts.push(0);
      }
      priorLevels[type] = levels;

      for (const level of levels) {
        const ev = evaluateLevelForward(level, forwardSlice, currentAtr, config);
        if (ev.touched) {
          acc.touches++;
          if (ev.bounced) acc.bounces++;
          if (ev.breakout) acc.breakouts++;
          if (ev.falseBreakout) acc.falseBreakouts++;

          acc.mfeValues.push(ev.mfeAtr);
          acc.maeValues.push(ev.maeAtr);
          const ratio = ev.mfeAtr / Math.max(ev.maeAtr, 0.05);
          acc.ratios.push(ratio);
        }
      }
    }
  }

  const finalCandidates = {} as Record<CandidateType, CandidateMetrics>;

  for (const type of ['V1', 'V2-ClusterOnly', 'V2-Reactions', 'V2-Full', 'Control'] as CandidateType[]) {
    const acc = accumulators[type];
    const touches = acc.touches;
    const touchRate = acc.totalLevels > 0 ? touches / acc.totalLevels : 0;
    const bounceRate = touches > 0 ? acc.bounces / touches : 0;
    const bounceRateSE = touches > 0 ? Math.sqrt((bounceRate * (1 - bounceRate)) / touches) : 0;
    const bounceRateCI95: [number, number] = [
      Math.max(0, Number((bounceRate - 1.96 * bounceRateSE).toFixed(4))),
      Math.min(1, Number((bounceRate + 1.96 * bounceRateSE).toFixed(4))),
    ];

    const breakoutRate = touches > 0 ? acc.breakouts / touches : 0;
    const falseBreakoutRate = acc.breakouts > 0 ? acc.falseBreakouts / acc.breakouts : 0;

    const meanMfeAtr = acc.mfeValues.length > 0 ? acc.mfeValues.reduce((a, b) => a + b, 0) / acc.mfeValues.length : 0;
    const meanMaeAtr = acc.maeValues.length > 0 ? acc.maeValues.reduce((a, b) => a + b, 0) / acc.maeValues.length : 0;
    const mfeMaeRatio = meanMfeAtr / Math.max(meanMaeAtr, 0.001);

    // Standard error for ratio
    let ratioSE = 0;
    if (acc.ratios.length > 1) {
      const meanR = acc.ratios.reduce((a, b) => a + b, 0) / acc.ratios.length;
      const variance = acc.ratios.reduce((sum, r) => sum + (r - meanR) ** 2, 0) / (acc.ratios.length - 1);
      ratioSE = Math.sqrt(variance / acc.ratios.length);
    }
    const mfeMaeCI95: [number, number] = [
      Math.max(0, Number((mfeMaeRatio - 1.96 * ratioSE).toFixed(3))),
      Number((mfeMaeRatio + 1.96 * ratioSE).toFixed(3)),
    ];

    const avgZoneCount = acc.zoneCounts.length > 0 ? acc.zoneCounts.reduce((a, b) => a + b, 0) / acc.zoneCounts.length : 0;
    const zoneChurnRate = acc.churnCounts.length > 0 ? acc.churnCounts.reduce((a, b) => a + b, 0) / acc.churnCounts.length : 0;

    finalCandidates[type] = {
      candidate: type,
      totalLevelsEvaluated: acc.totalLevels,
      touchCount: touches,
      touchRate: Number(touchRate.toFixed(4)),
      bounceCount: acc.bounces,
      bounceRate: Number(bounceRate.toFixed(4)),
      bounceRateSE: Number(bounceRateSE.toFixed(4)),
      bounceRateCI95,
      breakoutCount: acc.breakouts,
      breakoutRate: Number(breakoutRate.toFixed(4)),
      falseBreakoutCount: acc.falseBreakouts,
      falseBreakoutRate: Number(falseBreakoutRate.toFixed(4)),
      meanMfeAtr: Number(meanMfeAtr.toFixed(3)),
      meanMaeAtr: Number(meanMaeAtr.toFixed(3)),
      mfeMaeRatio: Number(mfeMaeRatio.toFixed(3)),
      mfeMaeSE: Number(ratioSE.toFixed(3)),
      mfeMaeCI95,
      avgZoneCount: Number(avgZoneCount.toFixed(2)),
      zoneChurnRate: Number(zoneChurnRate.toFixed(3)),
    };
  }

  return {
    symbol,
    candleCount: N,
    evalSteps,
    config,
    candidates: finalCandidates,
  };
}
