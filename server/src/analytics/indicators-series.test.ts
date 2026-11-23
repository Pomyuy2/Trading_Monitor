import { describe, expect, it } from 'vitest';
import {
  calculateSMASeries,
  calculateEMASeries,
  calculateBollingerBandsSeries,
  calculateVWAPSeries,
  calculateRSISeries,
  calculateMACDSeries,
  calculateATRSeries,
  calculateADXSeries,
  type Candle,
} from '@tm/shared';

describe('Shared Technical Indicators Series Engine', () => {
  it('calculates SMA series with correct warmup nulls', () => {
    const data = [10, 20, 30, 40, 50];
    const sma3 = calculateSMASeries(data, 3);
    expect(sma3).toEqual([null, null, 20, 30, 40]);
  });

  it('calculates EMA series with initial SMA seeding', () => {
    const data = [10, 20, 30, 40, 50];
    const ema3 = calculateEMASeries(data, 3);
    // k = 2 / (3 + 1) = 0.5
    // seed at index 2: (10 + 20 + 30) / 3 = 20
    // index 3: 40 * 0.5 + 20 * 0.5 = 30
    // index 4: 50 * 0.5 + 30 * 0.5 = 40
    expect(ema3).toEqual([null, null, 20, 30, 40]);
  });

  it('calculates Bollinger Bands series', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + (i % 5));
    const bb = calculateBollingerBandsSeries(closes, 20, 2);
    expect(bb.middle[18]).toBeNull();
    expect(bb.middle[19]).not.toBeNull();
    expect(bb.upper[19]!).toBeGreaterThan(bb.middle[19]!);
    expect(bb.lower[19]!).toBeLessThan(bb.middle[19]!);
  });

  it('calculates VWAP series resetting on new calendar day', () => {
    const day1 = 1700000000; // arbitrary timestamp
    const day2 = day1 + 86400;
    const candles: Candle[] = [
      { time: day1, open: 100, high: 105, low: 95, close: 100, volume: 1000 }, // TP = 100
      { time: day1 + 300, open: 100, high: 110, low: 100, close: 105, volume: 1000 }, // TP = 105
      { time: day2, open: 200, high: 210, low: 190, close: 200, volume: 500 }, // TP = 200 (Day 2 reset)
    ];
    const vwap = calculateVWAPSeries(candles);
    expect(vwap[0]).toBe(100);
    // Bar 1: (100 * 1000 + 105 * 1000) / 2000 = 102.5
    expect(vwap[1]).toBe(102.5);
    // Bar 2: day reset -> 200
    expect(vwap[2]).toBe(200);
  });

  it('calculates RSI series with Wilder smoothing and warmup', () => {
    const closes = [
      44, 44.5, 45, 43.5, 44, 45.2, 45.8, 46, 45.5, 46.2, 47, 46.8, 47.5, 48, 48.5, 49, 48.8,
    ];
    const rsi = calculateRSISeries(closes, 14);
    expect(rsi.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(rsi[14]).not.toBeNull();
    expect(rsi[14]!).toBeGreaterThan(50);
    expect(rsi[15]!).toBeGreaterThan(50);
  });

  it('calculates MACD series with 12, 26, 9 warmup', () => {
    const closes = Array.from({ length: 45 }, (_, i) => 100 + Math.sin(i) * 10);
    const res = calculateMACDSeries(closes, 12, 26, 9);
    // MACD line is null before 25
    expect(res.macd[24]).toBeNull();
    expect(res.macd[25]).not.toBeNull();
    // Signal line is null before 25 + 8 = 33
    expect(res.signal[32]).toBeNull();
    expect(res.signal[33]).not.toBeNull();
    expect(res.histogram[33]).not.toBeNull();
  });

  it('calculates ATR series with Wilder smoothing', () => {
    const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: 1700000000 + i * 3600,
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 1000,
    }));
    const atr = calculateATRSeries(candles, 14);
    expect(atr.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(atr[14]).not.toBeNull();
    expect(atr[14]!).toBeCloseTo(10, 0);
  });

  it('calculates ADX series with +DI and -DI', () => {
    const candles: Candle[] = Array.from({ length: 35 }, (_, i) => ({
      time: 1700000000 + i * 3600,
      open: 100 + i * 2,
      high: 105 + i * 2,
      low: 95 + i * 2,
      close: 104 + i * 2,
      volume: 1000,
    }));
    const adx = calculateADXSeries(candles, 14);
    expect(adx.plusDI[15]).not.toBeNull();
    expect(adx.adx[28]).not.toBeNull();
  });
});
