import { describe, expect, it } from 'vitest';
import type { Candle, DividendEvent, EarningsReport } from '@tm/shared';
import {
  adaptCandlesToECharts,
  adaptComparisonData,
  formatCategoryTime,
  updateCandlesWithTick,
} from '../../../web/src/components/chart/ChartDataAdapter';
import {
  computeIndicators,
} from '../../../web/src/components/chart/ChartIndicatorEngine';
import {
  buildCorporateEventsMarkPoint,
  buildPivotsMarkLine,
  buildZonesMarkArea,
  groupEventsByCandleBar,
} from '../../../web/src/components/chart/ChartOverlayManager';
import {
  buildDrawingsMarkLines,
  type ChartDrawing,
} from '../../../web/src/components/chart/ChartDrawingManager';

describe('ECharts Trading Terminal — ChartDataAdapter', () => {
  const sampleCandles: Candle[] = [
    { time: 1700000000, open: 100, high: 105, low: 98, close: 103, volume: 15000 },
    { time: 1700086400, open: 103, high: 107, low: 101, close: 102, volume: 18000 }, // Bearish
    { time: 1700172800, open: 102, high: 110, low: 102, close: 109, volume: 22000 }, // Bullish
  ];

  it('correctly maps OHLCV into ECharts [open, close, low, high] order', () => {
    const colors = { volUp: '#3ddc97', volDown: '#ff7b7b' };
    const adapted = adaptCandlesToECharts(sampleCandles, '1day', colors);

    expect(adapted.candlestickData.length).toBe(3);
    // Candle 0: open 100, close 103, low 98, high 105
    expect(adapted.candlestickData[0]).toEqual([100, 103, 98, 105]);
    // Candle 1: open 103, close 102, low 101, high 107
    expect(adapted.candlestickData[1]).toEqual([103, 102, 101, 107]);
    // Candle 2: open 102, close 109, low 102, high 110
    expect(adapted.candlestickData[2]).toEqual([102, 109, 102, 110]);

    // Volume colors
    expect(adapted.volumeData[0].itemStyle.color).toBe(colors.volUp); // close > open
    expect(adapted.volumeData[1].itemStyle.color).toBe(colors.volDown); // close < open
    expect(adapted.volumeData[2].itemStyle.color).toBe(colors.volUp); // close > open
  });

  it('formats categories properly for daily (UTC) and intraday (local)', () => {
    const dailyCat = formatCategoryTime(1700000000, '1day', 'en-US');
    expect(dailyCat).toContain('2023');

    const intradayCat = formatCategoryTime(1700000000, '5min', 'en-US');
    expect(intradayCat).toMatch(/:/); // contains hour:minute
  });

  it('normalizes compared stocks to percentage returns aligned to baseline', () => {
    const baseCandles: Candle[] = [
      { time: 1000, open: 100, high: 105, low: 95, close: 100, volume: 100 },
      { time: 1060, open: 100, high: 110, low: 98, close: 110, volume: 100 }, // +10%
      { time: 1120, open: 110, high: 115, low: 105, close: 105, volume: 100 }, // +5%
    ];

    const compareCandles: Candle[] = [
      { time: 1000, open: 200, high: 210, low: 195, close: 200, volume: 50 },
      { time: 1060, open: 200, high: 220, low: 200, close: 220, volume: 50 }, // +10%
      { time: 1120, open: 220, high: 230, low: 215, close: 190, volume: 50 }, // -5%
    ];

    const result = adaptComparisonData(baseCandles, [
      { symbol: 'MSFT', candles: compareCandles, color: '#f5c45e' },
    ]);

    expect(result.basePct).toEqual([0, 10, 5]);
    expect(result.compareSeries[0].data).toEqual([0, 10, -5]);
  });

  it('handles missing candles in comparison series by holding forward last known return', () => {
    const baseCandles: Candle[] = [
      { time: 1000, open: 100, high: 105, low: 95, close: 100, volume: 100 },
      { time: 1060, open: 100, high: 110, low: 98, close: 110, volume: 100 },
      { time: 1120, open: 110, high: 115, low: 105, close: 105, volume: 100 },
    ];

    // Missing bar at 1060
    const compareCandles: Candle[] = [
      { time: 1000, open: 50, high: 55, low: 45, close: 50, volume: 20 },
      { time: 1120, open: 50, high: 60, low: 50, close: 60, volume: 20 }, // +20%
    ];

    const result = adaptComparisonData(baseCandles, [
      { symbol: 'GOOGL', candles: compareCandles, color: '#c4a1ff' },
    ]);

    expect(result.compareSeries[0].data[0]).toBe(0);
    // At index 1 (time 1060), held forward last known return (0)
    expect(result.compareSeries[0].data[1]).toBe(0);
    expect(result.compareSeries[0].data[2]).toBe(20);
  });

  it('updates candle in place for streaming tick within current bar', () => {
    const current: Candle[] = [
      { time: 1700000000, open: 100, high: 102, low: 99, close: 101, volume: 500 },
    ];
    // Tick at 1700000050 (within 5-min bar = 300s)
    const tick = { symbol: 'AAPL', price: 104, ts: 1700000050 * 1000, volume: 50 };
    const res = updateCandlesWithTick(current, tick, '5min');

    expect(res.isNewBar).toBe(false);
    expect(res.updatedCandles.length).toBe(1);
    expect(res.lastBar.high).toBe(104);
    expect(res.lastBar.close).toBe(104);
    expect(res.lastBar.volume).toBe(550);
  });

  it('appends new candle when streaming tick crosses bar boundary', () => {
    const current: Candle[] = [
      { time: 1700000000, open: 100, high: 102, low: 99, close: 101, volume: 500 },
    ];
    // Tick at 1700000350 (starts next 5-min bar at 1700000300)
    const tick = { symbol: 'AAPL', price: 103, ts: 1700000350 * 1000, volume: 100 };
    const res = updateCandlesWithTick(current, tick, '5min');

    expect(res.isNewBar).toBe(true);
    expect(res.updatedCandles.length).toBe(2);
    expect(res.lastBar.time).toBe(1700000300);
    expect(res.lastBar.open).toBe(101); // Opens at previous close
    expect(res.lastBar.close).toBe(103);
    expect(res.lastBar.volume).toBe(100);
  });

  it('discards stale out-of-order ticks', () => {
    const current: Candle[] = [
      { time: 1700000300, open: 100, high: 102, low: 99, close: 101, volume: 500 },
    ];
    // Tick timestamp older than current bar start
    const tick = { symbol: 'AAPL', price: 103, ts: 1700000100 * 1000, volume: 100 };
    const res = updateCandlesWithTick(current, tick, '5min');

    expect(res.isNewBar).toBe(false);
    expect(res.updatedCandles).toBe(current);
  });
});

