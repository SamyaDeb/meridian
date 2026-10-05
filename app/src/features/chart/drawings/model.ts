// Drawing tools (FRONTEND_TRADE_PLAN §4.3): pure model, geometry and persistence. Points live in chart space
// (unix seconds, price as a number) so drawings survive zoom, pan and timeframe changes. Display-only floats.
import type { Bar } from "../datafeed/types";
import { wadToNum } from "../series";

export type Pt = { time: number; price: number };
export type Tool = "hline" | "vline" | "trend" | "ray" | "rect" | "fib" | "text" | "ruler" | "brush" | "long" | "short";
export type Drawing =
  | { id: string; kind: "hline" | "vline" | "text"; a: Pt; text?: string }
  | { id: string; kind: "trend" | "ray" | "rect" | "fib" | "ruler"; a: Pt; b: Pt }
  | { id: string; kind: "brush"; pts: Pt[] }
  /** position planner: entry a, target b, stop c. A planning aid, never an order. */
  | { id: string; kind: "long" | "short"; a: Pt; b: Pt; c: Pt };

/** Clicks needed to place a tool (brush is a drag). */
export const CLICKS: Record<Tool, number> = { hline: 1, vline: 1, text: 1, trend: 2, ray: 2, rect: 2, fib: 2, ruler: 2, brush: 0, long: 3, short: 3 };

export const TOOL_LABEL: Record<Tool, string> = {
  hline: "Horizontal line",
  vline: "Vertical line",
  trend: "Trend line",
  ray: "Ray",
  rect: "Rectangle",
  fib: "Fibonacci retracement",
  text: "Text",
  ruler: "Ruler",
  brush: "Brush",
  long: "Long position (plan)",
  short: "Short position (plan)",
};

/** Builds a drawing from the clicked points (exactly CLICKS[tool] of them; brush takes the whole path). */
export function makeDrawing(tool: Tool, pts: readonly Pt[], id: string, text?: string): Drawing | undefined {
  const [a, b, c] = pts;
  if (!a) return undefined;
  switch (tool) {
    case "hline":
    case "vline":
      return { id, kind: tool, a };
    case "text":
      return text ? { id, kind: "text", a, text } : undefined;
    case "brush":
      return pts.length >= 2 ? { id, kind: "brush", pts: [...pts] } : undefined;
    case "long":
    case "short":
      return b && c ? { id, kind: tool, a, b, c } : undefined;
    default:
      return b ? { id, kind: tool, a, b } : undefined;
  }
}

/** Fibonacci retracement levels from a (0 %) to b (100 %). */
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const fibLevels = (a: Pt, b: Pt): { ratio: number; price: number }[] => FIB_RATIOS.map((r) => ({ ratio: r, price: b.price + (a.price - b.price) * r }));

/** Ruler: Δprice, % of the start, bars and seconds between two points. */
export function measure(a: Pt, b: Pt, barSec: number) {
  const dPrice = b.price - a.price;
  return { dPrice, pct: a.price === 0 ? 0 : (dPrice / a.price) * 100, bars: barSec > 0 ? Math.round((b.time - a.time) / barSec) : 0, seconds: b.time - a.time };
}

/**
 * Position planner: reward / risk from entry a, target b, stop c. Valid only when the target is on the profit side and
 * the stop on the loss side of the entry for that direction.
 */
export function plan(kind: "long" | "short", a: Pt, b: Pt, c: Pt): { reward: number; risk: number; rr: number | undefined; valid: boolean } {
  const s = kind === "long" ? 1 : -1;
  const reward = s * (b.price - a.price);
  const risk = s * (a.price - c.price);
  const valid = reward > 0 && risk > 0;
  return { reward, risk, rr: valid ? reward / risk : undefined, valid };
}

/** Magnet: snaps a price to the nearest OHLC value of the bar at `time` when within `tolerance` (price units). */
export function magnet(p: Pt, bars: readonly Bar[], barSec: number, tolerance: number): Pt {
  if (!bars.length || barSec <= 0) return p;
  const t = Math.floor(p.time / barSec) * barSec;
  const bar = bars.find((x) => x.time === t);
  if (!bar) return p;
  let best = p.price;
  let d = tolerance;
  for (const v of [bar.open, bar.high, bar.low, bar.close].map(wadToNum)) {
    if (Math.abs(v - p.price) <= d) {
      d = Math.abs(v - p.price);
      best = v;
    }
  }
  return { time: t, price: best };
}

/** Distance (px) from point P to segment AB; for the erase tool's hit test. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ray end: extends A→B to the box edge (x ≤ w). */
export function rayEnd(ax: number, ay: number, bx: number, by: number, w: number): { x: number; y: number } {
  if (bx === ax) return { x: bx, y: by > ay ? 1e6 : -1e6 };
  const m = (by - ay) / (bx - ax);
  const x = bx > ax ? w : 0;
  return { x, y: ay + m * (x - ax) };
}

// ─── persistence (per market, per viewer; guarded) ───
const key = (market: string) => `meridian.drawings.${market.toLowerCase()}`;
const isPt = (p: unknown): p is Pt => typeof p === "object" && p !== null && Number.isFinite((p as Pt).time) && Number.isFinite((p as Pt).price);

/** Pure: keeps only well-formed drawings (bad JSON or shapes are dropped, never a crash). */
export function parseDrawings(raw: string | null): Drawing[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((d): d is Drawing => {
      const x = d as Record<string, unknown>;
      if (typeof x?.id !== "string" || typeof x.kind !== "string") return false;
      if (x.kind === "brush") return Array.isArray(x.pts) && x.pts.length >= 2 && x.pts.every(isPt);
      if (["hline", "vline", "text"].includes(x.kind)) return isPt(x.a) && (x.kind !== "text" || typeof x.text === "string");
      if (["trend", "ray", "rect", "fib", "ruler"].includes(x.kind)) return isPt(x.a) && isPt(x.b);
      if (x.kind === "long" || x.kind === "short") return isPt(x.a) && isPt(x.b) && isPt(x.c);
      return false;
    });
  } catch {
    return [];
  }
}
export function loadDrawings(market: string): Drawing[] {
  try {
    return parseDrawings(globalThis.localStorage?.getItem(key(market)) ?? null);
  } catch {
    return [];
  }
}
export function saveDrawings(market: string, d: readonly Drawing[]): void {
  try {
    globalThis.localStorage?.setItem(key(market), JSON.stringify(d));
  } catch {
    /* storage unavailable: drawings last for this page session */
  }
}
