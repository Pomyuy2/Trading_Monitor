import { RESOLUTION_SECONDS, type Candle, type LiveTick, type Resolution } from '@tm/shared';

export interface FormattedChartData {
  times: number[];
  categories: string[];
  candlestickData: [number, number, number, number][]; // [open, close, low, high]
  volumeData: { value: number; itemStyle: { color: string } }[];
  lineData: number[];
}

export interface ComparePlotData {
  symbol: string;
  color: string;
  data: (number | null)[];
}

const dayKey = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getCategoryFormatter(daily: boolean, locale: string): Intl.DateTimeFormat {
  const key = `${daily ? 'd' : 'i'}_${locale}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    if (daily) {
      fmt = new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
    } else {
      fmt = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    formatterCache.set(key, fmt);
  }
  return fmt;
}

/**
 * Format category label for X axis based on resolution and locale.
 */
export function formatCategoryTime(
  sec: number,
  resolution: Resolution,
  locale = 'en-US',
): string {
  const daily = resolution === '1day' || resolution === '1week';
  return getCategoryFormatter(daily, locale).format(new Date(sec * 1000));
}

/**
 * Transforms Candle data into ECharts series inputs with [open, close, low, high] candlestick format.
 */
export function adaptCandlesToECharts(
  candles: Candle[],
  resolution: Resolution,
  colors: { volUp: string; volDown: string },
  locale = 'en-US',
): FormattedChartData {
  const times: number[] = new Array(candles.length);
  const categories: string[] = new Array(candles.length);
  const candlestickData: [number, number, number, number][] = new Array(candles.length);
  const volumeData: { value: number; itemStyle: { color: string } }[] = new Array(candles.length);
  const lineData: number[] = new Array(candles.length);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    times[i] = c.time;
    categories[i] = formatCategoryTime(c.time, resolution, locale);
    // ECharts order: [open, close, low, high]
    candlestickData[i] = [c.open, c.close, c.low, c.high];
    volumeData[i] = {
      value: c.volume,
      itemStyle: {
        color: c.close >= c.open ? colors.volUp : colors.volDown,
      },
    };
    lineData[i] = c.close;
  }

  return { times, categories, candlestickData, volumeData, lineData };
}

/**
 * Normalizes base candles and compared symbols to percentage return from range start:
 * Pct = ((Close_t - Close_0) / Close_0) * 100
 */
export function adaptComparisonData(
  baseCandles: Candle[],
  compares: { symbol: string; candles: Candle[]; color: string }[],
): {
  basePct: (number | null)[];
  compareSeries: ComparePlotData[];
} {
  if (!baseCandles || baseCandles.length === 0) {
    return { basePct: [], compareSeries: [] };
  }

  const startTs = baseCandles[0].time;
  const base0 = baseCandles[0].close;
  const basePct = baseCandles.map((c) =>
    base0 > 0 ? +(((c.close - base0) / base0) * 100).toFixed(2) : 0,
  );

  const compareSeries: ComparePlotData[] = compares.map((cs) => {
    const seriesBars = cs.candles.filter((b) => b.time >= startTs);
    if (seriesBars.length === 0) {
      return { symbol: cs.symbol, color: cs.color, data: new Array(baseCandles.length).fill(null) };
    }
    const cmp0 = seriesBars[0].close;
    const barByTime = new Map(seriesBars.map((b) => [b.time, b.close]));

    let lastKnownVal: number | null = null;
    const data: (number | null)[] = baseCandles.map((bc) => {
      const val = barByTime.get(bc.time);
      if (val != null) {
        lastKnownVal = val;
        return cmp0 > 0 ? +(((val - cmp0) / cmp0) * 100).toFixed(2) : 0;
      }
      if (lastKnownVal != null) {
        return cmp0 > 0 ? +(((lastKnownVal - cmp0) / cmp0) * 100).toFixed(2) : 0;
      }
      return null;
    });

    return { symbol: cs.symbol, color: cs.color, data };
  });

  return { basePct, compareSeries };
}

/**
 * Merges a streaming tick into the candle dataset, mutating in place or appending a new bar.
 */
export function updateCandlesWithTick(
  currentCandles: Candle[],
  tick: LiveTick,
  resolution: Resolution,
): { updatedCandles: Candle[]; isNewBar: boolean; lastBar: Candle } {
  if (!currentCandles || currentCandles.length === 0) {
    const barTime = Math.floor(tick.ts / 1000);
    const newBar: Candle = {
      time: barTime,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.volume ?? 0,
    };
    return { updatedCandles: [newBar], isNewBar: true, lastBar: newBar };
  }

  const size = RESOLUTION_SECONDS[resolution];
  const prev = currentCandles[currentCandles.length - 1];
  const tickSec = Math.floor(tick.ts / 1000);

  // Discard older timestamps
  if (tickSec < prev.time) {
    return { updatedCandles: currentCandles, isNewBar: false, lastBar: prev };
  }

  const tm = prev.time + Math.floor((tickSec - prev.time) / size) * size;
  const isNewBar = tm > prev.time;

  const bar: Candle = !isNewBar
    ? {
        ...prev,
        high: Math.max(prev.high, tick.price),
        low: Math.min(prev.low, tick.price),
        close: tick.price,
        volume: prev.volume + (tick.volume ?? 0),
      }
    : {
        time: tm,
        open: prev.close,
        high: Math.max(prev.close, tick.price),
        low: Math.min(prev.close, tick.price),
        close: tick.price,
        volume: tick.volume ?? 0,
      };

  const updatedCandles = isNewBar
    ? [...currentCandles, bar]
    : [...currentCandles.slice(0, -1), bar];

  return { updatedCandles, isNewBar, lastBar: bar };
}
