import { describe, expect, it } from 'vitest';
import type { Candle } from '@tm/shared';
import {
  calculateAtrSeries,
  clusterSwingsAdaptive,
  computeLevelsV2,
  configForRange,
  DAILY_CONFIG,
  detectPriceReactions,
  findSwingsV2,
  INTRADAY_CONFIG,
  scoreLevelV2,
  splitLevelsV2,
  validateAndSortCandles,
  type SwingV2,
} from './levels-v2.js';

function makeBar(time: number, open: number, high: number, low: number, close: number, volume = 1000): Candle {
  return { time, open, high, low, close, volume };
}

describe('Levels V2 — Task A Data Integrity & Look-Ahead Safety', () => {
  it('rejects invalid candles and de-duplicates timestamps', () => {
    const raw: Candle[] = [
      makeBar(100, 10, 12, 9, 11),
      makeBar(100, 10, 13, 8, 12), // duplicate timestamp
      makeBar(200, 10, 8, 12, 11), // high < low (corrupted)
      { time: NaN, open: 10, high: 12, low: 9, close: 11, volume: 100 }, // NaN time
    ];

    const valid = validateAndSortCandles(raw);
    expect(valid).toHaveLength(2);
    expect(valid[0].time).toBe(100);
    // high and low clamped so high >= low
    expect(valid[1].high).toBeGreaterThanOrEqual(valid[1].low);
  });

  it('guarantees calculateAtrSeries is causal (strictly depends on bars 0..i)', () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) =>
      makeBar(1000 + i * 60, 100 + i, 102 + i, 99 + i, 101 + i, 1000),
    );

    const fullAtr = calculateAtrSeries(candles, 14);

    // ATR at bar 15 must match exactly when computed on slice(0, 16)
    const truncatedCandles = candles.slice(0, 16);
    const truncAtr = calculateAtrSeries(truncatedCandles, 14);

    expect(truncAtr[15]).toBeCloseTo(fullAtr[15], 8);
    expect(fullAtr[15]).toBeGreaterThan(0);
  });

  it('strictly enforces fractal confirmation delay (swing apex at i only confirmed at i + side)', () => {
    // 5 bars: 0, 1, 2, 3, 4 with peak at index 2 (side = 2)
    const candles: Candle[] = [
      makeBar(100, 100, 101, 99, 100),
      makeBar(101, 100, 102, 99, 101),
      makeBar(102, 101, 110, 100, 109), // Apex at index 2
      makeBar(103, 109, 105, 103, 104),
      makeBar(104, 104, 103, 101, 102), // Confirmation at index 4 (2 + 2)
      makeBar(105, 102, 102, 100, 101),
    ];
    const atrSeries = calculateAtrSeries(candles, 14);

    // With completedOnly = true, swings must not confirm after candles.length - 1
    const swings = findSwingsV2(candles, atrSeries, 2, true);
    expect(swings).toHaveLength(1);
    expect(swings[0].apexIndex).toBe(2);
    expect(swings[0].price).toBe(110);
    expect(swings[0].confirmedIndex).toBe(4); // Strictly confirmed at bar 4
    expect(swings[0].confirmedTime).toBe(104);

    // If slice only goes up to bar 3, the swing at index 2 CANNOT be confirmed yet!
    const sliceTo3 = candles.slice(0, 4);
    const swingsSlice = findSwingsV2(sliceTo3, atrSeries.slice(0, 4), 2, true);
    expect(swingsSlice).toHaveLength(0);
  });
});

describe('Levels V2 — Task B Adaptive Price Zones', () => {
  it('dynamically adapts tolerance using ATR and bounds zone width', () => {
    const atrSeries = [2.0, 2.0, 2.0, 2.0];
    const swings: SwingV2[] = [
      { apexIndex: 2, apexTime: 102, confirmedIndex: 4, confirmedTime: 104, price: 100, type: 'high', volume: 1000, atrAtConfirmation: 2.0 },
      { apexIndex: 5, apexTime: 105, confirmedIndex: 7, confirmedTime: 107, price: 100.5, type: 'high', volume: 1000, atrAtConfirmation: 2.0 },
      // Price 110 is well outside tolerance
      { apexIndex: 8, apexTime: 108, confirmedIndex: 10, confirmedTime: 110, price: 110, type: 'high', volume: 1000, atrAtConfirmation: 2.0 },
    ];

    const clusters = clusterSwingsAdaptive(swings, [], atrSeries, DAILY_CONFIG);
    expect(clusters).toHaveLength(2);
    // First cluster merges 100 and 100.5
    expect(clusters[0].swings).toHaveLength(2);
    expect(clusters[0].zoneLow).toBe(100);
    expect(clusters[0].zoneHigh).toBe(100.5);
    // Second cluster is isolated at 110
    expect(clusters[1].price).toBe(110);
  });

  it('uses separate configuration presets for intraday vs daily', () => {
    const dailyConf = configForRange('6M');
    const intraConf = configForRange('1D');

    expect(dailyConf.atrMultiplier).toBe(0.35);
    expect(dailyConf.maxPct).toBe(0.025);

    expect(intraConf.atrMultiplier).toBe(0.25);
    expect(intraConf.maxPct).toBe(0.015);
  });
});

