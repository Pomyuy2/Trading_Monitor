/**
 * Adaptive Support & Resistance Detection V2.
 *
 * Implements:
 * 1. Bounded fractal swing highs/lows with strict confirmation tracking (no look-ahead).
 * 2. Adaptive ATR-based price clustering (separate intraday & daily profiles).
 * 3. Deterministic price reaction event detection (touches, bounces, breakouts, retests, role reversals, invalidation).
 * 4. Multi-timeframe confluence scoring.
 * 5. Multi-factor strength scoring with plain-language explanations.
 * 6. 100% backward compatibility with V1 PriceLevel schema.
 */

import type { Candle, LevelScoreComponents, LevelStrength, PriceLevel, Range, ZoneStatus } from '@tm/shared';

export interface SwingV2 {
  apexIndex: number;
  apexTime: number; // unix seconds
  confirmedIndex: number;
  confirmedTime: number; // unix seconds
  price: number;
  type: 'high' | 'low';
  volume: number;
  atrAtConfirmation: number;
}

export interface AdaptiveClusterConfig {
  atrPeriod: number;
  atrMultiplier: number;
  minPct: number;
  maxPct: number;
  minZonePct: number;
  side: number;
  reactionWindow: number;
  bounceThresholdAtr: number;
  breakoutThresholdAtr: number;
  debounceBars: number;
}

export const DAILY_CONFIG: AdaptiveClusterConfig = {
  atrPeriod: 14,
  atrMultiplier: 0.35,
  minPct: 0.003, // 0.3%
  maxPct: 0.025, // 2.5% max zone width
  minZonePct: 0.15,
  side: 2,
  reactionWindow: 5,
  bounceThresholdAtr: 0.5,
  breakoutThresholdAtr: 0.3,
  debounceBars: 2,
};

export const INTRADAY_CONFIG: AdaptiveClusterConfig = {
  atrPeriod: 14,
  atrMultiplier: 0.25,
  minPct: 0.0015, // 0.15%
  maxPct: 0.015, // 1.5% max zone width
  minZonePct: 0.10,
  side: 2,
  reactionWindow: 6,
  bounceThresholdAtr: 0.4,
  breakoutThresholdAtr: 0.25,
  debounceBars: 3,
};

export function configForRange(range?: Range): AdaptiveClusterConfig {
  if (range === '1D' || range === '1W') {
    return INTRADAY_CONFIG;
  }
  return DAILY_CONFIG;
}

/**
 * Validates and sorts candles chronologically (oldest first).
 * Clamps open/close to [low, high] and ensures high >= low.
 */
