// Chart data for the Trade screen, pure. Prices stay bigint WAD; floats appear only at the drawing boundary
// (core wadToFloatForDisplay). Source: Perpl candles (core getCandles, api-docs rest-endpoints.md) → one point per candle
// at its close; the live price per block moves the last point or opens the next bucket. A bucket with no candle is
// carried from the previous close and flagged `gap` (drawn dimmed, never shown as a trade).
import { pnsToWad, type Candle } from "@meridian/core/perpl";

/** `priceWad` = the close; o / h / l = the bucket's open / high / low (candles view). A gap carries the close flat. */
export type Point = { t: number; priceWad: bigint; o: bigint; h: bigint; l: bigint; gap?: true };

const flat = (t: number, p: bigint, gap?: true): Point => ({ t, priceWad: p, o: p, h: p, l: p, ...(gap ? { gap } : {}) });

/** Points kept per series (≈ 4 KB of floats): enough for 1m over 4 h or 1D over ~8 months. */
export const MAX_POINTS = 240;

const bucketOf = (tMs: number, resSec: number) => tMs - (((tMs % (resSec * 1000)) + resSec * 1000) % (resSec * 1000));

function fillBetween(out: Point[], from: Point, toT: number, stepMs: number): void {
  for (let t = from.t + stepMs; t < toT; t += stepMs) out.push(flat(t, from.priceWad, true));
}

const cap = (pts: Point[]): Point[] => (pts.length > MAX_POINTS ? pts.slice(pts.length - MAX_POINTS) : pts);

/** Candles (oldest first, validated by core) → points at each close (exact), gaps carried, newest MAX_POINTS kept. */
export function candlesToPoints(candles: readonly Candle[], priceDecimals: number, resSec: number): Point[] {
  const step = resSec * 1000;
  const out: Point[] = [];
  for (const c of candles) {
    const w = (v: number) => pnsToWad(v, priceDecimals);
    const p: Point = { t: bucketOf(c.t, resSec), priceWad: w(c.c), o: w(c.o), h: w(c.h), l: w(c.l) };
    const last = out.at(-1);
    if (last && p.t <= last.t) continue;
    if (last) fillBetween(out, last, p.t, step);
    out.push(p);
  }
  return cap(out);
}

/**
 * The live price at `tMs` (one block): same bucket ⇒ the last point takes the price; a later bucket ⇒ a new point
 * (skipped buckets carried); an older bucket ⇒ ignored. Unchanged ⇒ the same array (subscribers skip the render).
 */
export function appendLive(pts: readonly Point[], resSec: number, tMs: number, priceWad: bigint): Point[] {
  const t = bucketOf(tMs, resSec);
  const last = pts.at(-1);
  if (!last) return [flat(t, priceWad)];
  if (t < last.t) return pts as Point[];
  if (t === last.t) {
    if (last.priceWad === priceWad && !last.gap) return pts as Point[];
    // the live candle: close moves, high / low widen; a gap bucket that sees a price opens at the carried close
    const o = last.gap ? last.priceWad : last.o;
    const h = last.gap ? (priceWad > o ? priceWad : o) : priceWad > last.h ? priceWad : last.h;
    const l = last.gap ? (priceWad < o ? priceWad : o) : priceWad < last.l ? priceWad : last.l;
    return [...pts.slice(0, -1), { t, priceWad, o, h, l }];
  }
  const out = [...pts];
  fillBetween(out, last, t, resSec * 1000);
  out.push(flat(t, priceWad));
  return cap(out);
}

/** Close of the last point at or before `tMs`; undefined when the series starts later. */
export function refPriceAt(pts: readonly Point[], tMs: number): bigint | undefined {
  let ref: bigint | undefined;
  for (const p of pts) {
    if (p.t > tMs) break;
    ref = p.priceWad;
  }
  return ref;
}

/** 24 h change of `liveWad` against the close 24 h ago, bps, toward zero (display). */
export function change24hBps(pts: readonly Point[], nowMs: number, liveWad: bigint | undefined): bigint | undefined {
  if (liveWad === undefined) return undefined;
  const ref = refPriceAt(pts, nowMs - 86_400_000);
  if (ref === undefined || ref <= 0n) return undefined;
  return ((liveWad - ref) * 10_000n) / ref; // bigint division truncates toward zero
}

/** Finger x → nearest point index (UI thread). */
export function scrubIndex(x: number, width: number, n: number): number {
  "worklet";
  if (n <= 1 || width <= 0) return 0;
  const i = Math.round((x / width) * (n - 1));
  return i < 0 ? 0 : i > n - 1 ? n - 1 : i;
}

export type Domain = { lo: number; hi: number };

/** y-range for the drawn prices + the lines that must stay visible (mark, entry), padded 8 %. */
export function priceDomain(values: readonly number[], keep: readonly number[]): Domain {
  const all = [...values, ...keep].filter((v) => Number.isFinite(v));
  if (all.length === 0) return { lo: 0, hi: 1 };
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo <= 0) {
    const pad = Math.abs(hi) * 0.01 || 1;
    lo -= pad;
    hi += pad;
  }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

/** y of a horizontal line in a `height` box; outside the domain it is pinned to the edge with the side it lies on. */
export function placeLine(v: number, d: Domain, height: number): { y: number; off: "above" | "below" | undefined } {
  if (v > d.hi) return { y: 0, off: "above" };
  if (v < d.lo) return { y: height, off: "below" };
  return { y: height - ((v - d.lo) / (d.hi - d.lo)) * height, off: undefined };
}
