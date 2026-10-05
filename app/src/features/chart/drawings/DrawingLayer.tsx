"use client";
import { useEffect, useRef, useState, type PointerEvent as RPE } from "react";
import type { Bar } from "../datafeed/types";
import type { ChartCoords } from "../engine/types";
import { CLICKS, fibLevels, magnet, makeDrawing, measure, plan, rayEnd, type Drawing, type Pt } from "./model";
import type { DrawingsApi } from "./useDrawings";

const fmt = (n: number) => n.toFixed(6);
let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * SVG overlay on the price pane. Passive (pointer-events none) unless a tool or erase is active, so the chart keeps
 * panning and zooming. Redraws every animation frame while there is something to draw (follows zoom / pan / scale).
 */
export function DrawingLayer({ coords, bars, api }: { coords: ChartCoords | null; bars: readonly Bar[]; api: DrawingsApi }) {
  const [, force] = useState(0);
  const [pending, setPending] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const brushing = useRef(false);
  const active = Boolean(api.tool) || api.erase;
  const busy = api.drawings.length > 0 || pending.length > 0;
  useEffect(() => {
    if (!busy || !coords) return;
    let id = 0;
    const loop = () => {
      force((n) => (n + 1) % 1_000_000);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [busy, coords]);
  if (!coords || bars.length === 0) return null;
  const { width: W, height: H } = coords.paneSize();
  // the chart applies data and scales on the next animation frame: until both conversions work, no layer (a click
  // would otherwise be dropped silently)
  if (W === 0 || H === 0 || coords.priceOfY(H / 2) === null || coords.timeOfX(W / 2) === null) return null;
  const X = (t: number) => coords.xOfTime(t) ?? -9999;
  const Y = (p: number) => coords.yOfPrice(p) ?? -9999;
  const span = (() => {
    const hi = coords.priceOfY(0);
    const lo = coords.priceOfY(H);
    return hi !== null && lo !== null ? Math.abs(hi - lo) : 0;
  })();
  const toPt = (e: RPE<SVGSVGElement>): Pt | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = coords.timeOfX(e.clientX - r.left);
    const p = coords.priceOfY(e.clientY - r.top);
    if (t === null || p === null) return null;
    const raw = { time: t, price: p };
    // magnet: within 2 % of the visible price span of an OHLC value of that bar
    return api.magnet ? magnet(raw, bars, coords.barSec(), span * 0.02) : raw;
  };

  const onDown = (e: RPE<SVGSVGElement>) => {
    if (!api.tool) return;
    const p = toPt(e);
    if (!p) return;
    if (api.tool === "brush") {
      brushing.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setPending([p]);
      return;
    }
    const pts = [...pending, p];
    if (pts.length < CLICKS[api.tool]) return setPending(pts);
    const text = api.tool === "text" ? (window.prompt("Text label") ?? "").trim() : undefined;
    const d = makeDrawing(api.tool, pts, newId(), text);
    if (d) api.add(d);
    setPending([]);
    api.setTool(null);
  };
  const onMove = (e: RPE<SVGSVGElement>) => {
    const p = toPt(e);
    setHover(p);
    if (brushing.current && p) setPending((s) => [...s, p]);
  };
  const onUp = () => {
    if (!brushing.current) return;
    brushing.current = false;
    const d = makeDrawing("brush", pending, newId());
    if (d) api.add(d);
    setPending([]);
    api.setTool(null);
  };

  const preview: Drawing | undefined = api.tool && hover && pending.length > 0 ? makeDrawing(api.tool === "brush" ? "brush" : api.tool, [...pending, hover, hover].slice(0, Math.max(CLICKS[api.tool], 2)), "preview", "…") : undefined;
  const all = preview ? [...api.drawings, preview] : api.drawings;
  const barSec = coords.barSec();

  const shape = (d: Drawing) => {
    // erase mode: the shape takes clicks on its (widened) stroke; colour classes stay untouched
    const del = api.erase && !api.locked && d.id !== "preview" ? { onClick: () => api.remove(d.id), style: { pointerEvents: "visiblePainted" as const, cursor: "pointer", strokeWidth: 6 } } : {};
    const stroke = "stroke-brand-soft";
    switch (d.kind) {
      case "hline":
        return (
          <g key={d.id}>
            <line x1={0} x2={W} y1={Y(d.a.price)} y2={Y(d.a.price)} className={stroke} strokeWidth={1.5} {...del} />
            <text x={W - 4} y={Y(d.a.price) - 4} textAnchor="end" className="fill-brand-soft text-[10px]">{fmt(d.a.price)}</text>
          </g>
        );
      case "vline":
        return <line key={d.id} x1={X(d.a.time)} x2={X(d.a.time)} y1={0} y2={H} className={stroke} strokeWidth={1.5} {...del} />;
      case "text":
        return (
          <text key={d.id} x={X(d.a.time)} y={Y(d.a.price)} className="fill-text text-[12px]" {...(del.onClick ? { onClick: del.onClick, style: { pointerEvents: "all" as const, cursor: "pointer" } } : {})}>
            {d.text}
          </text>
        );
      case "trend":
        return <line key={d.id} x1={X(d.a.time)} y1={Y(d.a.price)} x2={X(d.b.time)} y2={Y(d.b.price)} className={stroke} strokeWidth={1.5} {...del} />;
      case "ray": {
        const e2 = rayEnd(X(d.a.time), Y(d.a.price), X(d.b.time), Y(d.b.price), W);
        return <line key={d.id} x1={X(d.a.time)} y1={Y(d.a.price)} x2={e2.x} y2={e2.y} className={stroke} strokeWidth={1.5} {...del} />;
      }
      case "rect": {
        const x = Math.min(X(d.a.time), X(d.b.time));
        const y = Math.min(Y(d.a.price), Y(d.b.price));
        return <rect key={d.id} x={x} y={y} width={Math.abs(X(d.b.time) - X(d.a.time))} height={Math.abs(Y(d.b.price) - Y(d.a.price))} className="fill-brand/10 stroke-brand-soft" strokeWidth={1} {...del} />;
      }
      case "fib": {
        const x1 = Math.min(X(d.a.time), X(d.b.time));
        const x2 = Math.max(X(d.a.time), X(d.b.time));
        return (
          <g key={d.id}>
            {fibLevels(d.a, d.b).map((l) => (
              <g key={l.ratio}>
                <line x1={x1} x2={x2} y1={Y(l.price)} y2={Y(l.price)} className="stroke-warn" strokeWidth={1} {...del} />
                <text x={x1 + 2} y={Y(l.price) - 2} className="fill-warn text-[9px]">{`${(l.ratio * 100).toFixed(1)}% ${fmt(l.price)}`}</text>
              </g>
            ))}
          </g>
        );
      }
      case "ruler": {
        const m = measure(d.a, d.b, barSec);
        return (
          <g key={d.id}>
            <line x1={X(d.a.time)} y1={Y(d.a.price)} x2={X(d.b.time)} y2={Y(d.b.price)} className="stroke-text" strokeDasharray="4 3" strokeWidth={1} {...del} />
            <text x={X(d.b.time) + 4} y={Y(d.b.price)} className="fill-text text-[10px]">{`${m.dPrice >= 0 ? "+" : ""}${fmt(m.dPrice)} (${m.pct.toFixed(2)}%) · ${m.bars} bars`}</text>
          </g>
        );
      }
      case "brush":
        return <polyline key={d.id} points={d.pts.map((p) => `${X(p.time)},${Y(p.price)}`).join(" ")} fill="none" className={stroke} strokeWidth={1.5} {...del} />;
      case "long":
      case "short": {
        const x1 = Math.min(X(d.a.time), X(d.b.time), X(d.c.time));
        const x2 = Math.max(X(d.a.time), X(d.b.time), X(d.c.time), x1 + 60);
        const r = plan(d.kind, d.a, d.b, d.c);
        return (
          <g key={d.id}>
            <rect x={x1} width={x2 - x1} y={Math.min(Y(d.a.price), Y(d.b.price))} height={Math.abs(Y(d.b.price) - Y(d.a.price))} className="fill-long/15" {...del} />
            <rect x={x1} width={x2 - x1} y={Math.min(Y(d.a.price), Y(d.c.price))} height={Math.abs(Y(d.c.price) - Y(d.a.price))} className="fill-short/15" />
            <line x1={x1} x2={x2} y1={Y(d.a.price)} y2={Y(d.a.price)} className="stroke-text" strokeWidth={1} />
            <text x={x1 + 3} y={Y(d.a.price) - 3} className="fill-text text-[10px]">{`${d.kind === "long" ? "Long" : "Short"} plan · not an order · ${r.valid ? `R:R ${r.rr!.toFixed(2)}` : "check target / stop sides"}`}</text>
          </g>
        );
      }
    }
  };

  return (
    <svg
      data-testid="drawing-layer"
      width={W}
      height={H}
      className="absolute left-0 top-0 z-10"
      style={{ pointerEvents: api.tool ? "all" : "none", cursor: api.tool ? "crosshair" : undefined }}
      onPointerDown={onDown}
      onPointerMove={active ? onMove : undefined}
      onPointerUp={onUp}
      role="img"
      aria-label={`${api.drawings.length} drawing${api.drawings.length === 1 ? "" : "s"} on the chart`}
    >
      {all.map(shape)}
    </svg>
  );
}
