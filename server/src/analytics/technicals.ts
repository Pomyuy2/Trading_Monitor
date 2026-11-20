/**
 * Deterministic Technical Analysis Indicator Engine.
 * Implements standard financial formulas with Wilder's smoothing and guard rails.
 */

import type { Candle } from '@tm/shared';

export interface MacdResult {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export interface BollingerBandsResult {
  upper: number | null;
  middle: number | null;
  lower: number | null;
  bandwidth: number | null;
  percentB: number | null;
}

export interface AdxResult {
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
}

export interface TechnicalSummary {
  price: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  macd: MacdResult;
  bollinger: BollingerBandsResult;
  atr14: number | null;
  adx14: AdxResult;
  historicalVolatility30d: number | null; // Annualized
  trend: 'bullish' | 'bearish' | 'neutral';
  rsiCondition: 'overbought' | 'oversold' | 'neutral';
  warnings: string[];
}

/** Simple Moving Average */
export function calculateSMA(values: number[], period: number): number | null {
  if (!values || values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return sum / period;
}

/** Exponential Moving Average */
export function calculateEMA(values: number[], period: number): number | null {
  if (!values || values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  // Seed with initial SMA
  let ema = values.slice(0, period).reduce((acc, v) => acc + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/** Series of EMAs */
export function calculateEMASeries(values: number[], period: number): (number | null)[] {
  if (!values || values.length < period || period <= 0) {
    return values.map(() => null);
  }
  const result: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((acc, v) => acc + v, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

/** Relative Strength Index (Wilder's 14) */
export function calculateRSI(closes: number[], period = 14): number | null {
  if (!closes || closes.length <= period || period <= 0) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Moving Average Convergence Divergence (MACD 12, 26, 9) */
export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  if (!closes || closes.length < slowPeriod + signalPeriod) {
    return { macd: null, signal: null, histogram: null };
  }

  const fastEmaSeries = calculateEMASeries(closes, fastPeriod);
  const slowEmaSeries = calculateEMASeries(closes, slowPeriod);

  const macdSeries: number[] = [];
  const macdIndices: number[] = [];

  for (let i = slowPeriod - 1; i < closes.length; i++) {
    const f = fastEmaSeries[i];
    const s = slowEmaSeries[i];
    if (f != null && s != null) {
      macdSeries.push(f - s);
      macdIndices.push(i);
    }
  }

  if (macdSeries.length < signalPeriod) {
    return { macd: macdSeries[macdSeries.length - 1] ?? null, signal: null, histogram: null };
  }

  const signal = calculateEMA(macdSeries, signalPeriod);
  const latestMacd = macdSeries[macdSeries.length - 1];
  const histogram = latestMacd != null && signal != null ? latestMacd - signal : null;

  return {
    macd: latestMacd != null ? +latestMacd.toFixed(4) : null,
    signal: signal != null ? +signal.toFixed(4) : null,
    histogram: histogram != null ? +histogram.toFixed(4) : null,
  };
}

/** Bollinger Bands (period 20, stdDev 2) */
export function calculateBollingerBands(
  closes: number[],
  period = 20,
  numStd = 2,
): BollingerBandsResult {
  if (!closes || closes.length < period) {
    return { upper: null, middle: null, lower: null, bandwidth: null, percentB: null };
  }

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);

  const upper = middle + numStd * std;
  const lower = middle - numStd * std;
  const bandwidth = middle > 0 ? (upper - lower) / middle : null;
  const current = closes[closes.length - 1];
  const percentB = upper !== lower ? (current - lower) / (upper - lower) : null;

  return {
    upper: +upper.toFixed(2),
    middle: +middle.toFixed(2),
    lower: +lower.toFixed(2),
    bandwidth: bandwidth != null ? +bandwidth.toFixed(4) : null,
    percentB: percentB != null ? +percentB.toFixed(4) : null,
  };
}

/** Average True Range (ATR 14) */
export function calculateATR(candles: Candle[], period = 14): number | null {
  if (!candles || candles.length <= period) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // Wilder's smoothing
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return +atr.toFixed(2);
}

/** Average Directional Index (ADX 14) */
export function calculateADX(candles: Candle[], period = 14): AdxResult {
  if (!candles || candles.length < period * 2) {
    return { adx: null, plusDI: null, minusDI: null };
  }

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];

    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }

  // Smooth TR, +DM, -DM over period
  let smoothTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxList: number[] = [];

  for (let i = period; i < trs.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trs[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i];

    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;

    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxList.push(dx);
  }

  if (dxList.length < period) {
    return { adx: null, plusDI: null, minusDI: null };
  }

  let adx = dxList.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxList.length; i++) {
    adx = (adx * (period - 1) + dxList[i]) / period;
  }

  const finalPlusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
  const finalMinusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;

  return {
    adx: +adx.toFixed(2),
    plusDI: +finalPlusDI.toFixed(2),
    minusDI: +finalMinusDI.toFixed(2),
  };
}

/** Annualized Historical Volatility using log returns */
export function calculateHistoricalVolatility(closes: number[], tradingDays = 252): number | null {
  if (!closes || closes.length < 10) return null;

  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  if (logReturns.length < 5) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / (logReturns.length - 1);
  const dailyStd = Math.sqrt(variance);

  return +(dailyStd * Math.sqrt(tradingDays)).toFixed(4);
}

/**
 * Calculates a complete technical indicator suite from OHLCV candles.
 */
export function calculateTechnicalSummary(candles: Candle[]): TechnicalSummary {
  const warnings: string[] = [];
  if (!candles || candles.length === 0) {
    return {
      price: 0,
      sma20: null,
      sma50: null,
      sma200: null,
      ema12: null,
      ema26: null,
      rsi14: null,
      macd: { macd: null, signal: null, histogram: null },
      bollinger: { upper: null, middle: null, lower: null, bandwidth: null, percentB: null },
      atr14: null,
      adx14: { adx: null, plusDI: null, minusDI: null },
      historicalVolatility30d: null,
      trend: 'neutral',
      rsiCondition: 'neutral',
      warnings: ['No candles provided for technical analysis'],
    };
  }

  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];

  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);
  const sma200 = calculateSMA(closes, 200);
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const bollinger = calculateBollingerBands(closes, 20, 2);
  const atr14 = calculateATR(candles, 14);
  const adx14 = calculateADX(candles, 14);
  const historicalVolatility30d = calculateHistoricalVolatility(closes.slice(-30));

  if (closes.length < 200) {
    warnings.push(`Observation count (${closes.length}) is below 200; SMA200 is unavailable`);
  }

  // Trend determination
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (sma20 != null && sma50 != null) {
    if (currentPrice > sma20 && sma20 > sma50) {
      trend = 'bullish';
    } else if (currentPrice < sma20 && sma20 < sma50) {
      trend = 'bearish';
    }
  } else if (sma20 != null) {
    if (currentPrice > sma20) {
      trend = 'bullish';
    } else if (currentPrice < sma20) {
      trend = 'bearish';
    }
  }

  // RSI Condition
  let rsiCondition: 'overbought' | 'oversold' | 'neutral' = 'neutral';
  if (rsi14 != null) {
    if (rsi14 >= 70) rsiCondition = 'overbought';
    else if (rsi14 <= 30) rsiCondition = 'oversold';
  }

  return {
    price: currentPrice,
    sma20: sma20 != null ? +sma20.toFixed(2) : null,
    sma50: sma50 != null ? +sma50.toFixed(2) : null,
    sma200: sma200 != null ? +sma200.toFixed(2) : null,
    ema12: ema12 != null ? +ema12.toFixed(2) : null,
    ema26: ema26 != null ? +ema26.toFixed(2) : null,
    rsi14: rsi14 != null ? +rsi14.toFixed(2) : null,
    macd,
    bollinger,
    atr14,
    adx14,
    historicalVolatility30d,
    trend,
    rsiCondition,
    warnings,
  };
}
