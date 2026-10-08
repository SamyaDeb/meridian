// Lock (fixed-rate quote) from the Meridian funding-swap book (MATH_SPEC §6): book price p = 1 + A (WAD), A = fixed APR.
// A long swap receives floating and pays fixed; a short swap pays floating and receives fixed (§6.1).
//  - Meridian perp SHORT (receives funding when positive) locks by SELLING the swap at the bids: fixed received = avg − 1,
//    rounds DOWN (paid to the user).
//  - Meridian perp LONG (pays funding) locks by BUYING the swap at the asks: fixed paid = avg − 1, rounds UP (owed).
// Size in MON notional (= the perp size), floored to the swap book's lot; the remainder keeps floating. Fees in APR-time
// (§6.5 takerFeeApr) are added to what's paid / taken from what's received. Pure: inputs are book levels and params.
import { WAD } from "../util/fixed";
import { walkBook, type BookLevel } from "./walkBook";

export type LockInput = {
  perpSide: "long" | "short";
  perpSizeWad: bigint;
  /** swap book levels (price = 1 + APR), best first */
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  /** SwapOrderBook.lotSize() */
  swapLotWad: bigint;
  /** swapParams().takerFeeApr */
  takerFeeAprWad: bigint;
};

export type LockQuote = {
  swapSide: "buy" | "sell";
  /** swap size that fills (≤ perp size, a multiple of the swap lot) */
  sizeWad: bigint;
  /** perp size left floating */
  unlockedWad: bigint;
  /** sell: fixed APR received (avg bid − 1, ↓); buy: fixed APR paid (avg ask − 1, ↑) */
  fixedAprWad: bigint | undefined;
  /** after the taker fee: received − fee / paid + fee */
  netFixedAprWad: bigint | undefined;
  levelsUsed: number;
  available: boolean;
};

export function lockQuote(i: LockInput): LockQuote {
  const swapSide = i.perpSide === "short" ? "sell" : "buy";
  const w = walkBook(swapSide === "sell" ? i.bids : i.asks, i.perpSizeWad < 0n ? -i.perpSizeWad : i.perpSizeWad, swapSide, { stepWad: i.swapLotWad });
  // walkBook rounds avg against the user already (sell ↓, buy ↑); A = p − 1 is exact (§6.7)
  const fixedAprWad = w.avgPriceWad === undefined ? undefined : w.avgPriceWad - WAD;
  const netFixedAprWad = fixedAprWad === undefined ? undefined : swapSide === "sell" ? fixedAprWad - i.takerFeeAprWad : fixedAprWad + i.takerFeeAprWad;
  const abs = i.perpSizeWad < 0n ? -i.perpSizeWad : i.perpSizeWad;
  return { swapSide, sizeWad: w.filledWad, unlockedWad: abs - w.filledWad, fixedAprWad, netFixedAprWad, levelsUsed: w.levelsUsed, available: w.filledWad > 0n };
}
