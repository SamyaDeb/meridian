// Router v1 (MOBILE_PLAN N1.4): the WHOLE order goes to the venue with the better effective price (average fill incl.
// the taker fee); tie → Meridian; a venue that can't fill the whole size (book depth or its size step) is ineligible.
// No splitting in v1. bigint only; effective prices round against the user (buy ↑, sell ↓).
import { WAD, divCeil, divFloor } from "../util/fixed";
import { walkBook, type BookLevel, type Side, type Walk } from "./walkBook";

export type Venue = "meridian" | "perpl";

export type VenueBook = {
  venue: Venue;
  /** the side a taker hits: asks for a buy, bids for a sell (best first) */
  levels: readonly BookLevel[];
  /** taker fee, WAD fraction of notional (Meridian riskParams.takerFee; Perpl taker micros · 1e12) */
  takerFeeWad: bigint;
  /** the venue's size step in base WAD (Meridian OrderBook.lotSize(); Perpl 10^-size_decimals) */
  stepWad: bigint;
  /** false ⇒ not tradeable now (onboarding incomplete, stale book, paused): never picked */
  available?: boolean;
  limitPriceWad?: bigint;
};

export type VenueQuote = {
  venue: Venue;
  eligible: boolean;
  reason?: "unavailable" | "insufficient-depth" | "size-step" | "empty";
  walk: Walk;
  /** taker fee on the notional: owed ⇒ rounds up */
  feeWad: bigint;
  /** buy: notional + fee (rounds up); sell: notional − fee (rounds down) */
  totalWad: bigint;
  /** average price after the fee: buy avg·(1 + f) ↑, sell avg·(1 − f) ↓ */
  effectivePriceWad: bigint | undefined;
};

export type Route = { side: Side; sizeWad: bigint; best: Venue | undefined; quotes: VenueQuote[] };

export function quoteVenue(b: VenueBook, side: Side, sizeWad: bigint): VenueQuote {
  const walk = walkBook(b.levels, sizeWad, side, { stepWad: b.stepWad, ...(b.limitPriceWad !== undefined ? { limitPriceWad: b.limitPriceWad } : {}) });
  const feeWad = divCeil(walk.notionalWad * b.takerFeeWad, WAD); // fee owed by the user, rounds up
  const totalWad = side === "buy" ? walk.notionalWad + feeWad : walk.notionalWad - feeWad;
  const effectivePriceWad =
    walk.avgPriceWad === undefined ? undefined : side === "buy" ? divCeil(walk.avgPriceWad * (WAD + b.takerFeeWad), WAD) : divFloor(walk.avgPriceWad * (WAD - b.takerFeeWad), WAD); // rounds up / down
  let reason: VenueQuote["reason"];
  if (b.available === false) reason = "unavailable";
  else if (walk.filledWad === 0n) reason = "empty";
  else if (walk.targetWad < walk.requestedWad) reason = "size-step";
  else if (walk.residualWad > 0n) reason = "insufficient-depth";
  return { venue: b.venue, eligible: reason === undefined, ...(reason ? { reason } : {}), walk, feeWad, totalWad, effectivePriceWad };
}

/** Better for the user: a lower effective price for a buy, higher for a sell. Equal ⇒ false. */
export const isBetter = (side: Side, a: bigint, b: bigint): boolean => (side === "buy" ? a < b : a > b);

export function route(side: Side, sizeWad: bigint, books: readonly VenueBook[]): Route {
  const quotes = books.map((b) => quoteVenue(b, side, sizeWad));
  let best: VenueQuote | undefined;
  for (const q of quotes) {
    if (!q.eligible || q.effectivePriceWad === undefined) continue;
    if (!best || isBetter(side, q.effectivePriceWad, best.effectivePriceWad!) || (q.effectivePriceWad === best.effectivePriceWad && q.venue === "meridian")) best = q;
  }
  return { side, sizeWad, best: best?.venue, quotes };
}
