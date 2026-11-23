export type DrawingType = 'horizontal' | 'trendline' | 'measure';

export interface HorizontalLineDrawing {
  id: string;
  type: 'horizontal';
  price: number;
  color: string;
}

export interface TrendlineDrawing {
  id: string;
  type: 'trendline';
  startIndex: number;
  startPrice: number;
  endIndex: number;
  endPrice: number;
  color: string;
}

export interface PriceRangeMeasureDrawing {
  id: string;
  type: 'measure';
  startIndex: number;
  startPrice: number;
  endIndex: number;
  endPrice: number;
  color: string;
}

export type ChartDrawing =
  | HorizontalLineDrawing
  | TrendlineDrawing
  | PriceRangeMeasureDrawing;

/**
 * Converts drawing objects in data-space into ECharts markLine and graphic representations.
 */
export function buildDrawingsMarkLines(
  drawings: ChartDrawing[],
  categories: string[],
): any[] {
  const markLineData: any[] = [];

  for (const d of drawings) {
    if (d.type === 'horizontal') {
      markLineData.push({
        yAxis: d.price,
        lineStyle: { color: d.color, width: 1.5, type: 'dashed' },
        label: {
          show: true,
          position: 'insideEndTop',
          formatter: `$${d.price.toFixed(2)}`,
          color: d.color,
          fontSize: 10,
        },
      });
    } else if (d.type === 'trendline') {
      const startCat = categories[d.startIndex];
      const endCat = categories[d.endIndex];
      if (startCat && endCat) {
        markLineData.push([
          {
            coord: [startCat, d.startPrice],
            lineStyle: { color: d.color, width: 2, type: 'solid' },
            symbol: 'circle',
            symbolSize: 4,
          },
          {
            coord: [endCat, d.endPrice],
            symbol: 'circle',
            symbolSize: 4,
          },
        ]);
      }
    }
  }

  return markLineData;
}