describe('ECharts Trading Terminal — ChartOverlayManager & Drawings', () => {
  const candles: Candle[] = [
    { time: 1699920000, open: 100, high: 105, low: 98, close: 102, volume: 1000 }, // 2023-11-14 00:00 UTC
    { time: 1700006400, open: 102, high: 108, low: 101, close: 107, volume: 1000 }, // 2023-11-15 00:00 UTC
  ];
  const categories = ['Nov 14, 2023', 'Nov 15, 2023'];

  it('builds Support & Resistance markArea specification', () => {
    const zones = [
      { low: 95, high: 98, rgb: '76,141,255', alpha: 0.14 },
      { low: 108, high: 112, rgb: '242,153,74', alpha: 0.24 },
    ];
    const markArea = buildZonesMarkArea(zones);

    expect(markArea.silent).toBe(true);
    expect(markArea.data.length).toBe(2);
    expect(markArea.data[0][0].yAxis).toBe(95);
    expect(markArea.data[0][1].yAxis).toBe(98);
    expect(markArea.data[0][0].itemStyle.color).toBe('rgba(76,141,255, 0.14)');
  });

  it('builds Floor Pivots markLine specification', () => {
    const lines = [
      { price: 105, title: 'P', color: '#9aa4b2', dashed: true },
      { price: 110, title: 'R1', color: '#9aa4b2', dashed: true },
    ];
    const markLine = buildPivotsMarkLine(lines);

    expect(markLine.silent).toBe(true);
    expect(markLine.data.length).toBe(2);
    expect(markLine.data[0].yAxis).toBe(105);
    expect(markLine.data[0].label.formatter).toBe('P 105.00');
    expect(markLine.data[0].lineStyle.type).toBe('dashed');
  });

  it('groups and builds corporate event markers on matching bars', () => {
    const earnings: EarningsReport[] = [
      {
        date: '2023-11-14',
        hour: 'bmo',
        epsActual: 1.25,
        epsEstimate: 1.10,
        revenueActual: null,
        revenueEstimate: null,
      },
    ];
    const dividends: DividendEvent[] = [
      { exDate: '2023-11-15', amount: 0.50, paymentDate: '2023-11-30' },
    ];

    const eventsMap = groupEventsByCandleBar({ earnings, dividends }, candles, '1day');
    expect(eventsMap.size).toBe(2);

    const markPoint = buildCorporateEventsMarkPoint(eventsMap, candles, categories);
    expect(markPoint).toBeDefined();
    expect(markPoint.data.length).toBe(2);
    expect(markPoint.data[0].label.formatter).toBe('E');
    expect(markPoint.data[1].label.formatter).toBe('D');
  });

  it('builds drawings markLine for horizontal lines and trendlines in data coordinates', () => {
    const drawings: ChartDrawing[] = [
      { id: '1', type: 'horizontal', price: 104.5, color: '#f5c45e' },
      { id: '2', type: 'trendline', startIndex: 0, startPrice: 100, endIndex: 1, endPrice: 107, color: '#4c8dff' },
    ];
    const markLines = buildDrawingsMarkLines(drawings, categories);

    expect(markLines.length).toBe(2);
    // Horizontal line
    expect(markLines[0].yAxis).toBe(104.5);
    // Trendline segment between [category0, 100] and [category1, 107]
    expect(markLines[1][0].coord).toEqual([categories[0], 100]);
    expect(markLines[1][1].coord).toEqual([categories[1], 107]);
  });
});
