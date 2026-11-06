import { describe, expect, it } from 'vitest';
import { closedBeyond, priceCrossed, withinPct } from './alert-service.js';

describe('price alerts', () => {
  it('price_above triggers at or above the target', () => {
    expect(priceCrossed('price_above', 350, 349.99)).toBe(false);
    expect(priceCrossed('price_above', 350, 350)).toBe(true);
    expect(priceCrossed('price_above', 350, 351)).toBe(true);
  });

  it('price_below triggers at or below the target', () => {
    expect(priceCrossed('price_below', 340, 340.01)).toBe(false);
    expect(priceCrossed('price_below', 340, 340)).toBe(true);
    expect(priceCrossed('price_below', 340, 300)).toBe(true);
  });
});

describe('near-level alerts (within 1 %)', () => {
  it('is near inside the 1 % band on either side', () => {
    expect(withinPct(101, 100)).toBe(true);
    expect(withinPct(99, 100)).toBe(true);
    expect(withinPct(100, 100)).toBe(true);
  });

  it('is not near outside the band', () => {
    expect(withinPct(101.01, 100)).toBe(false);
    expect(withinPct(98.9, 100)).toBe(false);
  });
});

describe('breakout alerts (close beyond the zone)', () => {
  it('resistance: only a close above the zone high counts', () => {
    expect(closedBeyond('resistance', 99, 101, 101)).toBe(false); // inside the zone
    expect(closedBeyond('resistance', 99, 101, 101.01)).toBe(true);
    expect(closedBeyond('resistance', 99, 101, 95)).toBe(false); // below a resistance is not a breakout
  });

  it('support: only a close below the zone low counts', () => {
    expect(closedBeyond('support', 99, 101, 99)).toBe(false);
    expect(closedBeyond('support', 99, 101, 98.99)).toBe(true);
    expect(closedBeyond('support', 99, 101, 120)).toBe(false);
  });
});
