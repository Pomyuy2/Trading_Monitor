'use client';

import { RESOLUTION_SECONDS, type Candle, type DividendEvent, type EarningsReport, type Resolution } from '@tm/shared';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  TickMarkType,
  TrackingModeExitMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtCompact, fmtNumber, fmtPrice, fmtSignedPct, intlLocale } from '@/lib/format';
import { useTickListener, type LiveTick } from '@/lib/live';
import { LevelZonesPrimitive, type Zone } from './level-zones';
import { cx, useLang } from './ui';

export type ChartType = 'line' | 'candles';

export interface ChartLine {
  price: number;
  title: string;
  color: string;
  dashed?: boolean;
}

export interface CompareSeries {
  symbol: string;
  candles: Candle[];
  color: string;
}

interface Props {
  symbol: string;
  candles: Candle[];
  resolution: Resolution;
  type: ChartType;
  live: boolean;
  compares?: CompareSeries[];
  zones?: Zone[];
  lines?: ChartLine[];
  events?: { earnings: EarningsReport[]; dividends: DividendEvent[] } | null;
  /** Changing it re-reads the theme colors. */
  theme: string;
  currency?: string;
  ariaLabel: string;
}

const toTime = (t: number) => t as UTCTimestamp;
const NONE_Z: Zone[] = [];
const NONE_L: ChartLine[] = [];
const NONE_C: CompareSeries[] = [];

/** Theme colors from CSS variables (globals.css), so the chart matches dark / light. */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    panel: v('--color-panel', '#151a21'),
    border: v('--color-border', '#222935'),
    muted: v('--color-muted', '#9aa4b2'),
    accent: v('--color-accent', '#4c8dff'),
    up: v('--color-up', '#3ddc97'),
    down: v('--color-down', '#ff7b7b'),
    grid: v('--chart-grid', '#1c222c'),
    areaTop: v('--chart-area-top', 'rgba(76,141,255,0.28)'),
    areaBottom: v('--chart-area-bottom', 'rgba(76,141,255,0.02)'),
    volUp: v('--chart-vol-up', 'rgba(61,220,151,0.35)'),
    volDown: v('--chart-vol-down', 'rgba(255,123,123,0.35)'),
  };
}

const dayKey = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

interface Hover {
  x: number;
  y: number;
  candle: Candle;
  prevClose: number | null;
  compares: { symbol: string; color: string; pct: number | null }[];
  mainPct: number | null;
  earnings: EarningsReport[];
  dividends: DividendEvent[];
}

