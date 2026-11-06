'use client';

import { RESOLUTION_SECONDS, type Candle, type Resolution } from '@tm/shared';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useCallback, useEffect, useRef } from 'react';
import { intlLocale } from '@/lib/format';
import { useTickListener, type LiveTick } from '@/lib/live';
import { useLang } from './ui';

export type ChartType = 'line' | 'candles';

const C = {
  panel: '#151A21',
  grid: '#1C222C',
  border: '#222935',
  muted: '#9AA4B2',
  accent: '#4C8DFF',
  up: '#3DDC97',
  down: '#FF7B7B',
  compare: '#F5C45E',
};

interface Props {
  symbol: string;
  candles: Candle[];
  resolution: Resolution;
  type: ChartType;
  live: boolean;
  compare?: { symbol: string; candles: Candle[] } | null;
  ariaLabel: string;
}

const toTime = (t: number) => t as UTCTimestamp;

export function PriceChart({ symbol, candles, resolution, type, live, compare, ariaLabel }: Props) {
  const lang = useLang();
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<SeriesType> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const cmp = useRef<ISeriesApi<'Line'> | null>(null);
  const last = useRef<Candle | null>(null);
  const typeRef = useRef(type);
  const resRef = useRef(resolution);

  // Create once.
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: C.panel }, textColor: C.muted, fontFamily: 'var(--font-jetbrains), monospace', fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, rightOffset: 2 },
      crosshair: { mode: CrosshairMode.Magnet },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      main.current = vol.current = cmp.current = null;
    };
  }, []);

  // Locale-aware axis + crosshair labels. Intraday in the viewer's time zone; daily/weekly bars are calendar dates (UTC).
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const loc = intlLocale(lang);
    const daily = resolution === '1day' || resolution === '1week';
    const tz = daily ? 'UTC' : undefined;
    const fmt = (t: Time, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { ...o, timeZone: tz }).format(new Date((t as number) * 1000));
    c.applyOptions({
      localization: {
        locale: loc,
        priceFormatter: (p: number) => new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p),
        timeFormatter: (t: Time) =>
          fmt(t, daily ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
      },
      timeScale: {
        timeVisible: !daily,
        secondsVisible: false,
        tickMarkFormatter: (t: Time, kind: TickMarkType) => {
          switch (kind) {
            case TickMarkType.Year:
              return fmt(t, { year: 'numeric' });
            case TickMarkType.Month:
              return fmt(t, { month: 'short' });
            case TickMarkType.DayOfMonth:
              return fmt(t, { day: 'numeric', month: 'short' });
            default:
              return fmt(t, { hour: '2-digit', minute: '2-digit', hour12: false });
          }
        },
      },
    });
  }, [lang, resolution]);

  // (Re)build series whenever data, type or compare changes.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const s of [main.current, vol.current, cmp.current]) if (s) c.removeSeries(s);
    main.current = vol.current = cmp.current = null;
    typeRef.current = type;
    resRef.current = resolution;
    last.current = candles.length ? { ...candles[candles.length - 1] } : null;

    const comparing = !!compare && compare.candles.length > 0;
    c.applyOptions({ rightPriceScale: { mode: comparing ? PriceScaleMode.Percentage : PriceScaleMode.Normal, scaleMargins: { top: 0.1, bottom: 0.22 } } });

    if (type === 'candles' && !comparing) {
      const s = c.addSeries(CandlestickSeries, {
        upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
      });
      s.setData(candles.map((k) => ({ time: toTime(k.time), open: k.open, high: k.high, low: k.low, close: k.close })));
      main.current = s;
    } else {
      const s = c.addSeries(AreaSeries, {
        lineColor: C.accent, topColor: 'rgba(76,141,255,0.28)', bottomColor: 'rgba(76,141,255,0.02)', lineWidth: 2,
        priceLineVisible: true,
      });
      s.setData(candles.map((k) => ({ time: toTime(k.time), value: k.close })));
      main.current = s;
    }

    const v = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    v.setData(candles.map((k) => ({ time: toTime(k.time), value: k.volume, color: k.close >= k.open ? 'rgba(61,220,151,0.35)' : 'rgba(255,123,123,0.35)' })));
    vol.current = v;

    if (comparing && compare) {
      const s = c.addSeries(LineSeries, { color: C.compare, lineWidth: 2, priceLineVisible: false, title: compare.symbol });
      // Align compare data to the main series' time window.
      const start = candles[0]?.time ?? 0;
      s.setData(compare.candles.filter((k) => k.time >= start).map((k) => ({ time: toTime(k.time), value: k.close })));
      cmp.current = s;
    }

    c.timeScale().fitContent();
  }, [candles, type, compare, resolution]);

  // Live tick → update the last candle in place (or open a new one).
  const onTick = useCallback((tick: LiveTick) => {
    const s = main.current;
    const prev = last.current;
    if (!s || !prev) return;
    // Step from the last bar's own start time, so we follow the provider's bar alignment
    // (e.g. hourly bars starting at :30) instead of assuming round buckets.
    const size = RESOLUTION_SECONDS[resRef.current];
    const tickSec = Math.floor(tick.ts / 1000);
    if (tickSec < prev.time) return;
    const t = prev.time + Math.floor((tickSec - prev.time) / size) * size;
    const bar: Candle =
      t === prev.time
        ? { ...prev, high: Math.max(prev.high, tick.price), low: Math.min(prev.low, tick.price), close: tick.price, volume: prev.volume + (tick.volume ?? 0) }
        : { time: t, open: prev.close, high: Math.max(prev.close, tick.price), low: Math.min(prev.close, tick.price), close: tick.price, volume: tick.volume ?? 0 };
    last.current = bar;
    if (typeRef.current === 'candles' && !cmp.current) {
      (s as ISeriesApi<'Candlestick'>).update({ time: toTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } else {
      (s as ISeriesApi<'Area'>).update({ time: toTime(bar.time), value: bar.close });
    }
    vol.current?.update({ time: toTime(bar.time), value: bar.volume, color: bar.close >= bar.open ? 'rgba(61,220,151,0.35)' : 'rgba(255,123,123,0.35)' });
  }, []);

  useTickListener(symbol, live, onTick);

  return <div ref={el} role="img" aria-label={ariaLabel} className="h-[320px] w-full sm:h-[380px] xl:h-[420px]" />;
}
