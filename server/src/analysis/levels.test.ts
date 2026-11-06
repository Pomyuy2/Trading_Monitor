import type { Candle } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { classicPivots, clusterSwings, computeLevels, findSwings, scoreClusters, splitLevels, strengthOf, type Swing } from './levels.js';

/** Candles from [high, low] pairs; one bar per minute, volume 100 unless given. */
function bars(pairs: [number, number][], volumes?: number[]): Candle[] {
  return pairs.map(([high, low], i) => ({
    time: 1_700_000_000 + i * 60,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: volumes?.[i] ?? 100,
  }));
}

const swing = (index: number, price: number, type: Swing['type'] = 'high', volume = 100): Swing => ({ index, time: index * 60, price, type, volume });

describe('findSwings (5-bar fractal)', () => {
  it('finds a swing high above the two bars on each side', () => {
    const c = bars([[10, 9], [11, 10], [15, 11], [11, 10], [10, 9]]);
    const s = findSwings(c);
    expect(s.filter((x) => x.type === 'high')).toEqual([{ index: 2, time: c[2].time, price: 15, type: 'high', volume: 100 }]);
  });

  it('finds a swing low below the two bars on each side', () => {
    const c = bars([[12, 10], [11, 9], [10, 5], [11, 9], [12, 10]]);
    expect(findSwings(c).filter((x) => x.type === 'low').map((x) => [x.index, x.price])).toEqual([[2, 5]]);
  });

  it('needs two full bars on both sides (nothing at the edges)', () => {
    const c = bars([[20, 1], [10, 9], [11, 10], [12, 11], [30, 0]]);
    expect(findSwings(c)).toEqual([]);
  });

  it('treats a flat top as one swing at its left-most bar', () => {
    const c = bars([[10, 9], [11, 10], [15, 11], [15, 11], [11, 10], [10, 9]]);
    const highs = findSwings(c).filter((x) => x.type === 'high');
    expect(highs.map((x) => x.index)).toEqual([2]);
  });

  it('ignores a bar that is only higher on one side', () => {
    const c = bars([[10, 9], [11, 10], [15, 11], [16, 12], [11, 10], [10, 9], [9, 8]]);
    expect(findSwings(c).filter((x) => x.type === 'high').map((x) => x.index)).toEqual([3]);
  });

  it('finds several alternating swings in a zig-zag', () => {
    // highs at 2 and 6, lows at 4 and 8
    const c = bars([[10, 8], [12, 9], [14, 11], [12, 9], [10, 6], [12, 9], [14.1, 11], [12, 9], [10, 6.05], [12, 9], [13, 10]]);
    const s = findSwings(c);
    expect(s.filter((x) => x.type === 'high').map((x) => x.index)).toEqual([2, 6]);
    expect(s.filter((x) => x.type === 'low').map((x) => x.index)).toEqual([4, 8]);
  });
});

describe('clusterSwings (merge within 0.75 %)', () => {
  it('merges nearby prices and keeps distant ones apart', () => {
    const cl = clusterSwings([swing(1, 100), swing(5, 100.5), swing(9, 100.7), swing(3, 103), swing(7, 103.6), swing(11, 110)]);
    expect(cl.map((c) => c.swings.length)).toEqual([3, 2, 1]);
    expect(cl[0].zoneLow).toBe(100);
    expect(cl[0].zoneHigh).toBe(100.7);
    expect(cl[0].price).toBeCloseTo((100 + 100.5 + 100.7) / 3, 6);
    expect(cl[1].zoneLow).toBe(103);
    expect(cl[1].zoneHigh).toBe(103.6);
  });

  it('does not merge prices just over 0.75 % apart', () => {
    const cl = clusterSwings([swing(1, 100), swing(2, 100.76)]);
    expect(cl).toHaveLength(2);
  });

  it('merges prices exactly 0.75 % apart', () => {
    const cl = clusterSwings([swing(1, 100), swing(2, 100.75)]);
    expect(cl).toHaveLength(1);
  });

  it('does not chain many close swings into one wide zone', () => {
    // 0.3 % steps: each is close to its neighbour, but 100 → 102.1 is 2.1 % overall
    const prices = [100, 100.3, 100.6, 100.9, 101.2, 101.5, 101.8, 102.1];
    const cl = clusterSwings(prices.map((p, i) => swing(i, p)));
    expect(cl.length).toBeGreaterThan(1);
    for (const c of cl) expect(((c.zoneHigh - c.zoneLow) / c.zoneLow) * 100).toBeLessThanOrEqual(0.75 + 1e-9);
  });

  it('mixes swing highs and lows at the same price (old resistance becomes support)', () => {
    const cl = clusterSwings([swing(1, 50, 'high'), swing(8, 50.1, 'low')]);
    expect(cl).toHaveLength(1);
    expect(cl[0].swings.map((s) => s.type).sort()).toEqual(['high', 'low']);
  });

  it('is independent of input order', () => {
    const a = clusterSwings([swing(1, 100), swing(2, 103), swing(3, 100.4)]);
    const b = clusterSwings([swing(3, 100.4), swing(1, 100), swing(2, 103)]);
    expect(a.map((c) => [c.zoneLow, c.zoneHigh, c.swings.length])).toEqual(b.map((c) => [c.zoneLow, c.zoneHigh, c.swings.length]));
  });
});

