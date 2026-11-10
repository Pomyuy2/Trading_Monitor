'use client';

import type { Quote } from '@tm/shared';
import { useEffect, useMemo, useState } from 'react';
import { useQuote, useQuotes } from './api';
import { liveFeed, useLiveTick, type LiveTick } from './live';

/** Apply a live trade to a REST quote (price, change vs previous close, day range, timestamp). */
export function mergeTick(base: Quote, tick: LiveTick | null | undefined): Quote {
  if (!tick || tick.symbol !== base.symbol || tick.ts < base.ts) return base;
  const prev = base.prevClose;
  const change = prev != null ? tick.price - prev : base.change;
  return {
    ...base,
    price: tick.price,
    change,
    changePct: prev ? (change! / prev) * 100 : base.changePct,
    high: base.high != null ? Math.max(base.high, tick.price) : base.high,
    low: base.low != null ? Math.min(base.low, tick.price) : base.low,
    ts: tick.ts,
  };
}

/** REST quote merged with the latest WebSocket tick. */
export function useLiveQuote(symbol: string | null, detail = false) {
  const q = useQuote(symbol, detail);
  const streaming = !!q.data && q.data.marketState !== 'closed';
  const tick = useLiveTick(symbol, streaming);
  const data = useMemo(() => (q.data ? mergeTick(q.data, tick) : undefined), [q.data, tick]);
  return { ...q, data, streaming };
}

/** Quotes for many symbols (one request) merged with live ticks — for the watchlist. */
export function useLiveQuotes(symbols: string[]): Map<string, Quote> {
  const { data } = useQuotes(symbols);
  const [ticks, setTicks] = useState<Map<string, LiveTick>>(new Map());
  const key = symbols.join(',');

  useEffect(() => {
    const feed = liveFeed();
    const offs = symbols.map((s) =>
      feed.subscribe(s, (t) => setTicks((cur) => new Map(cur).set(t.symbol, t))),
    );
    return () => offs.forEach((off) => off());
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const m = new Map<string, Quote>();
    for (const q of data ?? []) m.set(q.symbol, q.marketState === 'closed' ? q : mergeTick(q, ticks.get(q.symbol)));
    return m;
  }, [data, ticks]);
}
