'use client';

import type { Candle, ChartLine, DividendEvent, EarningsReport, Resolution } from '@tm/shared';
import type { Zone } from './level-zones';
import { LightweightPriceChart } from './LightweightPriceChart';
import { EChartsPriceChart } from './chart/EChartsPriceChart';
import { useChartEngine, type ChartEngine } from '@/lib/chart-engine';

export type ChartType = 'line' | 'candles' | 'area';
export type { ChartLine };
export type { ChartEngine };
export { useChartEngine };

export interface CompareSeries {
  symbol: string;
  candles: Candle[];
  color: string;
}

export interface PriceChartProps {
  symbol: string;
  candles: Candle[];
  resolution: Resolution;
  type: ChartType;
  onChangeType?: (type: ChartType) => void;
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

export function PriceChart(props: PriceChartProps) {
  const selectedEngine = useChartEngine(props.engine);

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
