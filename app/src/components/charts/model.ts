// Pure chart geometry for the Rates & Risk page (testable without a DOM). Values in, pixels out.
import type { MfiPoint } from "@/data/mfi";

export const WAD = 10n ** 18n;
/** APR WAD → percent (display only; the data stays bigint). */
export const aprPct = (wad: bigint): number => Number((wad * 1_000_000n) / WAD) / 10_000;

export type SeriesKey = "mfi" | "meridian" | "perpl" | "spread";
export const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: "mfi", label: "MFI", color: "var(--viz-1)" },
  { key: "meridian", label: "Meridian", color: "var(--viz-2)" },
  { key: "perpl", label: "Perpl", color: "var(--viz-3)" },
];
/** Meridian − Perpl (Rates & Risk cross-venue panel); not part of the MFI card's default series. */
export const SPREAD_SERIES = { key: "spread" as const, label: "Spread (Meridian − Perpl)", color: "var(--viz-1)" }; // drawn on its own chart, so slot 1 is free
/** A point's value for a series; a series the point doesn't carry is a gap. */
export const valueOf = (p: MfiPoint, k: SeriesKey): bigint | null => p[k] ?? null;

/** "Nice" ticks covering [lo, hi] (≥ 2 ticks), always including 0 when the range crosses it. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0];
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9 && out.length < 12; v += step) out.push(Number(v.toFixed(10)));
  if (out[out.length - 1]! < hi) out.push(Number((out[out.length - 1]! + step).toFixed(10)));
  return out;
}

export type LineModel = {
  x: (t: number) => number;
  y: (pct: number) => number;
  yTicks: number[];
  xTicks: number[];
  paths: Record<SeriesKey, string>;
  last: Partial<Record<SeriesKey, { x: number; y: number; pct: number }>>;
};

/** Lines break at gaps (null = venue not included that cycle): no interpolation across missing data. */
export function lineModel(points: MfiPoint[], w: number, h: number, pad = { l: 44, r: 12, t: 10, b: 22 }, series: readonly { key: SeriesKey }[] = SERIES): LineModel | undefined {
  if (points.length === 0) return undefined;
  const vals = points.flatMap((p) => series.map((s) => valueOf(p, s.key)).filter((v): v is bigint => v !== null).map(aprPct));
  if (vals.length === 0) return undefined;
  const yTicks = niceTicks(Math.min(...vals, 0), Math.max(...vals, 0));
  const y0 = yTicks[0]!;
  const y1 = yTicks[yTicks.length - 1]!;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const x = (t: number) => pad.l + (t1 === t0 ? (w - pad.l - pad.r) / 2 : ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r));
  const y = (pct: number) => pad.t + (1 - (pct - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  const paths = {} as Record<SeriesKey, string>;
  const last: LineModel["last"] = {};
  for (const s of series) {
    let d = "";
    let pen = false;
    for (const p of points) {
      const v = valueOf(p, s.key);
      if (v === null) {
        pen = false;
        continue;
      }
      const pct = aprPct(v);
      d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(pct).toFixed(1)}`;
      pen = true;
      last[s.key] = { x: x(p.t), y: y(pct), pct };
    }
    paths[s.key] = d;
  }
  const xTicks = t1 === t0 ? [t0] : [t0, t0 + (t1 - t0) / 2, t1];
  return { x, y, yTicks, xTicks, paths, last };
}

/** Index of the point nearest to pixel x (for the crosshair). */
export function nearestIndex(points: MfiPoint[], m: LineModel, px: number): number {
  let best = 0;
  let bd = Infinity;
  points.forEach((p, i) => {
    const d = Math.abs(m.x(p.t) - px);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

export const fmtPct = (pct: number) => `${pct >= 0 ? "" : "−"}${Math.abs(pct).toFixed(2)}%`;
export const fmtTime = (t: number) => new Date(t).toISOString().slice(11, 16) + " UTC";
