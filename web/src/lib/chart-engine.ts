'use client';

import { useEffect, useState } from 'react';

export type ChartEngine = 'echarts' | 'lightweight';

export const DEFAULT_CHART_ENGINE: ChartEngine =
  (process.env.NEXT_PUBLIC_CHART_ENGINE as ChartEngine) || 'echarts';

export function getChartEngine(override?: ChartEngine): ChartEngine {
  if (override) return override;
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('tm_chart_engine') as ChartEngine | null;
      if (stored === 'echarts' || stored === 'lightweight') {
        return stored;
      }
    } catch {
      // Ignore localStorage errors
    }
  }
  return DEFAULT_CHART_ENGINE;
}

export function useChartEngine(override?: ChartEngine): ChartEngine {
  const [engine, setEngine] = useState<ChartEngine>(() => override ?? DEFAULT_CHART_ENGINE);

  useEffect(() => {
    setEngine(getChartEngine(override));
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'tm_chart_engine') {
        setEngine(getChartEngine(override));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [override]);

  return engine;
}