export function PriceChart({
  symbol, candles, resolution, type, live, compares = NONE_C, zones = NONE_Z, lines = NONE_L, events, theme, currency = 'USD', ariaLabel,
}: Props) {
  const lang = useLang();
  const wrap = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<SeriesType> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const cmp = useRef<ISeriesApi<'Line'>[]>([]);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const last = useRef<Candle | null>(null);
  const typeRef = useRef(type);
  const resRef = useRef(resolution);
  const colors = useRef<ReturnType<typeof themeColors> | null>(null);
  const zonesPrim = useRef<LevelZonesPrimitive | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const overlay = useRef({ zones, lines });
  overlay.current = { zones, lines };
  const [hover, setHover] = useState<Hover | null>(null);

  const comparing = compares.some((c) => c.candles.length > 0);

  // Events grouped by the bar they fall in (markers + tooltip details).
  const eventsByBar = useMemo(() => {
    const map = new Map<number, { earnings: EarningsReport[]; dividends: DividendEvent[] }>();
    if (!events || candles.length === 0) return map;
    const size = RESOLUTION_SECONDS[resolution];
    const firstDay = dayKey(candles[0].time);
    const lastEnd = candles[candles.length - 1].time + size;
    const barFor = (date: string): number | null => {
      if (date < firstDay) return null;
      const start = Date.parse(`${date}T00:00:00Z`) / 1000;
      if (start >= lastEnd) return null;
      if (size >= 86400) {
        // daily / weekly: the bar whose period contains the date
        for (let i = candles.length - 1; i >= 0; i--) if (candles[i].time <= start) return candles[i].time;
        return null;
      }
      // intraday: first bar on that calendar day
      return candles.find((c) => dayKey(c.time) === date)?.time ?? null;
    };
    const add = (date: string, fn: (e: { earnings: EarningsReport[]; dividends: DividendEvent[] }) => void) => {
      const bar = barFor(date);
      if (bar == null) return;
      const e = map.get(bar) ?? { earnings: [], dividends: [] };
      fn(e);
      map.set(bar, e);
    };
    for (const e of events.earnings) add(e.date, (x) => x.earnings.push(e));
    for (const d of events.dividends) add(d.exDate, (x) => x.dividends.push(d));
    return map;
  }, [events, candles, resolution]);

  const applyOverlay = useCallback(() => {
    const s = main.current;
    if (!s) return;
    if (!zonesPrim.current) {
      zonesPrim.current = new LevelZonesPrimitive();
      s.attachPrimitive(zonesPrim.current);
    }
    zonesPrim.current.setZones(overlay.current.zones);
    for (const l of priceLines.current) s.removePriceLine(l);
    priceLines.current = overlay.current.lines.map((l) =>
      s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.dashed ? LineStyle.Dotted : LineStyle.Solid, axisLabelVisible: true, title: l.title }),
    );
  }, []);

  // Create once.
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { fontFamily: 'var(--font-jetbrains), monospace', fontSize: 11 },
      timeScale: { rightOffset: 2 },
      crosshair: { mode: CrosshairMode.Magnet },
      // Touch: press-and-hold shows the crosshair; lifting the finger hides it.
      trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      main.current = vol.current = null;
      cmp.current = [];
      markers.current = null;
    };
  }, []);

  // Theme colors.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const k = themeColors();
    colors.current = k;
    c.applyOptions({
      layout: { background: { type: ColorType.Solid, color: k.panel }, textColor: k.muted },
      grid: { vertLines: { color: k.grid }, horzLines: { color: k.grid } },
      rightPriceScale: { borderColor: k.border },
      timeScale: { borderColor: k.border },
      crosshair: { vertLine: { color: k.muted, labelBackgroundColor: k.border }, horzLine: { color: k.muted, labelBackgroundColor: k.border } },
    });
  }, [theme]);

  // Locale-aware axis labels. Intraday in the viewer's time zone; daily / weekly bars are calendar dates (UTC).
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const loc = intlLocale(lang);
    const daily = resolution === '1day' || resolution === '1week';
    const tz = daily ? 'UTC' : undefined;
    const fmt = (tm: Time, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { ...o, timeZone: tz }).format(new Date((tm as number) * 1000));
    c.applyOptions({
      localization: {
        locale: loc,
        priceFormatter: (p: number) => new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p),
        timeFormatter: (tm: Time) =>
          fmt(tm, daily ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
      },
      timeScale: {
        timeVisible: !daily,
        secondsVisible: false,
        tickMarkFormatter: (tm: Time, kind: TickMarkType) => {
          switch (kind) {
            case TickMarkType.Year:
              return fmt(tm, { year: 'numeric' });
            case TickMarkType.Month:
              return fmt(tm, { month: 'short' });
            case TickMarkType.DayOfMonth:
              return fmt(tm, { day: 'numeric', month: 'short' });
            default:
              return fmt(tm, { hour: '2-digit', minute: '2-digit', hour12: false });
          }
        },
      },
    });
  }, [lang, resolution]);

  // (Re)build series when data, type, compares or theme change.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const k = colors.current ?? themeColors();
    for (const s of [main.current, vol.current, ...cmp.current]) if (s) c.removeSeries(s);
    main.current = vol.current = null;
    cmp.current = [];
    markers.current = null;
    zonesPrim.current = null; // primitives, markers and price lines go away with their series
    priceLines.current = [];
    typeRef.current = type;
    resRef.current = resolution;
    last.current = candles.length ? { ...candles[candles.length - 1] } : null;

    c.applyOptions({ rightPriceScale: { mode: comparing ? PriceScaleMode.Percentage : PriceScaleMode.Normal, scaleMargins: { top: 0.1, bottom: 0.22 } } });

    if (type === 'candles' && !comparing) {
      const s = c.addSeries(CandlestickSeries, {
        upColor: k.up, downColor: k.down, borderUpColor: k.up, borderDownColor: k.down, wickUpColor: k.up, wickDownColor: k.down,
      });
      s.setData(candles.map((b) => ({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
      main.current = s;
    } else {
      const s = c.addSeries(AreaSeries, { lineColor: k.accent, topColor: k.areaTop, bottomColor: k.areaBottom, lineWidth: 2, priceLineVisible: true });
      s.setData(candles.map((b) => ({ time: toTime(b.time), value: b.close })));
      main.current = s;
    }

    const v = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    v.setData(candles.map((b) => ({ time: toTime(b.time), value: b.volume, color: b.close >= b.open ? k.volUp : k.volDown })));
    vol.current = v;

    const start = candles[0]?.time ?? 0;
    for (const cs of compares) {
      if (!cs.candles.length) continue;
      const s = c.addSeries(LineSeries, { color: cs.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: cs.symbol });
      s.setData(cs.candles.filter((b) => b.time >= start).map((b) => ({ time: toTime(b.time), value: b.close })));
      cmp.current.push(s);
    }

    // Event markers (E = earnings, D = dividend).
    if (main.current) {
      const list: SeriesMarker<Time>[] = [];
      for (const [bar, e] of [...eventsByBar.entries()].sort((a, b) => a[0] - b[0])) {
        if (e.earnings.length) list.push({ time: toTime(bar), position: 'belowBar', shape: 'circle', color: k.accent, text: 'E', size: 1 });
        if (e.dividends.length) list.push({ time: toTime(bar), position: 'belowBar', shape: 'square', color: k.up, text: 'D', size: 1 });
      }
      markers.current = createSeriesMarkers(main.current, list);
    }

    applyOverlay();
    c.timeScale().fitContent();
  }, [candles, type, compares, comparing, resolution, applyOverlay, eventsByBar, theme]);

  useEffect(() => applyOverlay(), [zones, lines, applyOverlay]);

  // Crosshair tooltip.
  const indexByTime = useMemo(() => new Map(candles.map((c, i) => [c.time, i])), [candles]);
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const handler = (p: MouseEventParams<Time>) => {
      if (p.time == null || !p.point || p.point.x < 0 || p.point.y < 0) {
        setHover(null);
        return;
      }
      const i = indexByTime.get(p.time as number);
      if (i == null) {
        setHover(null);
        return;
      }
      const candle = last.current && last.current.time === candles[i].time ? last.current : candles[i];
      const pctFrom = (first: number | undefined, value: number | undefined) => (first && value != null ? ((value - first) / first) * 100 : null);
      const cmpPcts = compares.map((cs, j) => {
        const s = cmp.current[j];
        const d = s ? (p.seriesData.get(s) as { value?: number } | undefined) : undefined;
        const first = cs.candles.find((b) => b.time >= (candles[0]?.time ?? 0))?.close;
        return { symbol: cs.symbol, color: cs.color, pct: pctFrom(first, d?.value) };
      });
      const ev = eventsByBar.get(candles[i].time);
      setHover({
        x: p.point.x,
        y: p.point.y,
        candle,
        prevClose: i > 0 ? candles[i - 1].close : null,
        compares: comparing ? cmpPcts : [],
        mainPct: comparing ? pctFrom(candles[0]?.close, candle.close) : null,
        earnings: ev?.earnings ?? [],
        dividends: ev?.dividends ?? [],
      });
    };
    c.subscribeCrosshairMove(handler);
    return () => c.unsubscribeCrosshairMove(handler);
  }, [candles, compares, comparing, indexByTime, eventsByBar]);

  // Live tick → update the last candle in place (or open a new one).
  const onTick = useCallback((tick: LiveTick) => {
    const s = main.current;
    const prev = last.current;
    const k = colors.current;
    if (!s || !prev || !k) return;
    // Step from the last bar's own start time, so we follow the provider's bar alignment.
    const size = RESOLUTION_SECONDS[resRef.current];
    const tickSec = Math.floor(tick.ts / 1000);
    if (tickSec < prev.time) return;
    const tm = prev.time + Math.floor((tickSec - prev.time) / size) * size;
    const bar: Candle =
      tm === prev.time
        ? { ...prev, high: Math.max(prev.high, tick.price), low: Math.min(prev.low, tick.price), close: tick.price, volume: prev.volume + (tick.volume ?? 0) }
        : { time: tm, open: prev.close, high: Math.max(prev.close, tick.price), low: Math.min(prev.close, tick.price), close: tick.price, volume: tick.volume ?? 0 };
    last.current = bar;
    if (typeRef.current === 'candles' && cmp.current.length === 0) {
      (s as ISeriesApi<'Candlestick'>).update({ time: toTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } else {
      (s as ISeriesApi<'Area'>).update({ time: toTime(bar.time), value: bar.close });
    }
    vol.current?.update({ time: toTime(bar.time), value: bar.volume, color: bar.close >= bar.open ? k.volUp : k.volDown });
  }, []);

  useTickListener(symbol, live, onTick);

  return (
    <div ref={wrap} className="relative">
      <div ref={el} role="img" aria-label={ariaLabel} className="chart-h w-full" />
      {hover && <Tooltip hover={hover} resolution={resolution} currency={currency} width={wrap.current?.clientWidth ?? 0} />}
    </div>
  );
}

function Tooltip({ hover, resolution, currency, width }: { hover: Hover; resolution: Resolution; currency: string; width: number }) {
  const t = useTranslations('chart');
  const lang = useLang();
  const daily = resolution === '1day' || resolution === '1week';
  const loc = intlLocale(lang);
  const when = new Intl.DateTimeFormat(loc, daily
    ? { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(hover.candle.time * 1000));
  const c = hover.candle;
  const chg = hover.prevClose ? ((c.close - hover.prevClose) / hover.prevClose) * 100 : null;
  const p = (n: number) => fmtNumber(n, lang);
  // Keep it inside the chart: flip to the left of the cursor near the right edge.
  const left = hover.x + 16 + 220 > width ? Math.max(4, hover.x - 16 - 220) : hover.x + 16;
  return (
    <div
      role="status"
      aria-live="off"
      className="pointer-events-none absolute top-2 z-10 w-[220px] rounded-md border border-border bg-panel/95 p-2 text-xs shadow-lg backdrop-blur"
      style={{ left }}
    >
      <p className="font-medium text-text">{when}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
        <dt className="font-sans text-muted">{t('ohlc.open')}</dt><dd className="text-right">{p(c.open)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.high')}</dt><dd className="text-right">{p(c.high)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.low')}</dt><dd className="text-right">{p(c.low)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.close')}</dt><dd className="text-right">{p(c.close)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.volume')}</dt><dd className="text-right">{fmtCompact(c.volume, lang)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.change')}</dt>
        <dd className={cx('text-right', chg == null ? 'text-muted' : chg >= 0 ? 'text-up' : 'text-down')}>
          {chg != null && <span aria-hidden>{chg >= 0 ? '▲ ' : '▼ '}</span>}
          {fmtSignedPct(chg, lang)}
        </dd>
      </dl>
      {hover.compares.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
          {hover.mainPct != null && (
            <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-accent" aria-hidden />{t('thisSymbol')}<span className="ml-auto font-mono">{fmtSignedPct(hover.mainPct, lang)}</span></li>
          )}
          {hover.compares.map((x) => (
            <li key={x.symbol} className="flex items-center gap-1.5"><span className="h-0.5 w-3" style={{ background: x.color }} aria-hidden />{x.symbol}<span className="ml-auto font-mono">{fmtSignedPct(x.pct, lang)}</span></li>
          ))}
        </ul>
      )}
      {(hover.earnings.length > 0 || hover.dividends.length > 0) && (
        <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5">
          {hover.earnings.map((e) => (
            <li key={`e${e.date}`}>
              <span className="mr-1 inline-grid size-4 place-items-center rounded-full bg-accent text-[10px] font-bold text-panel" aria-hidden>E</span>
              {t('events.earnings')} · {e.date}
              <span className="block pl-5 text-muted">
                {e.epsActual != null
                  ? t('events.epsVs', { actual: fmtPrice(e.epsActual, lang, currency), estimate: e.epsEstimate != null ? fmtPrice(e.epsEstimate, lang, currency) : '—' })
                  : t('events.epsEst', { estimate: e.epsEstimate != null ? fmtPrice(e.epsEstimate, lang, currency) : '—' })}
                {e.epsActual != null && e.epsEstimate ? ` (${fmtSignedPct(((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate)) * 100, lang)})` : ''}
              </span>
            </li>
          ))}
          {hover.dividends.map((d) => (
            <li key={`d${d.exDate}`}>
              <span className="mr-1 inline-grid size-4 place-items-center rounded-sm bg-up text-[10px] font-bold text-panel" aria-hidden>D</span>
              {t('events.dividend')} · {fmtPrice(d.amount, lang, currency)}
              <span className="block pl-5 text-muted">{t('events.exDate', { date: d.exDate })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
