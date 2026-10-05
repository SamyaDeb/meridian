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

/** Cheap rolling hash of a point list (all fields), so unchanged data is never re-applied. */
function hashPoints(pts: readonly Record<string, unknown>[], upTo = pts.length): number {
  let h = 2166136261;
  for (let i = 0; i < upTo; i++) {
    const s = JSON.stringify(pts[i]);
    for (let j = 0; j < s.length; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
  }
  return h >>> 0;
}
type Applied = { full: number; prefix: number; len: number };
/**
 * Applies data to a series only when it changed: nothing when identical, update() of the last point when only the
 * newest bar moved or a bar was appended, setData otherwise. Re-applying every frame reset the chart's pointer state
 * (clicks spanning a reset were dropped) and wasted work at one render per 300 ms block.
 */
function applyData(ser: ISeriesApi<SeriesType>, data: Record<string, unknown>[], seen: Map<unknown, Applied>) {
  const full = hashPoints(data);
  const prev = seen.get(ser);
  if (prev && prev.full === full && prev.len === data.length) return;
  const last = data[data.length - 1];
  const sameHistory = prev && last && ((data.length === prev.len && hashPoints(data, data.length - 1) === prev.prefix) || (data.length === prev.len + 1 && hashPoints(data, data.length - 1) === prev.full));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (sameHistory) (ser as any).update(last);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  else (ser as any).setData(data);
  seen.set(ser, { full, prefix: data.length ? hashPoints(data, data.length - 1) : 0, len: data.length });
}

type State = {
  chart: IChartApi;
  main?: ISeriesApi<SeriesType>;
  mainType?: EngineProps["chartType"];
  volume?: ISeriesApi<"Histogram">;
  lines: IPriceLine[];
  linesSig: string;
  seen: Map<unknown, Applied>;
  /** a fit has been made while candles existed */
  fittedWithBars: boolean;
  overlays: Map<string, ISeriesApi<"Line">>;
  panes: Map<string, { series: Map<string, ISeriesApi<"Line" | "Histogram">>; guides: IPriceLine[]; guidesSig: string }>;
  t: Tokens;
};

function applyProps(s: State, p: EngineProps, lastReset: { current: number }) {
  const { chart, t } = s;
  const priceFormat = { type: "price" as const, precision: 6, minMove: 0.000001 };

  // main series (recreated only when the type changes)
  if (!s.main || s.mainType !== p.chartType) {
    if (s.main) chart.removeSeries(s.main);
    s.lines = [];
    s.linesSig = "";
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
  if (p.chartType === "line" || p.chartType === "area") applyData(s.main, src.map((b) => ({ time: ts(b.time), value: wadToNum(b.close) })), s.seen);
  else applyData(s.main, src.map((b) => ({ time: ts(b.time), open: wadToNum(b.open), high: wadToNum(b.high), low: wadToNum(b.low), close: wadToNum(b.close) })), s.seen);

  // volume histogram on its own overlay scale at the bottom of the price pane
  if (p.showVolume) {
    s.volume ??= chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    applyData(s.volume as ISeriesApi<SeriesType>, p.bars.map((b) => ({ time: ts(b.time), value: wadToNum(b.volumeBaseWad), color: alpha(b.close >= b.open ? t.long : t.short, b.gapFill ? 0 : 0.35) })), s.seen);
  } else if (s.volume) {
    chart.removeSeries(s.volume);
    s.volume = undefined;
  }

  // price lines: mark, index, position entry / liquidation, resting orders
  const linesSig = p.priceLines.map((l) => `${l.id}:${l.priceWad}:${l.tone}:${l.title}:${l.dashed ?? ""}`).join("|");
  if (linesSig !== s.linesSig) {
  s.linesSig = linesSig;
  for (const l of s.lines) s.main.removePriceLine(l);
  s.lines = p.priceLines.map((l) =>
    s.main!.createPriceLine({ price: wadToNum(l.priceWad), color: toneColor(t, l.tone), lineWidth: 1, lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: l.title }),
  );
  }

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
    applyData(ser as ISeriesApi<SeriesType>, o.points.map((x) => ({ time: ts(x.time), value: x.value })), s.seen);
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
      pane = { series: new Map(), guides: [], guidesSig: "" };
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
      applyData(
        ser as ISeriesApi<SeriesType>,
        ps.points.map((x) => ({ time: ts(x.time), value: x.value, ...(ps.kind === "histogram" && ps.signedColors ? { color: alpha(x.value >= 0 ? t.long : t.short, 0.6) } : {}) })),
        s.seen,
      );
      if (k === 0) {
        const gsig = (spec.guides ?? []).join(",");
        if (gsig !== pane!.guidesSig) {
          pane!.guidesSig = gsig;
          for (const g of pane!.guides) ser.removePriceLine(g);
          pane!.guides = (spec.guides ?? []).map((g) => ser!.createPriceLine({ price: g, color: t.muted, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" }));
        }
      }
    });
  });
  // remove panes left empty after series removal (keeps the price pane)
  for (let i = chart.panes().length - 1; i > p.panes.length; i--) chart.removePane(i);
  // sub-pane heights from the current order (creation indices go stale when panes are toggled)
  const sub = p.panes.length >= 3 ? 70 : p.panes.length === 2 ? 90 : 110;
  p.panes.forEach((_, i) => chart.panes()[i + 1]?.setHeight(sub));

  // fit on a reset AND the first time candles exist: a fit made before the candles arrived (e.g. only funding-pane
  // points) frames a range with no bars, the price pane looks empty and price ↔ y conversions return null
  const firstBars = p.bars.length > 0 && !s.fittedWithBars;
  if (firstBars) s.fittedWithBars = true;
  if (p.bars.length === 0) s.fittedWithBars = false;
  if (lastReset.current !== p.resetKey || firstBars) {
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
  const onCrossRef = useRef(props.onCrosshair);
  useEffect(() => {
    onCrossRef.current = props.onCrosshair;
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
      // Meridian look: dotted grid
      grid: { vertLines: { color: alpha(t.border, 0.9), style: LineStyle.Dotted }, horzLines: { color: alpha(t.border, 0.9), style: LineStyle.Dotted } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: t.muted, labelBackgroundColor: t.brand }, horzLine: { color: t.muted, labelBackgroundColor: t.brand } },
    });
    st.current = { chart, lines: [], linesSig: "", seen: new Map(), fittedWithBars: false, overlays: new Map(), panes: new Map(), t };
    // Click-to-price from our own pointer events: a click = press and release within 4 px, inside the price pane
    // (not the price axis, the time axis or a lower pane). Independent of the library's click/scroll heuristics.
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const s = st.current;
      const start = down;
      down = null;
      if (!s?.main || !start || !onClick.current || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const pane = chart.paneSize(0);
      if (x < 0 || y < 0 || x > pane.width || y > pane.height) return;
      const price = s.main.coordinateToPrice(y);
      if (price !== null) onClick.current(numToWad(price));
    };
    const cross = (p: { time?: unknown; seriesData: Map<unknown, unknown> }) => {
      const s = st.current;
      const d = s?.main ? (p.seriesData.get(s.main) as { open?: number; high?: number; low?: number; close?: number; value?: number } | undefined) : undefined;
      if (!d || typeof p.time !== "number") return onCrossRef.current?.(null);
      const c = d.close ?? d.value ?? 0;
      onCrossRef.current?.({ time: p.time, open: d.open ?? c, high: d.high ?? c, low: d.low ?? c, close: c });
    };
    chart.subscribeCrosshairMove(cross);
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointerup", onUp, true);
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
      setVisibleSeconds: (from, to) => {
        const { t0, step } = span();
        if (!latest.current.bars.length || to <= from) return;
        chart.timeScale().setVisibleLogicalRange({ from: (from - t0) / step, to: (to - t0) / step });
      },
      zoom: (factor) => {
        const r = chart.timeScale().getVisibleLogicalRange();
        if (!r) return;
        const mid = (r.from + r.to) / 2;
        const half = Math.max(5, ((r.to - r.from) / 2) * factor);
        chart.timeScale().setVisibleLogicalRange({ from: mid - half, to: mid + half });
      },
      screenshot: () => chart.takeScreenshot(),
    };
    onCoordsRef.current?.(coords);
    return () => {
      onCoordsRef.current?.(null);
      cancelAnimationFrame(frame.current);
      chart.unsubscribeCrosshairMove(cross);
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointerup", onUp, true);
      chart.remove();
      st.current = null;
    };
  }, []);

  useEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (!st.current) return;
      applyProps(st.current, latest.current, lastReset);
      // data and scales are applied: overlays and tests may now convert coordinates
      host.current?.setAttribute("data-ready", latest.current.bars.length > 0 ? "true" : "false");
    });
  });

  // isolate: the library positions pane separators at z-index 50; keep its stacking context below app overlays
  return <div ref={host} className={`isolate h-full w-full ${props.className ?? ""}`} data-testid="chart-engine" />;
}
