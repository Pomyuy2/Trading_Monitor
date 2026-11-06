/**
 * Support & resistance from past candles (no AI). Pure functions so they can be
 * unit-tested with fixed data.
 *
 * 1. Swings: 5-bar fractals — a bar whose high (low) is above (below) the two
 *    bars on each side.
 * 2. Clusters: swing prices within 0.75 % of each other are merged into one level
 *    (zone = min–max of the merged swings, never wider than 0.75 %).
 * 3. Score (0..1): touches (50 %), recency (30 %), volume at the touches vs the
 *    series average (20 %).
 * 4. Split by the current price: below = support, above = resistance.
 *
 * Levels are descriptive only: they summarize where price turned in the past.
 */
import type { Candle, LevelStrength, PriceLevel } from '@tm/shared';

export interface Swing {
  index: number;
  time: number; // unix seconds
  price: number;
  type: 'high' | 'low';
  volume: number;
}

export interface Cluster {
  price: number; // average of swing prices
  zoneLow: number;
  zoneHigh: number;
  swings: Swing[];
}

export const FRACTAL_SIDE = 2; // 2 bars each side = 5-bar fractal
export const MERGE_PCT = 0.75;
const MIN_ZONE_PCT = 0.15; // a single-touch zone is drawn at least this wide (% of price)

/** 5-bar fractal swing highs and lows. Ties: the left-most bar of a flat top/bottom wins. */
export function findSwings(candles: Candle[], side = FRACTAL_SIDE): Swing[] {
  const swings: Swing[] = [];
  for (let i = side; i < candles.length - side; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= side; k++) {
      const before = candles[i - k];
      const after = candles[i + k];
      // strictly above the bars before, at least as high as the bars after
      if (!(c.high > before.high && c.high >= after.high)) isHigh = false;
      if (!(c.low < before.low && c.low <= after.low)) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, type: 'high', volume: c.volume });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, type: 'low', volume: c.volume });
  }
  return swings;
}

/**
 * Merge swings within `pct` % of each other. A cluster only grows while its whole zone
 * (lowest to highest swing) stays within `pct` %, so dense intraday swings can't chain
 * into one wide zone.
 */
export function clusterSwings(swings: Swing[], pct = MERGE_PCT): Cluster[] {
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: Cluster[] = [];
  for (const s of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && ((s.price - cur.zoneLow) / cur.zoneLow) * 100 <= pct + 1e-9) {
      cur.swings.push(s);
      cur.price = cur.swings.reduce((a, x) => a + x.price, 0) / cur.swings.length;
      cur.zoneLow = Math.min(cur.zoneLow, s.price);
      cur.zoneHigh = Math.max(cur.zoneHigh, s.price);
    } else {
      clusters.push({ price: s.price, zoneLow: s.price, zoneHigh: s.price, swings: [s] });
    }
  }
  return clusters;
}

export interface ScoredLevel {
  price: number;
  zoneLow: number;
  zoneHigh: number;
  touches: number;
  lastTouched: number; // unix seconds
  score: number;
  strength: LevelStrength;
}

/** Score clusters by touches, recency and volume at the touches. */
export function scoreClusters(clusters: Cluster[], candles: Candle[]): ScoredLevel[] {
  if (candles.length === 0) return [];
  const n = candles.length;
  const avgVol = candles.reduce((a, c) => a + c.volume, 0) / n || 1;
  return clusters.map((cl) => {
    const touches = cl.swings.length;
    const lastIdx = Math.max(...cl.swings.map((s) => s.index));
    const touchVol = cl.swings.reduce((a, s) => a + s.volume, 0) / touches;
    const touchScore = Math.min(touches, 4) / 4;
    const recency = n > 1 ? lastIdx / (n - 1) : 1;
    const volScore = Math.min(touchVol / avgVol, 2) / 2;
    const score = round(0.5 * touchScore + 0.3 * recency + 0.2 * volScore, 3);
    const minHalf = (cl.price * MIN_ZONE_PCT) / 200;
    return {
      price: cl.price,
      zoneLow: Math.min(cl.zoneLow, cl.price - minHalf),
      zoneHigh: Math.max(cl.zoneHigh, cl.price + minHalf),
      touches,
      lastTouched: candles[lastIdx].time,
      score,
      strength: strengthOf(score),
    };
  });
}

export function strengthOf(score: number): LevelStrength {
  if (score >= 0.6) return 'strong';
  if (score >= 0.4) return 'medium';
  return 'weak';
}

/** All scored levels for a candle series (independent of the current price — cacheable). */
export function computeLevels(candles: Candle[]): ScoredLevel[] {
  return scoreClusters(clusterSwings(findSwings(candles)), candles);
}

/**
 * Top `count` (by score) supports below and resistances above `price`, each list
 * ordered nearest first. A level whose zone contains the price is assigned by its center.
 */
export function splitLevels(levels: ScoredLevel[], price: number, count = 3): { supports: PriceLevel[]; resistances: PriceLevel[] } {
  const pick = (kind: PriceLevel['kind'], list: ScoredLevel[]) =>
    list
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .map((l) => toLevel(kind, l));
  return {
    supports: pick('support', levels.filter((l) => l.price < price)),
    resistances: pick('resistance', levels.filter((l) => l.price > price)),
  };
}

function toLevel(kind: PriceLevel['kind'], l: ScoredLevel): PriceLevel {
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
  };
}

/** Classic floor-trader pivots from one session's high, low and close. */
export function classicPivots(high: number, low: number, close: number) {
  const P = (high + low + close) / 3;
  return {
    P: round(P, 2),
    R1: round(2 * P - low, 2),
    S1: round(2 * P - high, 2),
    R2: round(P + (high - low), 2),
    S2: round(P - (high - low), 2),
  };
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
