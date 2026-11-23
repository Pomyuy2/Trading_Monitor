import { performance } from 'perf_hooks';
import type { Candle } from '@tm/shared';
import {
  adaptCandlesToECharts,
  adaptComparisonData,
  updateCandlesWithTick,
} from '../../web/src/components/chart/ChartDataAdapter';
import {
  computeIndicators,
  type OverlayIndicatorKey,
  type PanelIndicatorKey,
} from '../../web/src/components/chart/ChartIndicatorEngine';

function generateCandles(count: number, resolutionSec: number): Candle[] {
  const candles: Candle[] = [];
  let price = 150.0;
  const start = 1700000000;

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.1) * 2 + (Math.random() - 0.49) * 3);
    const open = price;
    const close = Math.max(1, price + change);
    const high = Math.max(open, close) + Math.random() * 2;
    const low = Math.min(open, close) - Math.random() * 2;
    const volume = Math.floor(10000 + Math.random() * 50000);

    candles.push({
      time: start + i * resolutionSec,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
    });
    price = close;
  }
  return candles;
}

export function runPerformanceBenchmarks() {
  const colors = { volUp: '#3ddc97', volDown: '#ff7b7b' };
  const allOverlays: OverlayIndicatorKey[] = ['sma20', 'sma50', 'sma200', 'ema12', 'ema26', 'bollinger', 'vwap'];
  const allPanels: PanelIndicatorKey[] = ['rsi', 'macd', 'atr', 'adx'];

  console.log('='.repeat(70));
  console.log(' Trading Monitor — ECharts Trading Terminal Performance Benchmark');
  console.log('='.repeat(70));

  const scenarios = [
    { name: '1D Intraday (5-min)', bars: 78, resolutionSec: 300, res: '5min' as const },
    { name: '1Y Daily (1-day)', bars: 252, resolutionSec: 86400, res: '1day' as const },
    { name: '5Y Weekly (1-week)', bars: 260, resolutionSec: 604800, res: '1week' as const },
    { name: 'Stress Test (10,000 candles)', bars: 10000, resolutionSec: 60, res: '1min' as const },
  ];

  const results: any[] = [];

  for (const sc of scenarios) {
    const candles = generateCandles(sc.bars, sc.resolutionSec);

    // 1. Data Adapter Benchmark
    const t0 = performance.now();
    for (let r = 0; r < 50; r++) {
      adaptCandlesToECharts(candles, sc.res, colors);
    }
    const adaptTimeMs = (performance.now() - t0) / 50;

    // 2. All Indicators Suite Benchmark
    const t1 = performance.now();
    for (let r = 0; r < 50; r++) {
      for (const p of allPanels) {
        computeIndicators(candles, allOverlays, p);
      }
    }
    const indicatorsTimeMs = (performance.now() - t1) / (50 * allPanels.length);

    // 3. Comparison Mode Normalization Benchmark
    const compareCandles = generateCandles(sc.bars, sc.resolutionSec);
    const t2 = performance.now();
    for (let r = 0; r < 50; r++) {
      adaptComparisonData(candles, [{ symbol: 'COMP', candles: compareCandles, color: '#f5c45e' }]);
    }
    const compareTimeMs = (performance.now() - t2) / 50;

    // 4. Memory footprint estimate
    const memBefore = process.memoryUsage().heapUsed;
    const transformed = adaptCandlesToECharts(candles, sc.res, colors);
    const inds = computeIndicators(candles, allOverlays, 'rsi');
    const memAfter = process.memoryUsage().heapUsed;
    const estMemoryKb = Math.max(0, Math.round((memAfter - memBefore) / 1024));

    results.push({
      scenario: sc.name,
      bars: sc.bars,
      adaptTimeMs: +adaptTimeMs.toFixed(3),
      indicatorsTimeMs: +indicatorsTimeMs.toFixed(3),
      compareTimeMs: +compareTimeMs.toFixed(3),
      totalTransformMs: +(adaptTimeMs + indicatorsTimeMs + compareTimeMs).toFixed(3),
      estMemoryKb,
    });
  }

  // 5. Live Tick Throughput Benchmark
  const liveBase = generateCandles(250, 300);
  const tLive0 = performance.now();
  const tickCount = 10000;
  let curr = liveBase;
  for (let i = 0; i < tickCount; i++) {
    const tick = {
      symbol: 'AAPL',
      price: 150 + Math.random() * 2,
      ts: (1700000000 + 250 * 300 + (i % 60)) * 1000,
      volume: 10,
    };
    const res = updateCandlesWithTick(curr, tick, '5min');
    if (i % 300 === 0) curr = res.updatedCandles;
  }
  const liveTotalMs = performance.now() - tLive0;
  const liveOpsPerSec = Math.round((tickCount / liveTotalMs) * 1000);
  const liveMicrosPerTick = +((liveTotalMs / tickCount) * 1000).toFixed(2);

  console.table(results);
  console.log(`\nLive Streaming Tick Benchmark:`);
  console.log(`- Throughput: ${liveOpsPerSec.toLocaleString()} ticks/sec`);
  console.log(`- Latency: ${liveMicrosPerTick} µs/tick\n`);
  console.log('='.repeat(70));

  return { results, liveOpsPerSec, liveMicrosPerTick };
}

if (process.argv[1] && process.argv[1].endsWith('benchmark-chart-performance.ts')) {
  runPerformanceBenchmarks();
}