describe('Levels V2 — Task C Price Reaction Events', () => {
  it('detects confirmed bounces with debouncing and excursion calculation', () => {
    const cluster = {
      price: 100,
      zoneLow: 99.5,
      zoneHigh: 100.5,
      swings: [
        { apexIndex: 2, apexTime: 102, confirmedIndex: 4, confirmedTime: 104, price: 100, type: 'low' as const, volume: 1000, atrAtConfirmation: 2.0 },
      ],
      firstConfirmedIndex: 4,
      lastConfirmedIndex: 4,
      atrAtCluster: 2.0,
    };

    // Subsequent bars: touch support at 100, then bounce up to 105 (> 0.5 * ATR bounce)
    const candles: Candle[] = [
      makeBar(100, 102, 103, 101, 102),
      makeBar(101, 102, 102, 100, 101),
      makeBar(102, 101, 101, 99.5, 100), // apex
      makeBar(103, 100, 102, 100, 101),
      makeBar(104, 101, 103, 101, 102), // confirmed bar 4
      makeBar(105, 102, 102, 99.8, 101), // touch at bar 5 (in zone 99.5..100.5)
      makeBar(106, 101, 104, 101, 103), // excursion +3.5
      makeBar(107, 103, 106, 103, 105), // excursion +5.5 (> 0.5 * 2 = 1.0)
    ];

    const atrSeries = [2, 2, 2, 2, 2, 2, 2, 2];
    const reactions = detectPriceReactions(cluster, candles, atrSeries, DAILY_CONFIG);

    expect(reactions.independentTouches).toBe(1);
    expect(reactions.confirmedBounces).toBe(1);
    expect(reactions.breakouts).toBe(0);
    expect(reactions.status).toBe('tested');
  });

  it('marks level as invalidated after repeated severe penetrations', () => {
    const cluster = {
      price: 100,
      zoneLow: 99.5,
      zoneHigh: 100.5,
      swings: [
        { apexIndex: 2, apexTime: 102, confirmedIndex: 4, confirmedTime: 104, price: 100, type: 'low' as const, volume: 1000, atrAtConfirmation: 2.0 },
      ],
      firstConfirmedIndex: 4,
      lastConfirmedIndex: 4,
      atrAtCluster: 2.0,
    };

    // Bars closing deeply below zone (close < 99.5 - 2.0 = 97.5)
    const candles: Candle[] = [
      makeBar(100, 102, 103, 101, 102),
      makeBar(101, 102, 102, 100, 101),
      makeBar(102, 101, 101, 99.5, 100),
      makeBar(103, 100, 102, 100, 101),
      makeBar(104, 101, 103, 101, 102),
      makeBar(105, 100, 100, 95, 96), // close 96 < 97.5
      makeBar(106, 96, 96, 94, 95),  // close 95 < 97.5
      makeBar(107, 95, 95, 93, 94),  // close 94 < 97.5
    ];

    const atrSeries = [2, 2, 2, 2, 2, 2, 2, 2];
    const reactions = detectPriceReactions(cluster, candles, atrSeries, DAILY_CONFIG);
    expect(reactions.isInvalidated).toBe(true);
    expect(reactions.status).toBe('invalidated');
  });
});

describe('Levels V2 — Task D Multi-Timeframe Confluence & Task E Scoring', () => {
  it('applies confluence bonus and generates plain-language explanations', () => {
    const cluster = {
      price: 150,
      zoneLow: 149.2,
      zoneHigh: 150.8,
      swings: [
        { apexIndex: 2, apexTime: 102, confirmedIndex: 4, confirmedTime: 104, price: 150, type: 'high' as const, volume: 5000, atrAtConfirmation: 3.0 },
      ],
      firstConfirmedIndex: 4,
      lastConfirmedIndex: 4,
      atrAtCluster: 3.0,
    };

    const reactions = {
      independentTouches: 2,
      confirmedBounces: 2,
      breakouts: 0,
      falseBreakouts: 0,
      retests: 0,
      isFlipped: false,
      isInvalidated: false,
      lastReactionIndex: 10,
      lastReactionTime: 110,
      reactionVolumeSum: 15000,
      totalExcursionAtr: 3.2,
      status: 'tested' as const,
    };

    const candles: Candle[] = Array.from({ length: 15 }, (_, i) =>
      makeBar(100 + i, 150, 152, 148, 150, 5000),
    );

    const scoredSingleTf = scoreLevelV2(cluster, reactions, candles, 1, DAILY_CONFIG);
    const scoredConfluent = scoreLevelV2(cluster, reactions, candles, 2, DAILY_CONFIG);

    expect(scoredConfluent.score).toBeGreaterThan(scoredSingleTf.score);
    expect(scoredConfluent.scoreComponents.confluenceBonus).toBe(0.10);
    expect(scoredConfluent.explanation).toContain('Multi-timeframe confluence confirmed');
    expect(scoredConfluent.explanation).toContain('confirmed bounce');
  });
});

describe('Levels V2 — Task G Schema Compatibility', () => {
  it('splits levels into supports and resistances with 100% backward compatibility', () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      // Create oscillating wave with swings
      const wave = Math.sin((i / 30) * Math.PI * 4) * 10;
      return makeBar(1000 + i * 86400, 100 + wave, 102 + wave, 98 + wave, 101 + wave, 10000);
    });

    const v2Levels = computeLevelsV2(candles, { range: '1M' });
    expect(v2Levels.length).toBeGreaterThan(0);

    const currentPrice = 101;
    const split = splitLevelsV2(v2Levels, currentPrice, 3);

    expect(split.supports.length).toBeLessThanOrEqual(3);
    expect(split.resistances.length).toBeLessThanOrEqual(3);

    for (const s of split.supports) {
      expect(s.kind).toBe('support');
      expect(s.price).toBeLessThan(currentPrice);
      expect(s.methodVersion).toBe('v2');
      expect(s.scoreComponents).toBeDefined();
    }

    for (const r of split.resistances) {
      expect(r.kind).toBe('resistance');
      expect(r.price).toBeGreaterThan(currentPrice);
      expect(r.methodVersion).toBe('v2');
      expect(r.scoreComponents).toBeDefined();
    }
  });
});
