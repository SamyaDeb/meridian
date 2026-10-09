// The chart engine contract (FRONTEND_TRADE_PLAN §4.4). LightweightEngine implements it today; an Advanced Charts
// engine (if TradingView grants the licence) implements the same props, so the swap is one import.
import type { Bar } from "../datafeed/types";

export type ChartType = "candles" | "hollow" | "bars" | "line" | "area" | "heikin";
export type Tone = "brand" | "long" | "short" | "warn" | "muted" | "text";

export type Point = { time: number; value: number };

export type PriceLineSpec = { id: string; priceWad: bigint; tone: Tone; title: string; dashed?: boolean };
export type LineOverlay = { id: string; points: Point[]; tone: Tone; width?: 1 | 2 };
export type PaneSeries = { id: string; points: Point[]; tone: Tone; kind: "line" | "histogram"; signedColors?: boolean };
export type PaneSpec = { id: string; title: string; series: PaneSeries[]; /** horizontal guide values, e.g. RSI 30/70 */ guides?: number[] };

/** Chart-space ↔ pixel conversions for overlays (drawings). Pixels are relative to the price pane's top-left. */
export type ChartCoords = {
  xOfTime: (t: number) => number | null;
  timeOfX: (x: number) => number | null;
  yOfPrice: (p: number) => number | null;
  priceOfY: (y: number) => number | null;
  /** price pane size without the price axis */
  paneSize: () => { width: number; height: number };
  /** bar spacing in seconds (bars are uniform: gap-filled) */
  barSec: () => number;
  /** show [from, to] (unix seconds) on the time axis */
  setVisibleSeconds: (from: number, to: number) => void;
  /** zoom the time axis around its centre (factor < 1 zooms in) */
  zoom: (factor: number) => void;
  /** PNG of the chart (all panes, price and time axes) */
  screenshot: () => HTMLCanvasElement;
};

export type EngineProps = {
  bars: readonly Bar[];
  chartType: ChartType;
  showVolume: boolean;
  priceLines: readonly PriceLineSpec[];
  overlays: readonly LineOverlay[];
  panes: readonly PaneSpec[];
  /** bump to fit the time scale to the data (Reset view) */
  resetKey: number;
  /** click on the price pane → price at the cursor (WAD); used for click-to-set-limit */
  onPriceClick?: (priceWad: bigint) => void;
  className?: string;
  /** crosshair over a bar of the main series (null when the pointer leaves); for the OHLC legend */
  onCrosshair?: (bar: { time: number; open: number; high: number; low: number; close: number } | null) => void;
  /** receives the coordinate API once the chart exists (null on unmount) */
  onCoords?: (c: ChartCoords | null) => void;
  /** decimals of the market's tick (MON-PERP 6, ETH-PERP 1, K7); default 6 */
  pricePrecision?: number;
};
