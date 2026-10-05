"use client";
import { useEffect, useRef } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type Logical,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartCoords, EngineProps, Tone } from "./types";
import { heikinAshi, numToWad, wadToNum } from "../series";

/** Theme colours come from the CSS tokens (globals.css); the engine never hard-codes a colour. */
function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { text: v("--text"), muted: v("--muted"), border: v("--border"), card: v("--card"), brand: v("--brand"), long: v("--long"), short: v("--short"), warn: v("--warn") };
}
type Tokens = ReturnType<typeof tokens>;
const toneColor = (t: Tokens, tone: Tone) => t[tone];
/** "#rrggbb" + alpha → rgba() for translucent fills (volume, area). */
const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(n) ? hex : `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const ts = (t: number) => t as UTCTimestamp as Time;

type State = {
  chart: IChartApi;
  main?: ISeriesApi<SeriesType>;
  mainType?: EngineProps["chartType"];
  volume?: ISeriesApi<"Histogram">;
  lines: IPriceLine[];
  overlays: Map<string, ISeriesApi<"Line">>;
  panes: Map<string, { series: Map<string, ISeriesApi<"Line" | "Histogram">>; guides: IPriceLine[] }>;
  t: Tokens;
};

function applyProps(s: State, p: EngineProps, lastReset: { current: number }) {
  const { chart, t } = s;
  const priceFormat = { type: "price" as const, precision: 6, minMove: 0.000001 };

  // main series (recreated only when the type changes)
  if (!s.main || s.mainType !== p.chartType) {
    if (s.main) chart.removeSeries(s.main);
    s.lines = [];
    const common = { priceFormat, lastValueVisible: true, priceLineVisible: true };
    s.main =
      p.chartType === "line"
        ? chart.addSeries(LineSeries, { ...common, color: t.brand, lineWidth: 2 })
        : p.chartType === "area"
          ? chart.addSeries(AreaSeries, { ...common, lineColor: t.brand, topColor: alpha(t.brand, 0.35), bottomColor: alpha(t.brand, 0.02) })
          : p.chartType === "bars"
            ? chart.addSeries(BarSeries, { ...common, upColor: t.long, downColor: t.short })
            : chart.addSeries(CandlestickSeries, {
                ...common,
                upColor: p.chartType === "hollow" ? "transparent" : t.long,
                downColor: t.short,
                borderUpColor: t.long,
                borderDownColor: t.short,
                wickUpColor: t.long,
                wickDownColor: t.short,
              });
    s.mainType = p.chartType;
  }
  const src = p.chartType === "heikin" ? heikinAshi(p.bars) : p.bars;
  if (p.chartType === "line" || p.chartType === "area") s.main.setData(src.map((b) => ({ time: ts(b.time), value: wadToNum(b.close) })));
  else s.main.setData(src.map((b) => ({ time: ts(b.time), open: wadToNum(b.open), high: wadToNum(b.high), low: wadToNum(b.low), close: wadToNum(b.close) })));

  // volume histogram on its own overlay scale at the bottom of the price pane
  if (p.showVolume) {
    s.volume ??= chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    s.volume.setData(p.bars.map((b) => ({ time: ts(b.time), value: wadToNum(b.volumeBaseWad), color: alpha(b.close >= b.open ? t.long : t.short, b.gapFill ? 0 : 0.35) })));
  } else if (s.volume) {
    chart.removeSeries(s.volume);
    s.volume = undefined;
  }

  // price lines: mark, index, position entry / liquidation, resting orders
  for (const l of s.lines) s.main.removePriceLine(l);
  s.lines = p.priceLines.map((l) =>
    s.main!.createPriceLine({ price: wadToNum(l.priceWad), color: toneColor(t, l.tone), lineWidth: 1, lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: l.title }),
  );

  // overlays on the price pane (indicators)
  const keepO = new Set(p.overlays.map((o) => o.id));
  for (const [id, ser] of s.overlays)
    if (!keepO.has(id)) {
      chart.removeSeries(ser);
      s.overlays.delete(id);
    }
  for (const o of p.overlays) {
    let ser = s.overlays.get(o.id);
    if (!ser) {
      ser = chart.addSeries(LineSeries, { color: toneColor(t, o.tone), lineWidth: o.width ?? 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat });
      s.overlays.set(o.id, ser);
    }
    ser.setData(o.points.map((x) => ({ time: ts(x.time), value: x.value })));
  }

  // extra panes (funding rate, RSI, MACD …), indices 1..n in the order given
  const keepP = new Set(p.panes.map((x) => x.id));
  for (const [id, pane] of [...s.panes].reverse()) {
    if (keepP.has(id)) continue;
    for (const ser of pane.series.values()) chart.removeSeries(ser);
    s.panes.delete(id);
  }
  p.panes.forEach((spec, i) => {
    let pane = s.panes.get(spec.id);
    if (!pane) {
      pane = { series: new Map(), guides: [] };
      s.panes.set(spec.id, pane);
    }
    for (const [id, ser] of pane.series)
      if (!spec.series.some((x) => x.id === id)) {
        chart.removeSeries(ser);
        pane.series.delete(id);
      }
    spec.series.forEach((ps, k) => {
      let ser = pane!.series.get(ps.id);
      if (ser && ser.getPane().paneIndex() !== i + 1) ser.moveToPane(i + 1);
      if (!ser) {
        ser =
          ps.kind === "histogram"
            ? chart.addSeries(HistogramSeries, { color: toneColor(t, ps.tone), lastValueVisible: k === 0, priceLineVisible: false }, i + 1)
            : chart.addSeries(LineSeries, { color: toneColor(t, ps.tone), lineWidth: 1, lastValueVisible: k === 0, priceLineVisible: false, crosshairMarkerVisible: false }, i + 1);
        pane!.series.set(ps.id, ser);
      }
      ser.setData(
        ps.points.map((x) => ({ time: ts(x.time), value: x.value, ...(ps.kind === "histogram" && ps.signedColors ? { color: alpha(x.value >= 0 ? t.long : t.short, 0.6) } : {}) })),
      );
      if (k === 0) {
        for (const g of pane!.guides) ser.removePriceLine(g);
        pane!.guides = (spec.guides ?? []).map((g) => ser!.createPriceLine({ price: g, color: t.muted, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" }));
      }
    });
  });
  // remove panes left empty after series removal (keeps the price pane)
  for (let i = chart.panes().length - 1; i > p.panes.length; i--) chart.removePane(i);
  // sub-pane heights from the current order (creation indices go stale when panes are toggled)
  const sub = p.panes.length >= 3 ? 70 : p.panes.length === 2 ? 90 : 110;
  p.panes.forEach((_, i) => chart.panes()[i + 1]?.setHeight(sub));

  if (lastReset.current !== p.resetKey) {
    chart.timeScale().fitContent();
    lastReset.current = p.resetKey;
  }
}

/**
 * TradingView Lightweight Charts engine. Data updates are coalesced to one per animation frame (blocks are ~300 ms,
 * several props can change per block). The chart is created once and removed on unmount (no leak across remounts).
 */
export function LightweightEngine(props: EngineProps) {
  const host = useRef<HTMLDivElement>(null);
  const st = useRef<State | null>(null);
  const latest = useRef(props);
  const frame = useRef(0);
  const lastReset = useRef(-1);
  const onClick = useRef(props.onPriceClick);
  const onCoordsRef = useRef(props.onCoords);
  useEffect(() => {
    latest.current = props;
    onClick.current = props.onPriceClick;
    onCoordsRef.current = props.onCoords;
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = tokens();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: t.card }, textColor: t.muted, fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 11, panes: { separatorColor: t.border } },
      grid: { vertLines: { color: alpha(t.border, 0.6) }, horzLines: { color: alpha(t.border, 0.6) } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: t.muted, labelBackgroundColor: t.brand }, horzLine: { color: t.muted, labelBackgroundColor: t.brand } },
    });
    st.current = { chart, lines: [], overlays: new Map(), panes: new Map(), t };
    const click = (p: { point?: { x: number; y: number }; paneIndex?: number }) => {
      const s = st.current;
      if (!s?.main || !p.point || (p.paneIndex ?? 0) !== 0 || !onClick.current) return;
      const price = s.main.coordinateToPrice(p.point.y);
      if (price !== null) onClick.current(numToWad(price));
    };
    chart.subscribeClick(click);
    const span = () => {
      const b = latest.current.bars;
      const t0 = b[0]?.time ?? 0;
      return { t0, step: b.length > 1 ? b[1]!.time - t0 : 60 };
    };
    const coords: ChartCoords = {
      xOfTime: (t) => {
        const { t0, step } = span();
        return latest.current.bars.length ? chart.timeScale().logicalToCoordinate(((t - t0) / step) as Logical) : null;
      },
      timeOfX: (x) => {
        const l = chart.timeScale().coordinateToLogical(x);
        const { t0, step } = span();
        return l === null || !latest.current.bars.length ? null : t0 + l * step;
      },
      yOfPrice: (p) => st.current?.main?.priceToCoordinate(p) ?? null,
      priceOfY: (y) => st.current?.main?.coordinateToPrice(y) ?? null,
      paneSize: () => chart.paneSize(0),
      barSec: () => span().step,
    };
    onCoordsRef.current?.(coords);
    return () => {
      onCoordsRef.current?.(null);
      cancelAnimationFrame(frame.current);
      chart.unsubscribeClick(click);
      chart.remove();
      st.current = null;
    };
  }, []);

  useEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (st.current) applyProps(st.current, latest.current, lastReset);
    });
  });

  // isolate: the library positions pane separators at z-index 50; keep its stacking context below app overlays
  return <div ref={host} className={`isolate h-full w-full ${props.className ?? ""}`} data-testid="chart-engine" />;
}
