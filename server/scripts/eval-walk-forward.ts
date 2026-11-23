import { runWalkForwardBacktest, type WalkForwardResult } from '../src/analysis/walk-forward.js';
import type { Candle } from '@tm/shared';

function generateRegime(
  seed: number,
  bars = 280,
  startPrice = 150,
  volatility = 0.015,
  hasRegimes = true,
): Candle[] {
  let p = startPrice;
  let t = 1700000000;
  const candles: Candle[] = [];

  let state = seed;
  const nextRand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  const sup1 = startPrice * 0.94;
  const res1 = startPrice * 1.06;

  for (let i = 0; i < bars; i++) {
    t += 86400;
    const r1 = nextRand();
    const r2 = nextRand();
    let shock = (r1 - 0.5) * 2 * (p * volatility);

    if (hasRegimes) {
      if (p <= sup1) {
        shock = Math.abs(shock) * 1.4; // strong bounce from support
      } else if (p >= res1) {
        shock = -Math.abs(shock) * 1.4; // strong bounce from resistance
      }
    }

    const open = p;
    const close = Math.max(10, open + shock);
    const high = Math.max(open, close) + r2 * (p * volatility * 0.6);
    const low = Math.min(open, close) - nextRand() * (p * volatility * 0.6);
    const volume = Math.floor(1_000_000 + nextRand() * 2_000_000);

    candles.push({ time: t, open, high, low, close, volume });
    p = close;
  }

  return candles;
}

const symbols = [
  { symbol: 'SPY', seed: 42, bars: 280, start: 450, vol: 0.010 },
  { symbol: 'AAPL', seed: 101, bars: 280, start: 180, vol: 0.015 },
  { symbol: 'NVDA', seed: 202, bars: 280, start: 120, vol: 0.025 },
  { symbol: 'TSLA', seed: 303, bars: 280, start: 220, vol: 0.030 },
];

for (const s of symbols) {
  const candles = generateRegime(s.seed, s.bars, s.start, s.vol);
  const res = runWalkForwardBacktest(s.symbol, candles, {
    warmupBars: 50,
    forwardWindow: 10,
    step: 1,
  });

  console.log(`\n=== Backtest Results: ${s.symbol} (Bars: ${res.candleCount}, Steps: ${res.evalSteps}) ===`);
  console.table(
    Object.values(res.candidates).map((c) => ({
      Candidate: c.candidate,
      Touches: c.touchCount,
      'Touch Rate': `${(c.touchRate * 100).toFixed(1)}%`,
      Bounces: c.bounceCount,
      'Bounce Rate': `${(c.bounceRate * 100).toFixed(1)}% ± ${(c.bounceRateSE * 100).toFixed(1)}%`,
      '95% CI': `[${(c.bounceRateCI95[0] * 100).toFixed(1)}%, ${(c.bounceRateCI95[1] * 100).toFixed(1)}%]`,
      Breakouts: c.breakoutCount,
      'Breakout Rate': `${(c.breakoutRate * 100).toFixed(1)}%`,
      'False Breakout Rate': `${(c.falseBreakoutRate * 100).toFixed(1)}%`,
      'MFE/MAE Ratio': c.mfeMaeRatio.toFixed(2),
      'Zone Churn': `${(c.zoneChurnRate * 100).toFixed(1)}%`,
    })),
  );
}
