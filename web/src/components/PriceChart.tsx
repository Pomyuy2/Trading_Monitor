'use client';

import type { Candle, ChartLine, DividendEvent, EarningsReport, Resolution } from '@tm/shared';
import { useEffect, useState } from 'react';
import type { Zone } from './level-zones';
import { LightweightPriceChart } from './LightweightPriceChart';
import { EChartsPriceChart } from './chart/EChartsPriceChart';

export type ChartType = 'line' | 'candles' | 'area';
export type { ChartLine };

export interface CompareSeries {
  symbol: string;
  candles: Candle[];
  color: string;
}

export type ChartEngine = 'echarts' | 'lightweight';

export interface PriceChartProps {
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
  /** Chart rendering engine override. Defaults to 'echarts' (or NEXT_PUBLIC_CHART_ENGINE). */
  engine?: ChartEngine;
}

const DEFAULT_ENGINE: ChartEngine =
  (process.env.NEXT_PUBLIC_CHART_ENGINE as ChartEngine) || 'echarts';

export function PriceChart(props: PriceChartProps) {
  const [selectedEngine, setSelectedEngine] = useState<ChartEngine>(props.engine || DEFAULT_ENGINE);

  useEffect(() => {
    if (props.engine) {
      setSelectedEngine(props.engine);
      return;
    }
    try {
      const stored = localStorage.getItem('tm_chart_engine') as ChartEngine | null;
      if (stored === 'echarts' || stored === 'lightweight') {
        setSelectedEngine(stored);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [props.engine]);

  if (selectedEngine === 'lightweight') {
    return (
      <LightweightPriceChart
        symbol={props.symbol}
        candles={props.candles}
        resolution={props.resolution}
        type={props.type === 'area' ? 'line' : props.type}
        live={props.live}
        compares={props.compares}
        zones={props.zones}
        lines={props.lines}
        events={props.events}
        theme={props.theme}
        currency={props.currency}
        ariaLabel={props.ariaLabel}
      />
    );
  }

  return <EChartsPriceChart {...props} />;
}
