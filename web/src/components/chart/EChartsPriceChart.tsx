'use client';

import {
  RESOLUTION_SECONDS,
  type Candle,
  type DividendEvent,
  type EarningsReport,
  type Resolution,
} from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtCompact, fmtNumber, fmtPrice, fmtSignedPct, intlLocale } from '@/lib/format';
import { useTickListener, type LiveTick } from '@/lib/live';
import type { Zone } from '../level-zones';
import type { ChartLine, CompareSeries } from '../PriceChart';
import { cx, useLang } from '../ui';
import { echarts, type EChartsInstance } from './echarts-setup';
import {
  adaptCandlesToECharts,
  adaptComparisonData,
  updateCandlesWithTick,
} from './ChartDataAdapter';
import {
  computeIndicators,
  OVERLAY_CONFIGS,
  PANEL_CONFIGS,
  type OverlayIndicatorKey,
  type PanelIndicatorKey,
} from './ChartIndicatorEngine';
import {
  buildCorporateEventsMarkPoint,
  buildPivotsMarkLine,
  buildZonesMarkArea,
  groupEventsByCandleBar,
} from './ChartOverlayManager';
import {
  buildDrawingsMarkLines,
  type ChartDrawing,
  type DrawingType,
} from './ChartDrawingManager';
import { ChartToolbar, type ExtendedChartType } from './ChartToolbar';

interface Props {
  symbol: string;
  candles: Candle[];
  resolution: Resolution;
  type: 'line' | 'candles' | 'area';
  onChangeType?: (type: 'line' | 'candles' | 'area') => void;
  live: boolean;
  compares?: CompareSeries[];
  zones?: Zone[];
  lines?: ChartLine[];
  events?: { earnings: EarningsReport[]; dividends: DividendEvent[] } | null;
  theme: string;
  currency?: string;
  ariaLabel: string;
}

const NONE_Z: Zone[] = [];
const NONE_L: ChartLine[] = [];
const NONE_C: CompareSeries[] = [];

