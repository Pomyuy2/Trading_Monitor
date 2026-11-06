import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

/** A horizontal price band drawn across the whole pane. */
export interface Zone {
  low: number;
  high: number;
  rgb: string; // "76,141,255"
  alpha: number; // fill opacity; the edges are drawn a bit stronger
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];
interface Rect { top: number; bottom: number; rgb: string; alpha: number }

class ZonesRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly rects: Rect[]) {}

  draw(target: DrawTarget) {
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vr }) => {
      const edge = Math.max(1, Math.round(vr));
      for (const r of this.rects) {
        const top = Math.round(r.top * vr);
        const height = Math.max(edge, Math.round((r.bottom - r.top) * vr));
        ctx.fillStyle = `rgba(${r.rgb},${r.alpha})`;
        ctx.fillRect(0, top, bitmapSize.width, height);
        ctx.fillStyle = `rgba(${r.rgb},${Math.min(1, r.alpha * 2.5)})`;
        ctx.fillRect(0, top, bitmapSize.width, edge);
        ctx.fillRect(0, top + height - edge, bitmapSize.width, edge);
      }
    });
  }
}

class ZonesView implements IPrimitivePaneView {
  constructor(private readonly source: LevelZonesPrimitive) {}
  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom'; // behind the price line/candles
  }
  renderer() {
    return new ZonesRenderer(this.source.rects());
  }
}

/** Series primitive that shades support / resistance zones. */
export class LevelZonesPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private zones: Zone[] = [];
  private readonly views = [new ZonesView(this)];

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.series = null;
    this.requestUpdate = null;
  }

  setZones(zones: Zone[]) {
    this.zones = zones;
    this.requestUpdate?.();
  }

  paneViews() {
    return this.views;
  }

  rects(): Rect[] {
    const s = this.series;
    if (!s) return [];
    const out: Rect[] = [];
    for (const z of this.zones) {
      const yHigh = s.priceToCoordinate(z.high);
      const yLow = s.priceToCoordinate(z.low);
      if (yHigh == null || yLow == null) continue;
      out.push({ top: Math.min(yHigh, yLow), bottom: Math.max(yHigh, yLow), rgb: z.rgb, alpha: z.alpha });
    }
    return out;
  }
}
