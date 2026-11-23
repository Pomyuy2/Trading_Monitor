import type { Candle } from './index';

export interface MacdSeriesResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export interface BollingerBandsSeriesResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
  bandwidth: (number | null)[];
  percentB: (number | null)[];
}

export interface AdxSeriesResult {
  adx: (number | null)[];
  plusDI: (number | null)[];
  minusDI: (number | null)[];
}

/** Simple Moving Average Series */
export function calculateSMASeries(values: number[], period: number): (number | null)[] {
  if (!values || period <= 0) return [];
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  result[period - 1] = +(sum / period).toFixed(2);

  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    result[i] = +(sum / period).toFixed(2);
  }
  return result;
}

/** Exponential Moving Average Series */
export function calculateEMASeries(values: number[], period: number): (number | null)[] {
  if (!values || period <= 0) return [];
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;

  const k = 2 / (period + 1);
  // Seed with initial SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let ema = sum / period;
  result[period - 1] = +ema.toFixed(2);

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = +ema.toFixed(2);
  }
  return result;
}

/** Bollinger Bands Series (Default period: 20, numStd: 2) */
export function calculateBollingerBandsSeries(
  values: number[],
  period = 20,
  numStd = 2,
): BollingerBandsSeriesResult {
  const len = values?.length ?? 0;
  const upper: (number | null)[] = new Array(len).fill(null);
  const middle: (number | null)[] = new Array(len).fill(null);
  const lower: (number | null)[] = new Array(len).fill(null);
  const bandwidth: (number | null)[] = new Array(len).fill(null);
  const percentB: (number | null)[] = new Array(len).fill(null);

  if (!values || len < period || period <= 0) {
    return { upper, middle, lower, bandwidth, percentB };
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  for (let i = period - 1; i < len; i++) {
    if (i >= period) {
      sum += values[i] - values[i - period];
    }
    const mid = sum / period;
    let varianceSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - mid;
      varianceSum += diff * diff;
    }
    const std = Math.sqrt(varianceSum / period);

    const up = mid + numStd * std;
    const low = mid - numStd * std;
    const bw = mid > 0 ? (up - low) / mid : null;
    const cur = values[i];
    const pb = up !== low ? (cur - low) / (up - low) : null;

    upper[i] = +up.toFixed(2);
    middle[i] = +mid.toFixed(2);
    lower[i] = +low.toFixed(2);
    bandwidth[i] = bw != null ? +bw.toFixed(4) : null;
    percentB[i] = pb != null ? +pb.toFixed(4) : null;
  }

  return { upper, middle, lower, bandwidth, percentB };
}

/** Relative Strength Index Series (Wilder's 14) */
export function calculateRSISeries(closes: number[], period = 14): (number | null)[] {
  if (!closes || period <= 0) return [];
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  const firstRSI = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  result[period] = +firstRSI.toFixed(2);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    result[i] = +rsi.toFixed(2);
  }

  return result;
}

