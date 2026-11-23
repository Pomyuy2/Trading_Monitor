import {
  calculateSMASeries,
  calculateEMASeries,
  calculateBollingerBandsSeries,
  calculateRSISeries,
  calculateMACDSeries,
  calculateATRSeries,
  calculateADXSeries,
  calculateVWAPSeries,
  type Candle,
  type BollingerBandsSeriesResult,
  type MacdSeriesResult,
  type AdxSeriesResult,
} from '@tm/shared';

export type OverlayIndicatorKey =
  | 'sma20'
  | 'sma50'
  | 'sma200'
  | 'ema12'
  | 'ema26'
  | 'bollinger'
  | 'vwap';

export type PanelIndicatorKey = 'rsi' | 'macd' | 'atr' | 'adx';

export interface IndicatorMeta {
  key: string;
  label: string;
  color: string;
  category: 'overlay' | 'panel';
  description: string;
}

export const OVERLAY_CONFIGS: Record<OverlayIndicatorKey, IndicatorMeta> = {
  sma20: { key: 'sma20', label: 'SMA 20', color: '#38bdf8', category: 'overlay', description: '20-period Simple Moving Average' },
  sma50: { key: 'sma50', label: 'SMA 50', color: '#eab308', category: 'overlay', description: '50-period Simple Moving Average' },
  sma200: { key: 'sma200', label: 'SMA 200', color: '#ec4899', category: 'overlay', description: '200-period Simple Moving Average' },
  ema12: { key: 'ema12', label: 'EMA 12', color: '#a855f7', category: 'overlay', description: '12-period Exponential Moving Average' },
  ema26: { key: 'ema26', label: 'EMA 26', color: '#14b8a6', category: 'overlay', description: '26-period Exponential Moving Average' },
  bollinger: { key: 'bollinger', label: 'Bollinger Bands (20, 2)', color: '#818cf8', category: 'overlay', description: 'Bollinger Bands (20 SMA ± 2 StdDev)' },
  vwap: { key: 'vwap', label: 'VWAP', color: '#f97316', category: 'overlay', description: 'Volume-Weighted Average Price' },
};

export const PANEL_CONFIGS: Record<PanelIndicatorKey, IndicatorMeta> = {
  rsi: { key: 'rsi', label: 'RSI 14', color: '#818cf8', category: 'panel', description: 'Relative Strength Index (Wilder 14)' },
  macd: { key: 'macd', label: 'MACD (12, 26, 9)', color: '#38bdf8', category: 'panel', description: 'Moving Average Convergence Divergence' },
  atr: { key: 'atr', label: 'ATR 14', color: '#fb923c', category: 'panel', description: 'Average True Range (Wilder 14)' },
  adx: { key: 'adx', label: 'ADX 14', color: '#e879f9', category: 'panel', description: 'Average Directional Movement Index' },
};

export interface ComputedIndicators {
  sma20?: (number | null)[];
  sma50?: (number | null)[];
  sma200?: (number | null)[];
  ema12?: (number | null)[];
  ema26?: (number | null)[];
  bollinger?: BollingerBandsSeriesResult;
  vwap?: (number | null)[];
  rsi?: (number | null)[];
  macd?: MacdSeriesResult;
  atr?: (number | null)[];
  adx?: AdxSeriesResult;
}

/**
 * Computes all active indicator series for a given set of candles.
 */
export function computeIndicators(
  candles: Candle[],
  activeOverlays: OverlayIndicatorKey[],
  activePanel: PanelIndicatorKey | null,
): ComputedIndicators {
  if (!candles || candles.length === 0) return {};

  const closes = candles.map((c) => c.close);
  const result: ComputedIndicators = {};

  // Compute only active overlays to keep CPU overhead minimal
  for (const key of activeOverlays) {
    switch (key) {
      case 'sma20':
        result.sma20 = calculateSMASeries(closes, 20);
        break;
      case 'sma50':
        result.sma50 = calculateSMASeries(closes, 50);
        break;
      case 'sma200':
        result.sma200 = calculateSMASeries(closes, 200);
        break;
      case 'ema12':
        result.ema12 = calculateEMASeries(closes, 12);
        break;
      case 'ema26':
        result.ema26 = calculateEMASeries(closes, 26);
        break;
      case 'bollinger':
        result.bollinger = calculateBollingerBandsSeries(closes, 20, 2);
        break;
      case 'vwap':
        result.vwap = calculateVWAPSeries(candles);
        break;
    }
  }

  // Compute active panel
  if (activePanel) {
    switch (activePanel) {
      case 'rsi':
        result.rsi = calculateRSISeries(closes, 14);
        break;
      case 'macd':
        result.macd = calculateMACDSeries(closes, 12, 26, 9);
        break;
      case 'atr':
        result.atr = calculateATRSeries(candles, 14);
        break;
      case 'adx':
        result.adx = calculateADXSeries(candles, 14);
        break;
    }
  }

  return result;
}