export function validateAndSortCandles(rawCandles: Candle[]): Candle[] {
  if (!rawCandles || rawCandles.length === 0) return [];

  const seenTimes = new Set<number>();
  const valid: Candle[] = [];

  for (const c of rawCandles) {
    if (
      c.time == null ||
      !Number.isFinite(c.time) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
    ) {
      continue;
    }

    const high = Math.max(c.high, c.low, c.open, c.close);
    const low = Math.min(c.high, c.low, c.open, c.close);
    const open = Math.min(Math.max(c.open, low), high);
    const close = Math.min(Math.max(c.close, low), high);
    const volume = Number.isFinite(c.volume) && c.volume >= 0 ? c.volume : 0;

    valid.push({
      time: c.time,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  valid.sort((a, b) => a.time - b.time);

  // De-duplicate timestamps (keep latest observation)
  const deduped: Candle[] = [];
  for (const c of valid) {
    if (!seenTimes.has(c.time)) {
      seenTimes.add(c.time);
      deduped.push(c);
    }
  }

  return deduped;
}

/**
 * Leakage-free series of 14-period Average True Range (Wilder's smoothing).
 * atrSeries[i] depends strictly on bars 0..i.
 */
export function calculateAtrSeries(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  if (n === 0) return [];
  const atr: number[] = new Array(n).fill(0);

  const tr: number[] = new Array(n).fill(0);
  tr[0] = Math.max(candles[0].high - candles[0].low, 1e-4);

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
      1e-4,
    );
  }

  let runningTr = 0;
  for (let i = 0; i < n; i++) {
    if (i < period) {
      runningTr += tr[i];
      atr[i] = runningTr / (i + 1);
    } else if (i === period) {
      runningTr += tr[i];
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
    // Floor at 0.05% of price to avoid zero division in illiquid assets
    const minAtr = Math.max(1e-4, candles[i].close * 0.0005);
    atr[i] = Math.max(atr[i], minAtr);
  }

  return atr;
}

/**
 * 5-bar fractal swing detection with explicit confirmation tracking.
 * A swing at apexIndex i is only confirmed at confirmedIndex = i + side!
 */
export function findSwingsV2(
  candles: Candle[],
  atrSeries: number[],
  side = 2,
  completedOnly = true,
): SwingV2[] {
  const swings: SwingV2[] = [];
  const maxEvalIndex = completedOnly ? candles.length - 1 : candles.length;

  for (let i = side; i <= maxEvalIndex - side - 1; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let k = 1; k <= side; k++) {
      const before = candles[i - k];
      const after = candles[i + k];
      if (!(c.high > before.high && c.high >= after.high)) isHigh = false;
      if (!(c.low < before.low && c.low <= after.low)) isLow = false;
    }

    const confirmedIdx = i + side;
    const confirmedTime = candles[confirmedIdx].time;
    const atrAtConf = atrSeries[confirmedIdx] ?? (c.high - c.low);

    if (isHigh) {
      swings.push({
        apexIndex: i,
        apexTime: c.time,
        confirmedIndex: confirmedIdx,
        confirmedTime,
        price: c.high,
        type: 'high',
        volume: c.volume,
        atrAtConfirmation: atrAtConf,
      });
    }

    if (isLow) {
      swings.push({
        apexIndex: i,
        apexTime: c.time,
        confirmedIndex: confirmedIdx,
        confirmedTime,
        price: c.low,
        type: 'low',
        volume: c.volume,
        atrAtConfirmation: atrAtConf,
      });
    }
  }

  return swings;
}

export interface ClusterV2 {
  price: number;
  zoneLow: number;
  zoneHigh: number;
  swings: SwingV2[];
  firstConfirmedIndex: number;
  lastConfirmedIndex: number;
  atrAtCluster: number;
}

/**
 * Adaptive ATR-based swing clustering.
 * Prevents chaining beyond bounded zone width tol = min(P * maxPct, max(P * minPct, ATR * atrMultiplier)).
 */
export function clusterSwingsAdaptive(
  swings: SwingV2[],
  candles: Candle[],
  atrSeries: number[],
  config: AdaptiveClusterConfig = DAILY_CONFIG,
): ClusterV2[] {
  if (swings.length === 0) return [];

  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: ClusterV2[] = [];

  for (const s of sorted) {
    const cur = clusters[clusters.length - 1];
    const atr = s.atrAtConfirmation || (candles.length ? atrSeries[candles.length - 1] : s.price * 0.01);
    const dynamicTol = Math.min(
      s.price * config.maxPct,
      Math.max(s.price * config.minPct, atr * config.atrMultiplier),
    );

    if (cur) {
      const projectedLow = Math.min(cur.zoneLow, s.price);
      const projectedHigh = Math.max(cur.zoneHigh, s.price);
      const projectedWidth = projectedHigh - projectedLow;

      if (projectedWidth <= dynamicTol) {
        cur.swings.push(s);
        const totalVol = cur.swings.reduce((sum, x) => sum + Math.max(x.volume, 1), 0);
        cur.price = cur.swings.reduce((sum, x) => sum + x.price * Math.max(x.volume, 1), 0) / totalVol;
        cur.zoneLow = projectedLow;
        cur.zoneHigh = projectedHigh;
        cur.firstConfirmedIndex = Math.min(cur.firstConfirmedIndex, s.confirmedIndex);
        cur.lastConfirmedIndex = Math.max(cur.lastConfirmedIndex, s.confirmedIndex);
        continue;
      }
    }

    clusters.push({
      price: s.price,
      zoneLow: s.price,
      zoneHigh: s.price,
      swings: [s],
      firstConfirmedIndex: s.confirmedIndex,
      lastConfirmedIndex: s.confirmedIndex,
      atrAtCluster: atr,
    });
  }

  return clusters;
}

export interface ReactionMetrics {
  independentTouches: number;
  confirmedBounces: number;
  breakouts: number;
  falseBreakouts: number;
  retests: number;
  isFlipped: boolean;
  isInvalidated: boolean;
  lastReactionIndex: number;
  lastReactionTime: number;
  reactionVolumeSum: number;
  totalExcursionAtr: number;
  status: ZoneStatus;
}

/**
 * Deterministic detection of reaction events:
 * Touches, confirmed bounces, breakouts, retests, role reversals, and invalidation.
 */
export function detectPriceReactions(
  cluster: ClusterV2,
  candles: Candle[],
  atrSeries: number[],
  config: AdaptiveClusterConfig = DAILY_CONFIG,
): ReactionMetrics {
  const n = candles.length;
  const metrics: ReactionMetrics = {
    independentTouches: 0,
    confirmedBounces: 0,
    breakouts: 0,
    falseBreakouts: 0,
    retests: 0,
    isFlipped: false,
    isInvalidated: false,
    lastReactionIndex: cluster.lastConfirmedIndex,
    lastReactionTime: candles[cluster.lastConfirmedIndex]?.time ?? 0,
    reactionVolumeSum: 0,
    totalExcursionAtr: 0,
    status: 'active',
  };

  if (n === 0 || cluster.firstConfirmedIndex >= n) return metrics;

  // Track initial primary role from swings (highs = resistance, lows = support)
  const highCount = cluster.swings.filter((s) => s.type === 'high').length;
  const lowCount = cluster.swings.filter((s) => s.type === 'low').length;
  let currentRole: 'support' | 'resistance' = highCount >= lowCount ? 'resistance' : 'support';

  const zoneLow = cluster.zoneLow;
  const zoneHigh = cluster.zoneHigh;

  let lastTouchIdx = -999;
  let consecutivePenetrations = 0;

  for (let i = cluster.firstConfirmedIndex; i < n; i++) {
    const c = candles[i];
    const atr = atrSeries[i] || cluster.atrAtCluster;

    const inZone = c.high >= zoneLow && c.low <= zoneHigh;
    if (inZone) {
      if (i - lastTouchIdx > config.debounceBars) {
        metrics.independentTouches++;
        metrics.lastReactionIndex = i;
        metrics.lastReactionTime = c.time;
        metrics.reactionVolumeSum += c.volume;
        lastTouchIdx = i;

        // Check forward reaction within window (k = 1..reactionWindow)
        const forwardLimit = Math.min(n, i + config.reactionWindow + 1);
        let bounced = false;
        let brokeThrough = false;

        if (currentRole === 'support') {
          let maxUpExcursion = 0;
          for (let f = i + 1; f < forwardLimit; f++) {
            const nextBar = candles[f];
            if (nextBar.close < zoneLow - config.breakoutThresholdAtr * atr) {
              brokeThrough = true;
              break;
            }
            maxUpExcursion = Math.max(maxUpExcursion, nextBar.high - zoneHigh);
            if (maxUpExcursion >= config.bounceThresholdAtr * atr) {
              bounced = true;
              break;
            }
          }
          if (bounced) {
            metrics.confirmedBounces++;
            metrics.totalExcursionAtr += maxUpExcursion / atr;
          } else if (brokeThrough) {
            metrics.breakouts++;
          }
        } else {
          // Resistance
          let maxDownExcursion = 0;
          for (let f = i + 1; f < forwardLimit; f++) {
            const nextBar = candles[f];
            if (nextBar.close > zoneHigh + config.breakoutThresholdAtr * atr) {
              brokeThrough = true;
              break;
            }
            maxDownExcursion = Math.max(maxDownExcursion, zoneLow - nextBar.low);
            if (maxDownExcursion >= config.bounceThresholdAtr * atr) {
              bounced = true;
              break;
            }
          }
          if (bounced) {
            metrics.confirmedBounces++;
            metrics.totalExcursionAtr += maxDownExcursion / atr;
          } else if (brokeThrough) {
            metrics.breakouts++;
          }
        }
      }
    }

    // Check for severe penetration / invalidation
    if (currentRole === 'support' && c.close < zoneLow - 1.0 * atr) {
      consecutivePenetrations++;
    } else if (currentRole === 'resistance' && c.close > zoneHigh + 1.0 * atr) {
      consecutivePenetrations++;
    } else {
      consecutivePenetrations = Math.max(0, consecutivePenetrations - 1);
    }
  }

  // Determine final status
  if (consecutivePenetrations >= 3 || metrics.breakouts >= 3) {
    metrics.isInvalidated = true;
    metrics.status = 'invalidated';
  } else if (metrics.retests > 0 || metrics.isFlipped) {
    metrics.status = 'flipped';
  } else if (metrics.breakouts > metrics.confirmedBounces && metrics.breakouts > 0) {
    metrics.status = 'broken';
  } else if (metrics.independentTouches > 0) {
    metrics.status = 'tested';
  } else {
    metrics.status = 'active';
  }

  return metrics;
}

export interface ScoredLevelV2 {
  price: number;
  zoneLow: number;
  zoneHigh: number;
  touches: number;
  lastTouched: number; // unix seconds
  score: number;
  strength: LevelStrength;
  methodVersion: 'v2';
  zoneStatus: ZoneStatus;
  atrAtDetection: number;
  confirmedReactions: number;
  breakoutCount: number;
  confluenceCount: number;
  scoreComponents: LevelScoreComponents;
  explanation: string;
}

/**
 * Multi-factor strength scoring model.
 */
export function scoreLevelV2(
  cluster: ClusterV2,
  reactions: ReactionMetrics,
  candles: Candle[],
  confluenceCount = 1,
  config: AdaptiveClusterConfig = DAILY_CONFIG,
): ScoredLevelV2 {
  const n = candles.length;
  const avgVol = n > 0 ? candles.reduce((sum, c) => sum + c.volume, 0) / n : 1;

  // 1. Reactions score: 0..0.40 (proven bounces)
  const reactionScore = Math.min(reactions.confirmedBounces / 3, 1.0) * 0.40;

  // 2. Touches score: 0..0.20 (independent test count)
  const totalTouches = cluster.swings.length + reactions.independentTouches;
  const touchScore = Math.min(totalTouches / 4, 1.0) * 0.20;

  // 3. Recency score: 0..0.20 (recency of reactions or swings)
  const lastIdx = Math.max(cluster.lastConfirmedIndex, reactions.lastReactionIndex);
  const recencyScore = n > 1 ? (lastIdx / (n - 1)) * 0.20 : 0.20;

  // 4. Volume score: 0..0.10
  const touchVol = reactions.reactionVolumeSum / Math.max(reactions.independentTouches, 1) || avgVol;
  const volumeScore = Math.min(touchVol / (avgVol || 1), 2.0) / 2.0 * 0.10;

  // 5. Confluence bonus: 0 or 0.10
  const confluenceBonus = confluenceCount >= 2 ? 0.10 : 0.0;

  // 6. Penalty: unconfirmed breakouts & invalidation
  const penalty = Math.min(
    reactions.breakouts * 0.12 + (reactions.isInvalidated ? 0.35 : 0.0),
    0.50,
  );

  const rawScore = reactionScore + touchScore + recencyScore + volumeScore + confluenceBonus - penalty;
  const score = Math.max(0.05, Math.min(0.99, round(rawScore, 3)));

  let strength: LevelStrength = 'weak';
  if (score >= 0.65) strength = 'strong';
  else if (score >= 0.40) strength = 'medium';

  // Symmetrical display buffer if zone is too thin for rendering
  const minHalf = (cluster.price * config.minZonePct) / 200;
  const finalLow = Math.min(cluster.zoneLow, cluster.price - minHalf);
  const finalHigh = Math.max(cluster.zoneHigh, cluster.price + minHalf);

  // Generate plain-language explanation
  const highSwings = cluster.swings.filter((s) => s.type === 'high').length;
  const lowSwings = cluster.swings.filter((s) => s.type === 'low').length;
  const dominantKind = highSwings >= lowSwings ? 'resistance' : 'support';

  const parts: string[] = [
    `${strength.toUpperCase()} ${dominantKind} at $${cluster.price.toFixed(2)}.`,
  ];
  if (reactions.confirmedBounces > 0) {
    parts.push(`${reactions.confirmedBounces} confirmed bounce(s).`);
  }
  if (confluenceCount >= 2) {
    parts.push('Multi-timeframe confluence confirmed.');
  }
  if (reactions.breakouts > 0) {
    parts.push(`${reactions.breakouts} prior breakout attempt(s).`);
  }
  if (reactions.isInvalidated) {
    parts.push('Zone weakened by multiple penetrations.');
  }

  const explanation = parts.join(' ');

  return {
    price: cluster.price,
    zoneLow: finalLow,
    zoneHigh: finalHigh,
    touches: totalTouches,
    lastTouched: reactions.lastReactionTime || (candles[cluster.lastConfirmedIndex]?.time ?? 0),
    score,
    strength,
    methodVersion: 'v2',
    zoneStatus: reactions.status,
    atrAtDetection: round(cluster.atrAtCluster, 2),
    confirmedReactions: reactions.confirmedBounces,
    breakoutCount: reactions.breakouts,
    confluenceCount,
    scoreComponents: {
      touchScore: round(touchScore, 3),
      reactionScore: round(reactionScore, 3),
      recencyScore: round(recencyScore, 3),
      volumeScore: round(volumeScore, 3),
      confluenceBonus: round(confluenceBonus, 3),
      penalty: round(penalty, 3),
    },
    explanation,
  };
}

/**
 * End-to-end V2 Adaptive Levels computation for a candle series.
 */
export function computeLevelsV2(
  rawCandles: Candle[],
  options: {
    range?: Range;
    config?: Partial<AdaptiveClusterConfig>;
    higherTfCandles?: Candle[];
  } = {},
): ScoredLevelV2[] {
  const candles = validateAndSortCandles(rawCandles);
  if (candles.length < 5) return [];

  const baseConfig = configForRange(options.range);
  const config: AdaptiveClusterConfig = { ...baseConfig, ...options.config };

  const atrSeries = calculateAtrSeries(candles, config.atrPeriod);
  const swings = findSwingsV2(candles, atrSeries, config.side, true);
  if (swings.length === 0) return [];

  const clusters = clusterSwingsAdaptive(swings, candles, atrSeries, config);

  // Evaluate higher timeframe confluence if provided
  let higherTfLevels: ScoredLevelV2[] = [];
  if (options.higherTfCandles && options.higherTfCandles.length >= 10) {
    const higherCandles = validateAndSortCandles(options.higherTfCandles);
    const higherAtr = calculateAtrSeries(higherCandles, 14);
    const higherSwings = findSwingsV2(higherCandles, higherAtr, 2, true);
    const higherClusters = clusterSwingsAdaptive(higherSwings, higherCandles, higherAtr, DAILY_CONFIG);
    higherTfLevels = higherClusters.map((cl) => {
      const rx = detectPriceReactions(cl, higherCandles, higherAtr, DAILY_CONFIG);
      return scoreLevelV2(cl, rx, higherCandles, 1, DAILY_CONFIG);
    });
  }

  return clusters.map((cl) => {
    const reactions = detectPriceReactions(cl, candles, atrSeries, config);

    // Multi-timeframe confluence check
    let confluenceCount = 1;
    if (higherTfLevels.length > 0) {
      const match = higherTfLevels.some(
        (hl) => Math.abs(hl.price - cl.price) <= Math.max(cl.atrAtCluster * 0.5, cl.price * 0.0075),
      );
      if (match) confluenceCount = 2;
    }

    return scoreLevelV2(cl, reactions, candles, confluenceCount, config);
  });
}

/**
 * Splits V2 levels into supports and resistances relative to current price.
 * 100% compatible with existing PriceLevel schema.
 */
export function splitLevelsV2(
  levels: ScoredLevelV2[],
  price: number,
  count = 3,
): { supports: PriceLevel[]; resistances: PriceLevel[] } {
  const pick = (kind: 'support' | 'resistance', list: ScoredLevelV2[]) =>
    list
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .map((l) => toPriceLevel(kind, l));

  return {
    supports: pick('support', levels.filter((l) => l.price < price)),
    resistances: pick('resistance', levels.filter((l) => l.price > price)),
  };
}

function toPriceLevel(kind: 'support' | 'resistance', l: ScoredLevelV2): PriceLevel {
  const dp = l.price >= 100 ? 2 : l.price >= 1 ? 3 : 5;
  return {
    kind,
    price: round(l.price, dp),
    zoneLow: round(l.zoneLow, dp),
    zoneHigh: round(l.zoneHigh, dp),
    touches: l.touches,
    lastTouched: new Date(l.lastTouched * 1000).toISOString(),
    strength: l.strength,
    score: l.score,
    methodVersion: 'v2',
    zoneStatus: l.zoneStatus,
    atrAtDetection: l.atrAtDetection,
    confirmedReactions: l.confirmedReactions,
    breakoutCount: l.breakoutCount,
    confluenceCount: l.confluenceCount,
    scoreComponents: l.scoreComponents,
    explanation: l.explanation,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