describe('scoreClusters', () => {
  const series = bars(Array.from({ length: 21 }, () => [11, 9] as [number, number]));

  it('scores more touches higher', () => {
    const [one, three] = scoreClusters(
      [
        { price: 50, zoneLow: 50, zoneHigh: 50, swings: [swing(10, 50)] },
        { price: 60, zoneLow: 60, zoneHigh: 60, swings: [swing(10, 60), swing(10, 60), swing(10, 60)] },
      ],
      series,
    );
    expect(three.score).toBeGreaterThan(one.score);
    expect(three.touches).toBe(3);
  });

  it('scores recent touches higher', () => {
    const [old, recent] = scoreClusters(
      [
        { price: 50, zoneLow: 50, zoneHigh: 50, swings: [swing(2, 50)] },
        { price: 60, zoneLow: 60, zoneHigh: 60, swings: [swing(18, 60)] },
      ],
      series,
    );
    expect(recent.score).toBeGreaterThan(old.score);
    expect(recent.lastTouched).toBe(series[18].time);
  });

  it('scores touches on heavy volume higher', () => {
    const [quiet, heavy] = scoreClusters(
      [
        { price: 50, zoneLow: 50, zoneHigh: 50, swings: [swing(10, 50, 'high', 50)] },
        { price: 60, zoneLow: 60, zoneHigh: 60, swings: [swing(10, 60, 'high', 400)] },
      ],
      series,
    );
    expect(heavy.score).toBeGreaterThan(quiet.score);
  });

  it('widens a single-price zone so it can be drawn', () => {
    const [l] = scoreClusters([{ price: 100, zoneLow: 100, zoneHigh: 100, swings: [swing(5, 100)] }], series);
    expect(l.zoneLow).toBeLessThan(100);
    expect(l.zoneHigh).toBeGreaterThan(100);
  });

  it('maps scores to strength bands', () => {
    expect(strengthOf(0.2)).toBe('weak');
    expect(strengthOf(0.45)).toBe('medium');
    expect(strengthOf(0.8)).toBe('strong');
  });
});

describe('computeLevels + splitLevels on a range-bound series', () => {
  // Price oscillates between ~100 and ~110 four times.
  const pairs: [number, number][] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    pairs.push([104, 102], [106, 104], [108, 106], [110 + cycle * 0.1, 108], [108, 106], [106, 104], [104, 102], [102, 100 - cycle * 0.1], [104, 102]);
  }
  pairs.push([105, 103], [106, 104]);
  const candles = bars(pairs);

  it('finds one support zone near 100 and one resistance zone near 110 with 4 touches each', () => {
    const { supports, resistances } = splitLevels(computeLevels(candles), 105);
    expect(supports[0].price).toBeGreaterThan(99.5);
    expect(supports[0].price).toBeLessThan(100.5);
    expect(supports[0].touches).toBe(4);
    expect(resistances[0].price).toBeGreaterThan(109.5);
    expect(resistances[0].price).toBeLessThan(110.5);
    expect(resistances[0].touches).toBe(4);
    expect(resistances[0].strength).toBe('strong');
  });

  it('returns at most 3 per side, nearest first', () => {
    const levels = [100, 101, 102, 103, 104, 106, 107, 108, 109, 110].map((p, i) => ({
      price: p, zoneLow: p - 0.1, zoneHigh: p + 0.1, touches: 1, lastTouched: 0, score: i / 10, strength: 'weak' as const,
    }));
    const { supports, resistances } = splitLevels(levels, 105);
    expect(supports.map((l) => l.price)).toEqual([104, 103, 102]);
    expect(resistances).toHaveLength(3);
    expect(resistances.map((l) => l.price)).toEqual([108, 109, 110]);
    expect(supports.every((l) => l.kind === 'support')).toBe(true);
  });

  it('returns nothing for too few candles', () => {
    expect(computeLevels(bars([[2, 1], [3, 2], [2, 1]]))).toEqual([]);
  });
});

describe('classicPivots', () => {
  it('computes P, R1, R2, S1, S2 from the previous session', () => {
    expect(classicPivots(110, 100, 105)).toEqual({ P: 105, R1: 110, S1: 100, R2: 115, S2: 95 });
  });
});
