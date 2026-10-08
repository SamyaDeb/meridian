// Book normalisation (both venues → WAD levels) and walkBook: what a taker order of a given size would fill against one
// side of a book. bigint only. Rounding against the user (CONTRIBUTING §2 / MOBILE_PLAN §0.4 rule 6): a buyer's average
// price and notional round UP, a seller's DOWN; the size asked is floored to the venue's step (never more than asked).
import { WAD, divCeil, divFloor, pow10 } from "../util/fixed";
import type { L2Level } from "../perpl/types";

/** One price level in WAD: price in AUSD per base, size in base. */
export type BookLevel = { priceWad: bigint; sizeWad: bigint };
export type Side = "buy" | "sell";

/** OrderBook.getDepth(isBid, n) → levels best first: price = tick · tickSize, size = lots · lotSize (exact). */
export function meridianLevels(ticks: readonly (number | bigint)[], lots: readonly bigint[], tickSizeWad: bigint, lotSizeWad: bigint): BookLevel[] {
  if (ticks.length !== lots.length) throw new Error("getDepth: ticks and lots differ in length");
  return ticks.map((t, i) => ({ priceWad: BigInt(t) * tickSizeWad, sizeWad: lots[i]! * lotSizeWad })).filter((l) => l.sizeWad > 0n);
}

/** Perpl L2 levels (PNS / LNS integers, types.md L2PriceLevel) → WAD levels (exact). */
export function perplLevels(levels: readonly L2Level[], priceDecimals: number, sizeDecimals: number): BookLevel[] {
  const ps = pow10(18 - priceDecimals);
  const ss = pow10(18 - sizeDecimals);
  return levels.filter((l) => l.s > 0 && l.o > 0).map((l) => ({ priceWad: BigInt(l.p) * ps, sizeWad: BigInt(l.s) * ss }));
}

export type Walk = {
  side: Side;
  requestedWad: bigint;
  /** requested floored to the step */
  targetWad: bigint;
  filledWad: bigint;
  /** requested − filled (step remainder + missing depth); > 0 ⇒ the book can't take the whole order */
  residualWad: bigint;
  /** Σ size·price: buyer rounds up (pays), seller down (receives) */
  notionalWad: bigint;
  /** notional / filled: buyer rounds up, seller down; undefined when nothing fills */
  avgPriceWad: bigint | undefined;
  worstPriceWad: bigint | undefined;
  levelsUsed: number;
  fills: BookLevel[];
};

/**
 * Walk `levels` (the side a taker hits: asks for a buy, bids for a sell, best first) for `sizeWad`.
 * `stepWad` = the venue's size step (Meridian lot, Perpl 10^-sizeDecimals); `limitPriceWad` stops at worse levels.
 * Never fills more than asked; throws if the levels are not best first.
 */
export function walkBook(levels: readonly BookLevel[], sizeWad: bigint, side: Side, opts: { stepWad?: bigint; limitPriceWad?: bigint } = {}): Walk {
  if (sizeWad < 0n) throw new RangeError("size must be ≥ 0");
  const step = opts.stepWad ?? 1n;
  if (step <= 0n) throw new RangeError("step must be positive");
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1]!.priceWad;
    const b = levels[i]!.priceWad;
    if (side === "buy" ? b < a : b > a) throw new Error("walkBook: levels must be best first (asks ascending for a buy, bids descending for a sell)");
  }
  const target = (sizeWad / step) * step; // sizes → down to the step
  let left = target;
  let sumPx = 0n; // Σ size·price, WAD² (exact)
  const fills: BookLevel[] = [];
  for (const l of levels) {
    if (left === 0n) break;
    if (opts.limitPriceWad !== undefined && (side === "buy" ? l.priceWad > opts.limitPriceWad : l.priceWad < opts.limitPriceWad)) break;
    let take = l.sizeWad < left ? l.sizeWad : left;
    take = (take / step) * step;
    if (take === 0n) continue;
    sumPx += take * l.priceWad;
    left -= take;
    fills.push({ priceWad: l.priceWad, sizeWad: take });
  }
  const filled = target - left;
  const up = side === "buy";
  return {
    side,
    requestedWad: sizeWad,
    targetWad: target,
    filledWad: filled,
    residualWad: sizeWad - filled,
    notionalWad: up ? divCeil(sumPx, WAD) : divFloor(sumPx, WAD), // walkBook, rounds up for a buyer / down for a seller
    avgPriceWad: filled === 0n ? undefined : up ? divCeil(sumPx, filled) : divFloor(sumPx, filled), // rounds up / down
    worstPriceWad: fills.at(-1)?.priceWad,
    levelsUsed: fills.length,
    fills,
  };
}
