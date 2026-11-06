'use client';

import type { Quote } from '@tm/shared';
import { useMemo } from 'react';
import { useQuote } from './api';
import { useLiveTick } from './live';

/** REST quote merged with the latest WebSocket tick (price, change, day range, timestamp). */
export function useLiveQuote(symbol: string | null, detail = false) {
  const q = useQuote(symbol, detail);
  const streaming = !!q.data && q.data.marketState !== 'closed';
  const tick = useLiveTick(symbol, streaming);

  const data = useMemo<Quote | undefined>(() => {
    const base = q.data;
    if (!base || !tick || tick.symbol !== base.symbol || tick.ts < base.ts) return base;
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
  }, [q.data, tick]);

  return { ...q, data, streaming };
}