/** Moving Average Convergence Divergence Series (MACD 12, 26, 9) */
export function calculateMACDSeries(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdSeriesResult {
  const len = closes?.length ?? 0;
  const macd: (number | null)[] = new Array(len).fill(null);
  const signal: (number | null)[] = new Array(len).fill(null);
  const histogram: (number | null)[] = new Array(len).fill(null);

  if (!closes || len < slowPeriod) {
    return { macd, signal, histogram };
  }

  const fastEma = calculateEMASeries(closes, fastPeriod);
  const slowEma = calculateEMASeries(closes, slowPeriod);

  // Compute MACD Line
  const validMacdValues: number[] = [];
  const validMacdIndices: number[] = [];

  for (let i = slowPeriod - 1; i < len; i++) {
    const f = fastEma[i];
    const s = slowEma[i];
    if (f != null && s != null) {
      const diff = +(f - s).toFixed(4);
      macd[i] = diff;
      validMacdValues.push(diff);
      validMacdIndices.push(i);
    }
  }

  if (validMacdValues.length < signalPeriod) {
    return { macd, signal, histogram };
  }

  // Calculate EMA on the valid MACD values for the signal line
  const k = 2 / (signalPeriod + 1);
  let sum = 0;
  for (let i = 0; i < signalPeriod; i++) {
    sum += validMacdValues[i];
  }
  let sig = sum / signalPeriod;

  const firstSigIdx = validMacdIndices[signalPeriod - 1];
  signal[firstSigIdx] = +sig.toFixed(4);
  if (macd[firstSigIdx] != null) {
    histogram[firstSigIdx] = +(macd[firstSigIdx]! - sig).toFixed(4);
  }

  for (let i = signalPeriod; i < validMacdValues.length; i++) {
    const origIdx = validMacdIndices[i];
    sig = validMacdValues[i] * k + sig * (1 - k);
    signal[origIdx] = +sig.toFixed(4);
    if (macd[origIdx] != null) {
      histogram[origIdx] = +(macd[origIdx]! - sig).toFixed(4);
    }
  }

  return { macd, signal, histogram };
}

/** Average True Range Series (ATR 14, Wilder's smoothing) */
export function calculateATRSeries(candles: Candle[], period = 14): (number | null)[] {
  if (!candles || period <= 0) return [];
  const len = candles.length;
  const result: (number | null)[] = new Array(len).fill(null);
  if (len <= period) return result;

  const trueRanges: number[] = [];
  for (let i = 1; i < len; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return result;

  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period] = +atr.toFixed(2);

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    result[i + 1] = +atr.toFixed(2);
  }

  return result;
}

/** Average Directional Index Series (ADX 14) */
export function calculateADXSeries(candles: Candle[], period = 14): AdxSeriesResult {
  const len = candles?.length ?? 0;
  const adx: (number | null)[] = new Array(len).fill(null);
  const plusDI: (number | null)[] = new Array(len).fill(null);
  const minusDI: (number | null)[] = new Array(len).fill(null);

  if (!candles || len < period * 2) {
    return { adx, plusDI, minusDI };
  }

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < len; i++) {
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

  let smoothTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxList: { dx: number; idx: number }[] = [];

  for (let i = period; i < trs.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trs[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i];

    const pDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;

    const barIdx = i + 1;
    plusDI[barIdx] = +pDI.toFixed(2);
    minusDI[barIdx] = +mDI.toFixed(2);

    const diSum = pDI + mDI;
    const dx = diSum > 0 ? (Math.abs(pDI - mDI) / diSum) * 100 : 0;
    dxList.push({ dx, idx: barIdx });
  }

  if (dxList.length >= period) {
    let adxVal = dxList.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
    adx[dxList[period - 1].idx] = +adxVal.toFixed(2);

    for (let i = period; i < dxList.length; i++) {
      adxVal = (adxVal * (period - 1) + dxList[i].dx) / period;
      adx[dxList[i].idx] = +adxVal.toFixed(2);
    }
  }

  return { adx, plusDI, minusDI };
}

/**
 * Volume-Weighted Average Price (VWAP) Series.
 * Resets each trading day for intraday candles.
 */
export function calculateVWAPSeries(candles: Candle[]): (number | null)[] {
  if (!candles || candles.length === 0) return [];
  const result: (number | null)[] = new Array(candles.length).fill(null);

  let cumVolume = 0;
  let cumTPV = 0;
  let currentDay = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = Math.floor(c.time / 86400);

    // Reset cumulative session totals on a new calendar day
    if (day !== currentDay) {
      currentDay = day;
      cumVolume = 0;
      cumTPV = 0;
    }

    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume ?? 0;

    cumVolume += vol;
    cumTPV += tp * vol;

    if (cumVolume > 0) {
      result[i] = +(cumTPV / cumVolume).toFixed(2);
    } else {
      result[i] = +tp.toFixed(2);
    }
  }

  return result;
}
