import {
  RESOLUTION_SECONDS,
  type Candle,
  type ChartLine,
  type DividendEvent,
  type EarningsReport,
  type Resolution,
} from '@tm/shared';
import type { Zone } from '../level-zones';

const dayKey = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

export interface BarEvents {
  earnings: EarningsReport[];
  dividends: DividendEvent[];
}

/**
 * Groups earnings and dividend events by the candle bucket timestamp they fall into.
 */
export function groupEventsByCandleBar(
  events: { earnings: EarningsReport[]; dividends: DividendEvent[] } | null | undefined,
  candles: Candle[],
  resolution: Resolution,
): Map<number, BarEvents> {
  const map = new Map<number, BarEvents>();
  if (!events || candles.length === 0) return map;

  const size = RESOLUTION_SECONDS[resolution];
  const firstDay = dayKey(candles[0].time);
  const lastEnd = candles[candles.length - 1].time + size;

  const barFor = (date: string): number | null => {
    if (date < firstDay) return null;
    const start = Date.parse(`${date}T00:00:00Z`) / 1000;
    if (start >= lastEnd) return null;
    if (size >= 86400) {
      // Daily / weekly: the bar whose period contains the date
      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].time <= start) return candles[i].time;
      }
      return null;
    }
    // Intraday: first bar on that calendar day
    return candles.find((c) => dayKey(c.time) === date)?.time ?? null;
  };

  const add = (date: string, fn: (e: BarEvents) => void) => {
    const bar = barFor(date);
    if (bar == null) return;
    const e = map.get(bar) ?? { earnings: [], dividends: [] };
    fn(e);
    map.set(bar, e);
  };

  for (const e of events.earnings) add(e.date, (x) => x.earnings.push(e));
  for (const d of events.dividends) add(d.exDate, (x) => x.dividends.push(d));

  return map;
}

/**
 * Builds ECharts markArea specification for Support & Resistance price zones.
 */
export function buildZonesMarkArea(zones: Zone[]): any {
  if (!zones || zones.length === 0) return undefined;
  return {
    silent: true,
    data: zones.map((z) => [
      {
        yAxis: z.low,
        itemStyle: {
          color: `rgba(${z.rgb}, ${z.alpha})`,
          borderWidth: 1,
          borderColor: `rgba(${z.rgb}, ${Math.min(1, z.alpha * 2.5)})`,
          borderType: 'solid',
        },
      },
      {
        yAxis: z.high,
      },
    ]),
  };
}

/**
 * Builds ECharts markLine specification for Floor Pivot lines (P, R1, R2, S1, S2).
 */
export function buildPivotsMarkLine(lines: ChartLine[]): any {
  if (!lines || lines.length === 0) return undefined;
  return {
    silent: true,
    symbol: 'none',
    data: lines.map((l) => ({
      yAxis: l.price,
      lineStyle: {
        type: l.dashed ? 'dashed' : 'solid',
        color: l.color,
        width: 1,
      },
      label: {
        show: true,
        position: 'insideEndTop',
        formatter: `${l.title} ${l.price.toFixed(2)}`,
        color: l.color,
        fontSize: 10,
        fontFamily: 'monospace',
      },
    })),
  };
}

/**
 * Builds ECharts markPoint specification for Corporate Events (Earnings 'E', Dividends 'D').
 */
export function buildCorporateEventsMarkPoint(
  eventsByBar: Map<number, BarEvents>,
  candles: Candle[],
  categories: string[],
): any {
  if (eventsByBar.size === 0 || candles.length === 0) return undefined;

  const points: any[] = [];
  const timeToIndex = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    timeToIndex.set(candles[i].time, i);
  }

  for (const [barTime, ev] of eventsByBar.entries()) {
    const idx = timeToIndex.get(barTime);
    if (idx == null) continue;
    const cat = categories[idx];
    const candle = candles[idx];

    if (ev.earnings.length > 0) {
      points.push({
        name: 'Earnings',
        coord: [cat, candle.low],
        symbol: 'circle',
        symbolSize: 18,
        itemStyle: { color: '#4c8dff' },
        label: {
          show: true,
          formatter: 'E',
          color: '#ffffff',
          fontWeight: 'bold',
          fontSize: 10,
        },
        tooltip: {
          formatter: () => {
            const e = ev.earnings[0];
            return `Earnings: ${e.date} (EPS: ${e.epsActual ?? 'N/A'} vs est: ${e.epsEstimate ?? 'N/A'})`;
          },
        },
      });
    }

    if (ev.dividends.length > 0) {
      points.push({
        name: 'Dividend',
        coord: [cat, candle.low],
        symbol: 'rect',
        symbolSize: 18,
        symbolOffset: ev.earnings.length > 0 ? [14, 0] : [0, 0],
        itemStyle: { color: '#3ddc97' },
        label: {
          show: true,
          formatter: 'D',
          color: '#ffffff',
          fontWeight: 'bold',
          fontSize: 10,
        },
        tooltip: {
          formatter: () => {
            const d = ev.dividends[0];
            return `Dividend: $${d.amount.toFixed(2)} (Ex-Date: ${d.exDate})`;
          },
        },
      });
    }
  }

  if (points.length === 0) return undefined;

  return {
    silent: false,
    data: points,
  };
}
