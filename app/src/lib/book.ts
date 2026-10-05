// Order-book display math (FRONTEND_TRADE_PLAN §6.2). bigint WAD; pure.
import type { DepthLevel } from "@/data/types";
import { WAD } from "./units";

/**
 * Groups levels into buckets of `groupTicks` ticks. Bids floor to the bucket, asks ceil (a bucket never shows a
 * better price than any order in it). Sizes are summed exactly; output is best-first like the input.
 */
export function aggregateLevels(levels: readonly DepthLevel[], tickSize: bigint, groupTicks: bigint, side: "bid" | "ask"): DepthLevel[] {
  if (groupTicks <= 1n) return levels.map((l) => ({ ...l }));
  const step = tickSize * groupTicks;
  const out = new Map<bigint, bigint>();
  for (const l of levels) {
    const floor = (l.priceWad / step) * step;
    const key = side === "bid" || l.priceWad % step === 0n ? floor : floor + step;
    out.set(key, (out.get(key) ?? 0n) + l.sizeWad);
  }
  return [...out.entries()]
    .sort(([a], [b]) => (side === "bid" ? (a > b ? -1 : a < b ? 1 : 0) : a < b ? -1 : a > b ? 1 : 0))
    .map(([priceWad, sizeWad]) => ({ priceWad, sizeWad }));
}

export type LadderRow = DepthLevel & {
  /** Σ size from the best level to this one (base WAD) */
  cumSizeWad: bigint;
  /** Σ size·price (quote WAD, each term rounds down) */
  cumNotionalWad: bigint;
  /** average fill price sweeping to here = cumNotional / cumSize (WAD, rounds down) */
  avgPriceWad: bigint;
  /** depth bar width in basis points of the deeper side's total (0..10 000) */
  depthBps: number;
};

/** Cumulative depth for a best-first side; `scaleSizeWad` = the larger of the two sides' totals (shared bar scale). */
export function ladder(levels: readonly DepthLevel[], scaleSizeWad: bigint): LadderRow[] {
  let cum = 0n;
  let cumN = 0n;
  return levels.map((l) => {
    cum += l.sizeWad;
    cumN += (l.sizeWad * l.priceWad) / WAD;
    return {
      ...l,
      cumSizeWad: cum,
      cumNotionalWad: cumN,
      avgPriceWad: cum === 0n ? 0n : (cumN * WAD) / cum,
      depthBps: scaleSizeWad === 0n ? 0 : Number((cum * 10_000n) / scaleSizeWad),
    };
  });
}

export const totalSize = (levels: readonly DepthLevel[]): bigint => levels.reduce((s, l) => s + l.sizeWad, 0n);

/** Spread between best bid and best ask: absolute (WAD) and in bps of the mid, rounded down. Undefined if a side is empty. */
export function spread(bestBid: bigint | undefined, bestAsk: bigint | undefined): { absWad: bigint; bps: bigint; midWad: bigint } | undefined {
  if (bestBid === undefined || bestAsk === undefined) return undefined;
  const absWad = bestAsk - bestBid;
  const midWad = (bestBid + bestAsk) / 2n;
  return { absWad, midWad, bps: midWad === 0n ? 0n : (absWad * 10_000n) / midWad };
}

/** Aggregation choices in ticks (MON-PERP tick 1e-6 ⇒ 0.000001 … 0.0001). */
export const GROUPINGS = [1n, 5n, 10n, 50n, 100n] as const;
