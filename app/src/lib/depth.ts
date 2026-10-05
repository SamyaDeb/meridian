// Depth-chart geometry (FRONTEND_TRADE_PLAN §6.2 Depth tab). Pure; floats only for SVG coordinates.
import type { DepthLevel } from "@/data/types";

export type DepthPoint = { x: number; y: number };

/**
 * Step-shaped cumulative depth paths for both sides in a w×h box. x = price (linear between the outermost levels shown),
 * y = cumulative size (shared scale, 0 at the bottom). Bids run from the mid leftwards, asks rightwards.
 */
export function depthPaths(bids: readonly DepthLevel[], asks: readonly DepthLevel[], w: number, h: number): { bid: DepthPoint[]; ask: DepthPoint[]; maxCum: bigint } | undefined {
  if (bids.length === 0 && asks.length === 0) return undefined;
  const lo = (bids[bids.length - 1] ?? asks[0])!.priceWad;
  const hi = (asks[asks.length - 1] ?? bids[0])!.priceWad;
  const span = hi - lo;
  const cum = (side: readonly DepthLevel[]) => {
    let c = 0n;
    return side.map((l) => (c += l.sizeWad));
  };
  const cb = cum(bids);
  const ca = cum(asks);
  const maxCum = [...cb, ...ca].reduce((m, x) => (x > m ? x : m), 0n);
  const X = (p: bigint) => (span === 0n ? w / 2 : Number(((p - lo) * 10_000n) / span) / 10_000 * w);
  const Y = (c: bigint) => (maxCum === 0n ? h : h - (Number((c * 10_000n) / maxCum) / 10_000) * h);
  const steps = (side: readonly DepthLevel[], c: bigint[]) => {
    const pts: DepthPoint[] = [];
    side.forEach((l, i) => {
      const x = X(l.priceWad);
      pts.push({ x, y: Y(i === 0 ? 0n : c[i - 1]!) }, { x, y: Y(c[i]!) });
    });
    return pts;
  };
  return { bid: steps(bids, cb), ask: steps(asks, ca), maxCum };
}
