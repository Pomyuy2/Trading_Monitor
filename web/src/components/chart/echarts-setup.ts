import * as echarts from 'echarts/core';
import {
  CandlestickChart,
  LineChart,
  BarChart,
  CustomChart,
} from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  LegendComponent,
  GraphicComponent,
  TitleComponent,
  ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// Register only required ECharts modules for optimal bundle size and tree-shaking
echarts.use([
  CandlestickChart,
  LineChart,
  BarChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  LegendComponent,
  GraphicComponent,
  TitleComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

export type EChartsInstance = echarts.ECharts;
export type EChartsCoreOption = echarts.EChartsCoreOption;
export { echarts };
