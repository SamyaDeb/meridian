// Closing a position = a reduce-only order on the opposite side for the whole size (core meridian/orders closeOrder
// rule), priced from the side it hits (a long sells into the best bid, a short buys the best ask) ± the close slippage,
// rounded to the venue's price step against the user (buy ↑, sell ↓). Sizes are already whole steps (positions are).
import { limitFrom } from "@meridian/core/exec";
import { divCeil, divFloor } from "@meridian/core/util";
import type { Venue } from "@meridian/core/route";

/** Close slippage: wider than the ticket default so a close goes through in a thin book (web PositionsCard uses a cap too). */
export const CLOSE_SLIPPAGE_BPS = 200n;

export type CloseInput = { venue: Venue; sizeWad: bigint; bestBidWad: bigint | undefined; bestAskWad: bigint | undefined; priceStepWad: bigint; slippageBps?: bigint };
export type ClosePlan = { venue: Venue; side: "buy" | "sell"; sizeWad: bigint; limitPriceWad: bigint } | { error: string };

export function planClose(i: CloseInput): ClosePlan {
  if (i.sizeWad === 0n) return { error: "No position to close" };
  const long = i.sizeWad > 0n;
  const side = long ? "sell" : "buy";
  const ref = long ? i.bestBidWad : i.bestAskWad;
  if (ref === undefined) return { error: `No ${long ? "bids" : "asks"} on ${i.venue === "perpl" ? "Perpl" : "Meridian"} right now, so the position can't be closed at a fair price. Try again in a moment.` };
  const raw = limitFrom(ref, side, i.slippageBps ?? CLOSE_SLIPPAGE_BPS);
  const limitPriceWad = side === "buy" ? divCeil(raw, i.priceStepWad) * i.priceStepWad : divFloor(raw, i.priceStepWad) * i.priceStepWad;
  return { venue: i.venue, side, sizeWad: long ? i.sizeWad : -i.sizeWad, limitPriceWad };
}