/** Theme colors from CSS variables in globals.css */
function getThemeColors() {
  if (typeof window === 'undefined') {
    return {
      panel: '#151a21',
      panel2: '#1a2029',
      border: '#222935',
      text: '#e6eaf0',
      muted: '#9aa4b2',
      accent: '#4c8dff',
      up: '#3ddc97',
      down: '#ff7b7b',
      grid: '#1c222c',
      areaTop: 'rgba(76,141,255,0.28)',
      areaBottom: 'rgba(76,141,255,0.02)',
      volUp: 'rgba(61,220,151,0.35)',
      volDown: 'rgba(255,123,123,0.35)',
    };
  }
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    panel: v('--color-panel', '#151a21'),
    panel2: v('--color-panel-2', '#1a2029'),
    border: v('--color-border', '#222935'),
    text: v('--color-text', '#e6eaf0'),
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

interface HoverState {
  x: number;
  y: number;
  candle: Candle;
  prevClose: number | null;
  compares: { symbol: string; color: string; pct: number | null }[];
  mainPct: number | null;
  earnings: EarningsReport[];
  dividends: DividendEvent[];
  indicators: { label: string; color: string; value: number | string }[];
}

const PREF_KEY = 'tm_chart_terminal_preferences';

export function EChartsPriceChart({
  symbol,
  candles: initialCandles,
  resolution,
  type: initialType,
  onChangeType,
  live,
  compares = NONE_C,
  zones = NONE_Z,
  lines = NONE_L,
  events,
  theme,
  currency = 'USD',
  ariaLabel,
}: Props) {
  const lang = useLang();
  const loc = intlLocale(lang);
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<EChartsInstance | null>(null);

  // Local state for dynamic chart features
  const [candles, setCandles] = useState<Candle[]>(initialCandles);
  const [chartType, setChartType] = useState<ExtendedChartType>(initialType as ExtendedChartType);
  const [activeOverlays, setActiveOverlays] = useState<OverlayIndicatorKey[]>([]);
  const [activePanel, setActivePanel] = useState<PanelIndicatorKey | null>(null);
  const [drawings, setDrawings] = useState<ChartDrawing[]>([]);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Viewport zoom state preservation and structure tracking
  const currentZoomRef = useRef<{ start: number; end: number } | null>(null);
  const prevStructureRef = useRef<string>('');

  const comparing = compares.some((c) => c.candles.length > 0);

  // Sync incoming initial candles when symbol or range changes
  useEffect(() => {
    currentZoomRef.current = null;
    setCandles(initialCandles);
  }, [initialCandles, symbol, resolution]);

  // Sync initial chart type when prop changes
  useEffect(() => {
    if (initialType && initialType !== chartType) {
      setChartType(initialType as ExtendedChartType);
    }
  }, [initialType]);

  // Load user chart preferences from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PREF_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.chartType && ['candles', 'line', 'area'].includes(parsed.chartType)) {
          setChartType(parsed.chartType);
          onChangeType?.(parsed.chartType);
        }
        if (Array.isArray(parsed.activeOverlays)) {
          setActiveOverlays(parsed.activeOverlays);
        }
        if (parsed.activePanel !== undefined) {
          setActivePanel(parsed.activePanel);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [onChangeType]);

  // Save preferences
  const savePrefs = useCallback(
    (newType: ExtendedChartType, newOverlays: OverlayIndicatorKey[], newPanel: PanelIndicatorKey | null) => {
      try {
        localStorage.setItem(
          PREF_KEY,
          JSON.stringify({ chartType: newType, activeOverlays: newOverlays, activePanel: newPanel }),
        );
      } catch {
        // Ignore localStorage errors
      }
    },
    [],
  );

  const handleToggleOverlay = useCallback(
    (key: OverlayIndicatorKey) => {
      setActiveOverlays((prev) => {
        const updated = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
        savePrefs(chartType, updated, activePanel);
        return updated;
      });
    },
    [chartType, activePanel, savePrefs],
  );

  const handleSelectPanel = useCallback(
    (panel: PanelIndicatorKey | null) => {
      setActivePanel(panel);
      savePrefs(chartType, activeOverlays, panel);
    },
    [chartType, activeOverlays, savePrefs],
  );

  const handleChangeChartType = useCallback(
    (type: ExtendedChartType) => {
      setChartType(type);
      savePrefs(type, activeOverlays, activePanel);
      onChangeType?.(type);
    },
    [activeOverlays, activePanel, savePrefs, onChangeType],
  );

  // Corporate events map by bar time
  const eventsByBar = useMemo(
    () => groupEventsByCandleBar(events, candles, resolution),
    [events, candles, resolution],
  );

  // Theme colors
  const colors = useMemo(() => getThemeColors(), [theme]);

  // Format dataset
  const formattedData = useMemo(
    () => adaptCandlesToECharts(candles, resolution, colors, loc),
    [candles, resolution, colors, loc],
  );

  // Compute indicators
  const indicators = useMemo(
    () => computeIndicators(candles, activeOverlays, activePanel),
    [candles, activeOverlays, activePanel],
  );

  // Comparison normalization
  const comparisonData = useMemo(
    () => (comparing ? adaptComparisonData(candles, compares) : null),
    [candles, compares, comparing],
  );

  // Keep latest mutable props in ref to prevent stale closures in chart event listeners
  const latestPropsRef = useRef({
    candles,
    compares,
    comparisonData,
    eventsByBar,
    activeOverlays,
    activePanel,
    indicators,
    comparing,
    colors,
  });

  useEffect(() => {
    latestPropsRef.current = {
      candles,
      compares,
      comparisonData,
      eventsByBar,
      activeOverlays,
      activePanel,
      indicators,
      comparing,
      colors,
    };
  });

  // Initialize and dispose ECharts instance
  useEffect(() => {
    if (!containerRef.current) return;

    // useDirtyRect: false is essential to prevent partial canvas bounding box clear
    // artifacts / rectangular holes in candlesticks and volume bars across multi-grid layouts
    const chart = echarts.init(containerRef.current, null, {
      renderer: 'canvas',
      useDirtyRect: false,
    });
    chartInstance.current = chart;

    const handleResize = () => {
      chart.resize();
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Track user viewport zoom/pan
    chart.on('datazoom', (params: any) => {
      let start: number | undefined;
      let end: number | undefined;
      if (params.batch && params.batch.length > 0) {
        start = params.batch[0].start;
        end = params.batch[0].end;
      } else {
        start = params.start;
        end = params.end;
      }
      if (typeof start === 'number' && typeof end === 'number') {
        currentZoomRef.current = { start, end };
      }
    });

    // Crosshair hover tracking using latestPropsRef
    chart.on('updateAxisPointer', (event: any) => {
      const {
        candles: curCandles,
        compares: curCompares,
        comparisonData: curComparisonData,
        eventsByBar: curEventsByBar,
        activeOverlays: curActiveOverlays,
        activePanel: curActivePanel,
        indicators: curIndicators,
        comparing: curComparing,
        colors: curColors,
      } = latestPropsRef.current;

      const dataInfo = event.dataInfo;
      let dataIndex: number | null = null;
      if (event.axesInfo && event.axesInfo.length > 0) {
        dataIndex = event.axesInfo[0].value;
      } else if (dataInfo && dataInfo.dataIndex != null) {
        dataIndex = dataInfo.dataIndex;
      }

      if (dataIndex == null || dataIndex < 0 || dataIndex >= curCandles.length) {
        setHover(null);
        return;
      }

      const candle = curCandles[dataIndex];
      const prevClose = dataIndex > 0 ? curCandles[dataIndex - 1].close : null;

      // Compares percentage
      const cmpList = curCompares.map((cs, j) => {
        const val = curComparisonData?.compareSeries[j]?.data[dataIndex];
        return { symbol: cs.symbol, color: cs.color, pct: val ?? null };
      });

      const mainPct = curComparisonData ? curComparisonData.basePct[dataIndex] : null;
      const barEvents = curEventsByBar.get(candle.time);

      // Indicator inspection
      const indList: { label: string; color: string; value: number | string }[] = [];
      for (const k of curActiveOverlays) {
        const conf = OVERLAY_CONFIGS[k];
        if (k === 'bollinger' && curIndicators.bollinger) {
          const mid = curIndicators.bollinger.middle[dataIndex];
          const up = curIndicators.bollinger.upper[dataIndex];
          const low = curIndicators.bollinger.lower[dataIndex];
          if (mid != null) indList.push({ label: 'BB Mid', color: conf.color, value: mid.toFixed(2) });
          if (up != null) indList.push({ label: 'BB Upper', color: conf.color, value: up.toFixed(2) });
          if (low != null) indList.push({ label: 'BB Lower', color: conf.color, value: low.toFixed(2) });
        } else {
          const series = (curIndicators as any)[k] as (number | null)[] | undefined;
          if (series && series[dataIndex] != null) {
            indList.push({ label: conf.label, color: conf.color, value: series[dataIndex]!.toFixed(2) });
          }
        }
      }

      if (curActivePanel) {
        const conf = PANEL_CONFIGS[curActivePanel];
        if (curActivePanel === 'macd' && curIndicators.macd) {
          const m = curIndicators.macd.macd[dataIndex];
          const s = curIndicators.macd.signal[dataIndex];
          const h = curIndicators.macd.histogram[dataIndex];
          if (m != null) indList.push({ label: 'MACD', color: '#38bdf8', value: m.toFixed(2) });
          if (s != null) indList.push({ label: 'Signal', color: '#f43f5e', value: s.toFixed(2) });
          if (h != null) indList.push({ label: 'Hist', color: h >= 0 ? curColors.up : curColors.down, value: h.toFixed(2) });
        } else if (curActivePanel === 'adx' && curIndicators.adx) {
          const a = curIndicators.adx.adx[dataIndex];
          const p = curIndicators.adx.plusDI[dataIndex];
          const m = curIndicators.adx.minusDI[dataIndex];
          if (a != null) indList.push({ label: 'ADX', color: conf.color, value: a.toFixed(2) });
          if (p != null) indList.push({ label: '+DI', color: curColors.up, value: p.toFixed(2) });
          if (m != null) indList.push({ label: '-DI', color: curColors.down, value: m.toFixed(2) });
        } else {
          const series = (curIndicators as any)[curActivePanel] as (number | null)[] | undefined;
          if (series && series[dataIndex] != null) {
            indList.push({ label: conf.label, color: conf.color, value: series[dataIndex]!.toFixed(2) });
          }
        }
      }

      // Tooltip position
      const point = chart.convertToPixel({ gridIndex: 0 }, [dataIndex, candle.close]);
      setHover({
        x: Array.isArray(point) ? point[0] : 100,
        y: Array.isArray(point) ? point[1] : 50,
        candle,
        prevClose,
        compares: curComparing ? cmpList : [],
        mainPct,
        earnings: barEvents?.earnings ?? [],
        dividends: barEvents?.dividends ?? [],
        indicators: indList,
      });
    });

    chart.getZr().on('globalout', () => {
      setHover(null);
    });

    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartInstance.current = null;
      prevStructureRef.current = '';
    };
  }, []);

  // Update chart option whenever data, dimensions, or styling change
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || candles.length === 0) return;

    const hasPanel = activePanel !== null;

    // Grid Layout
    const grids = hasPanel
      ? [
          { left: 16, right: 65, top: 32, height: '48%' }, // 0: Price
          { left: 16, right: 65, top: '56%', height: '14%' }, // 1: Volume
          { left: 16, right: 65, top: '74%', height: '16%' }, // 2: Sub-Panel
        ]
      : [
          { left: 16, right: 65, top: 32, height: '64%' }, // 0: Price
          { left: 16, right: 65, top: '72%', height: '18%' }, // 1: Volume
        ];

    // X-Axes
    const xAxes = grids.map((_, i) => ({
      type: 'category' as const,
      gridIndex: i,
      data: formattedData.categories,
      boundaryGap: true,
      axisLine: { lineStyle: { color: colors.border } },
      axisTick: { show: i === grids.length - 1 },
      axisLabel: {
        show: i === grids.length - 1,
        color: colors.muted,
        fontSize: 10,
        fontFamily: 'monospace',
      },
      axisPointer: {
        show: true,
        type: 'line' as const,
        lineStyle: { color: colors.muted, width: 1, type: 'dashed' as const },
        label: {
          show: i === grids.length - 1,
          backgroundColor: colors.border,
          color: colors.text,
        },
      },
      splitLine: { show: false },
    }));

    // Y-Axes
    const yAxes: any[] = [
      {
        gridIndex: 0,
        position: 'right' as const,
        scale: true,
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { lineStyle: { color: colors.grid } },
        axisLabel: {
          color: colors.muted,
          fontSize: 10,
          fontFamily: 'monospace',
          formatter: (v: number) =>
            comparing ? fmtSignedPct(v, lang) : fmtPrice(v, lang, currency),
        },
      },
      {
        gridIndex: 1,
        position: 'right' as const,
        splitNumber: 2,
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { lineStyle: { color: colors.grid } },
        axisLabel: {
          color: colors.muted,
          fontSize: 9,
          fontFamily: 'monospace',
          formatter: (v: number) => fmtCompact(v, lang),
        },
      },
    ];

    if (hasPanel) {
      yAxes.push({
        gridIndex: 2,
        position: 'right' as const,
        scale: true,
        splitNumber: 2,
        axisLine: { lineStyle: { color: colors.border } },
        splitLine: { lineStyle: { color: colors.grid } },
        axisLabel: {
          color: colors.muted,
          fontSize: 9,
          fontFamily: 'monospace',
          formatter: (v: number) => v.toFixed(1),
        },
      });
    }

    // Build Series
    const seriesList: any[] = [];

    // MarkArea (S/R Zones) and MarkLine (Pivots & Drawings)
    const zonesMarkArea = !comparing ? buildZonesMarkArea(zones) : undefined;
    const pivotsMarkLine = !comparing ? buildPivotsMarkLine(lines) : undefined;
    const drawingsMarkLine = buildDrawingsMarkLines(drawings, formattedData.categories);
    const combinedMarkLine =
      pivotsMarkLine || drawingsMarkLine.length > 0
        ? {
            silent: true,
            symbol: 'none',
            data: [...(pivotsMarkLine?.data ?? []), ...drawingsMarkLine],
          }
        : undefined;

    const eventsMarkPoint = !comparing
      ? buildCorporateEventsMarkPoint(eventsByBar, candles, formattedData.categories)
      : undefined;

    if (comparing && comparisonData) {
      // Comparison Mode: Base stock as line (%)
      seriesList.push({
        name: symbol,
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: comparisonData.basePct,
        lineStyle: { width: 2, color: colors.accent },
        itemStyle: { color: colors.accent },
        showSymbol: false,
        markArea: zonesMarkArea,
        markLine: combinedMarkLine,
      });

      // Compared symbols lines
      comparisonData.compareSeries.forEach((cs) => {
        seriesList.push({
          name: cs.symbol,
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: cs.data,
          lineStyle: { width: 2, color: cs.color },
          itemStyle: { color: cs.color },
          showSymbol: false,
        });
      });
    } else {
      // Normal Mode
      if (chartType === 'candles') {
        seriesList.push({
          name: symbol,
          type: 'candlestick',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: formattedData.candlestickData,
          itemStyle: {
            color: colors.up,
            color0: colors.down,
            borderColor: colors.up,
            borderColor0: colors.down,
          },
          markArea: zonesMarkArea,
          markLine: combinedMarkLine,
          markPoint: eventsMarkPoint,
        });
      } else {
        // Line or Area
        seriesList.push({
          name: symbol,
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: formattedData.lineData,
          lineStyle: { width: 2, color: colors.accent },
          itemStyle: { color: colors.accent },
          showSymbol: false,
          areaStyle:
            chartType === 'area'
              ? {
                  color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: colors.areaTop },
                    { offset: 1, color: colors.areaBottom },
                  ]),
                }
              : undefined,
          markArea: zonesMarkArea,
          markLine: combinedMarkLine,
          markPoint: eventsMarkPoint,
        });
      }

      // Overlays
      for (const k of activeOverlays) {
        const conf = OVERLAY_CONFIGS[k];
        if (k === 'bollinger' && indicators.bollinger) {
          seriesList.push({
            name: 'BB Mid',
            type: 'line',
            xAxisIndex: 0,
            yAxisIndex: 0,
            data: indicators.bollinger.middle,
            lineStyle: { width: 1, color: conf.color, type: 'dashed' },
            showSymbol: false,
          });
          seriesList.push({
            name: 'BB Upper',
            type: 'line',
            xAxisIndex: 0,
            yAxisIndex: 0,
            data: indicators.bollinger.upper,
            lineStyle: { width: 1, color: conf.color },
            showSymbol: false,
          });
          seriesList.push({
            name: 'BB Lower',
            type: 'line',
            xAxisIndex: 0,
            yAxisIndex: 0,
            data: indicators.bollinger.lower,
            lineStyle: { width: 1, color: conf.color },
            showSymbol: false,
          });
        } else {
          const s = (indicators as any)[k] as (number | null)[] | undefined;
          if (s) {
            seriesList.push({
              name: conf.label,
              type: 'line',
              xAxisIndex: 0,
              yAxisIndex: 0,
              data: s,
              lineStyle: { width: 1.5, color: conf.color },
              showSymbol: false,
            });
          }
        }
      }
    }

    // Volume Series (Grid 1)
    seriesList.push({
      name: 'Volume',
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: formattedData.volumeData,
      barWidth: '60%',
    });

    // Sub-Panel Series (Grid 2)
    if (activePanel) {
      const conf = PANEL_CONFIGS[activePanel];
      if (activePanel === 'rsi' && indicators.rsi) {
        seriesList.push({
          name: 'RSI 14',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.rsi,
          lineStyle: { width: 1.5, color: conf.color },
          showSymbol: false,
          markLine: {
            silent: true,
            symbol: 'none',
            data: [
              { yAxis: 70, lineStyle: { color: colors.down, type: 'dashed' } },
              { yAxis: 30, lineStyle: { color: colors.up, type: 'dashed' } },
            ],
          },
          markArea: {
            silent: true,
            data: [
              [
                { yAxis: 30, itemStyle: { color: 'rgba(76,141,255,0.05)' } },
                { yAxis: 70 },
              ],
            ],
          },
        });
      } else if (activePanel === 'macd' && indicators.macd) {
        seriesList.push({
          name: 'MACD',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.macd.macd,
          lineStyle: { width: 1.5, color: '#38bdf8' },
          showSymbol: false,
        });
        seriesList.push({
          name: 'Signal',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.macd.signal,
          lineStyle: { width: 1.5, color: '#f43f5e' },
          showSymbol: false,
        });
        seriesList.push({
          name: 'Histogram',
          type: 'bar',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.macd.histogram.map((val) => ({
            value: val,
            itemStyle: { color: (val ?? 0) >= 0 ? colors.up : colors.down },
          })),
        });
      } else if (activePanel === 'atr' && indicators.atr) {
        seriesList.push({
          name: 'ATR 14',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.atr,
          lineStyle: { width: 1.5, color: conf.color },
          showSymbol: false,
        });
      } else if (activePanel === 'adx' && indicators.adx) {
        seriesList.push({
          name: 'ADX',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.adx.adx,
          lineStyle: { width: 1.5, color: conf.color },
          showSymbol: false,
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ yAxis: 25, lineStyle: { color: colors.muted, type: 'dashed' } }],
          },
        });
        seriesList.push({
          name: '+DI',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.adx.plusDI,
          lineStyle: { width: 1, color: colors.up },
          showSymbol: false,
        });
        seriesList.push({
          name: '-DI',
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: indicators.adx.minusDI,
          lineStyle: { width: 1, color: colors.down },
          showSymbol: false,
        });
      }
    }

    const defaultZoomStart = candles.length > 80 ? Math.max(0, 100 - (80 / candles.length) * 100) : 0;
    const zoomStart = currentZoomRef.current ? currentZoomRef.current.start : defaultZoomStart;
    const zoomEnd = currentZoomRef.current ? currentZoomRef.current.end : 100;

    const structureKey = `${symbol}_${resolution}_${chartType}_${activeOverlays.slice().sort().join(',')}_${activePanel}_${comparing}_${theme}_${currency}_${lang}`;
    const hasExistingGrid = Boolean(chart.getOption()?.grid);
    const isStructureChange = !hasExistingGrid || prevStructureRef.current !== structureKey;
    prevStructureRef.current = structureKey;

    if (!isStructureChange) {
      // Data-only update (e.g. streaming ticks or candle updates):
      // Update series and axes smoothly without tearing down grid layout or resetting user zoom
      chart.setOption(
        {
          xAxis: xAxes,
          yAxis: yAxes,
          series: seriesList,
        },
        { notMerge: false, replaceMerge: ['series'] },
      );
    } else {
      // Structural re-render: layout, indicators, timeframe, compare or theme changed
      chart.setOption(
        {
          animation: false,
          backgroundColor: 'transparent',
          grid: grids,
          xAxis: xAxes,
          yAxis: yAxes,
          axisPointer: {
            link: [{ xAxisIndex: 'all' }],
          },
          dataZoom: [
            {
              type: 'inside',
              xAxisIndex: grids.map((_, i) => i),
              start: zoomStart,
              end: zoomEnd,
            },
            {
              type: 'slider',
              xAxisIndex: grids.map((_, i) => i),
              bottom: 2,
              height: 14,
              borderColor: 'transparent',
              backgroundColor: 'transparent',
              fillerColor: 'rgba(76,141,255,0.12)',
              showDetail: false,
              handleSize: '60%',
            },
          ],
          series: seriesList,
        },
        { notMerge: true },
      );
    }
  }, [
    candles,
    chartType,
    activeOverlays,
    activePanel,
    comparing,
    comparisonData,
    formattedData,
    indicators,
    zones,
    lines,
    drawings,
    eventsByBar,
    colors,
    lang,
    currency,
    symbol,
    resolution,
  ]);

  // Handle Live Quote Ticks: single consistent update lifecycle
  const onTick = useCallback(
    (tick: LiveTick) => {
      setCandles((prev) => {
        const { updatedCandles } = updateCandlesWithTick(prev, tick, resolution);
        return updatedCandles;
      });
    },
    [resolution],
  );

  useTickListener(symbol, live, onTick);

  // Reset zoom action
  const handleResetZoom = useCallback(() => {
    currentZoomRef.current = null;
    chartInstance.current?.dispatchAction({
      type: 'dataZoom',
      start: 0,
      end: 100,
    });
  }, []);

  // Fullscreen action
  const handleToggleFullscreen = useCallback(() => {
    if (!wrapRef.current) return;
    if (!document.fullscreenElement) {
      wrapRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  // Export PNG action
  const handleExportPng = useCallback(() => {
    const chart = chartInstance.current;
    if (!chart) return;
    const url = chart.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: colors.panel,
    });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${symbol}_${resolution}_chart.png`;
    a.click();
  }, [symbol, resolution, colors.panel]);

  // Drawings action
  const handleAddDrawing = useCallback((type: DrawingType) => {
    if (candles.length < 2) return;
    const lastIdx = candles.length - 1;
    const midIdx = Math.max(0, lastIdx - 20);
    const lastPrice = candles[lastIdx].close;
    const midPrice = candles[midIdx].close;

    if (type === 'horizontal') {
      const newD: ChartDrawing = {
        id: `h_${Date.now()}`,
        type: 'horizontal',
        price: lastPrice,
        color: '#f5c45e',
      };
      setDrawings((prev) => [...prev, newD]);
    } else if (type === 'trendline') {
      const newD: ChartDrawing = {
        id: `t_${Date.now()}`,
        type: 'trendline',
        startIndex: midIdx,
        startPrice: midPrice,
        endIndex: lastIdx,
        endPrice: lastPrice,
        color: '#4c8dff',
      };
      setDrawings((prev) => [...prev, newD]);
    } else if (type === 'measure') {
      const newD: ChartDrawing = {
        id: `m_${Date.now()}`,
        type: 'measure',
        startIndex: midIdx,
        startPrice: midPrice,
        endIndex: lastIdx,
        endPrice: lastPrice,
        color: '#3ddc97',
      };
      setDrawings((prev) => [...prev, newD]);
    }
  }, [candles]);

  const handleClearDrawings = useCallback(() => {
    setDrawings([]);
  }, []);

  return (
    <div
      ref={wrapRef}
      className={cx(
        'relative flex flex-col w-full rounded-xl border border-border bg-panel overflow-hidden',
        isFullscreen ? 'fixed inset-0 z-50 h-screen w-screen p-2 bg-panel' : '',
      )}
    >
      {/* Top Toolbar */}
      <ChartToolbar
        chartType={chartType}
        onChangeChartType={handleChangeChartType}
        activeOverlays={activeOverlays}
        onToggleOverlay={handleToggleOverlay}
        activePanel={activePanel}
        onSelectPanel={handleSelectPanel}
        comparing={comparing}
        onResetZoom={handleResetZoom}
        onToggleFullscreen={handleToggleFullscreen}
        isFullscreen={isFullscreen}
        onExportPng={handleExportPng}
        onAddDrawing={handleAddDrawing}
        onClearDrawings={handleClearDrawings}
        hasDrawings={drawings.length > 0}
      />

      {/* Main ECharts Canvas Container */}
      <div className="relative w-full">
        <div
          ref={containerRef}
          role="img"
          aria-label={ariaLabel}
          className={cx('w-full', isFullscreen ? 'h-[calc(100vh-60px)]' : 'chart-h')}
        />

        {/* OHLCV & Crosshair Tooltip */}
        {hover && (
          <EChartsTooltip
            hover={hover}
            resolution={resolution}
            currency={currency}
            width={wrapRef.current?.clientWidth ?? 0}
          />
        )}
      </div>
    </div>
  );
}

function EChartsTooltip({
  hover,
  resolution,
  currency,
  width,
}: {
  hover: HoverState;
  resolution: Resolution;
  currency: string;
  width: number;
}) {
  const t = useTranslations('chart');
  const lang = useLang();
  const daily = resolution === '1day' || resolution === '1week';
  const loc = intlLocale(lang);
  const when = new Intl.DateTimeFormat(
    loc,
    daily
      ? { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
      : {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        },
  ).format(new Date(hover.candle.time * 1000));

  const c = hover.candle;
  const chg = hover.prevClose ? ((c.close - hover.prevClose) / hover.prevClose) * 100 : null;
  const p = (n: number) => fmtNumber(n, lang);
  const left = hover.x + 16 + 240 > width ? Math.max(4, hover.x - 16 - 240) : hover.x + 16;

  return (
    <div
      role="status"
      aria-live="off"
      className="pointer-events-none absolute top-2 z-20 w-[240px] rounded-md border border-border bg-panel/95 p-2 text-xs shadow-xl backdrop-blur"
      style={{ left }}
    >
      <p className="font-medium text-text">{when}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
        <dt className="font-sans text-muted">{t('ohlc.open')}</dt>
        <dd className="text-right">{p(c.open)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.high')}</dt>
        <dd className="text-right">{p(c.high)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.low')}</dt>
        <dd className="text-right">{p(c.low)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.close')}</dt>
        <dd className="text-right">{p(c.close)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.volume')}</dt>
        <dd className="text-right">{fmtCompact(c.volume, lang)}</dd>
        <dt className="font-sans text-muted">{t('ohlc.change')}</dt>
        <dd className={cx('text-right', chg == null ? 'text-muted' : chg >= 0 ? 'text-up' : 'text-down')}>
          {chg != null && <span aria-hidden>{chg >= 0 ? '▲ ' : '▼ '}</span>}
          {fmtSignedPct(chg, lang)}
        </dd>
      </dl>

      {/* Compared Symbols */}
      {hover.compares.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
          {hover.mainPct != null && (
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 bg-accent" aria-hidden />
              {t('thisSymbol')}
              <span className="ml-auto font-mono">{fmtSignedPct(hover.mainPct, lang)}</span>
            </li>
          )}
          {hover.compares.map((x) => (
            <li key={x.symbol} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3" style={{ background: x.color }} aria-hidden />
              {x.symbol}
              <span className="ml-auto font-mono">{fmtSignedPct(x.pct, lang)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Indicator Values */}
      {hover.indicators.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5 font-mono text-[11px]">
          {hover.indicators.map((ind, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: ind.color }} />
              <span className="text-muted">{ind.label}:</span>
              <span className="ml-auto text-text">{ind.value}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Events: Earnings & Dividends */}
      {(hover.earnings.length > 0 || hover.dividends.length > 0) && (
        <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5">
          {hover.earnings.map((e) => (
            <li key={`e${e.date}`}>
              <span className="mr-1 inline-grid size-4 place-items-center rounded-full bg-accent text-[10px] font-bold text-panel" aria-hidden>
                E
              </span>
              {t('events.earnings')} · {e.date}
              <span className="block pl-5 text-muted">
                {e.epsActual != null
                  ? t('events.epsVs', {
                      actual: fmtPrice(e.epsActual, lang, currency),
                      estimate: e.epsEstimate != null ? fmtPrice(e.epsEstimate, lang, currency) : '—',
                    })
                  : t('events.epsEst', {
                      estimate: e.epsEstimate != null ? fmtPrice(e.epsEstimate, lang, currency) : '—',
                    })}
                {e.epsActual != null && e.epsEstimate
                  ? ` (${fmtSignedPct(((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate)) * 100, lang)})`
                  : ''}
              </span>
            </li>
          ))}
          {hover.dividends.map((d) => (
            <li key={`d${d.exDate}`}>
              <span className="mr-1 inline-grid size-4 place-items-center rounded-sm bg-up text-[10px] font-bold text-panel" aria-hidden>
                D
              </span>
              {t('events.dividend')} · {fmtPrice(d.amount, lang, currency)}
              <span className="block pl-5 text-muted">{t('events.exDate', { date: d.exDate })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
