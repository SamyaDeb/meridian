// "Offset on Meridian": the opposite side of a Perpl position as a Meridian order, in Meridian lots (MATH_SPEC lot
// size, deployments/<chain>.json), clipped to what the visible book can fill. Never submitted from here.
import { WAD, abs, divFloor } from "./fixed";
import type { PerplSide } from "./perpl";

export type Offset = {
  side: "long" | "short";
  /** whole Meridian lots, rounded down (never more than the Perpl size) and clipped to the book */
  lots: bigint;
  sizeWad: bigint;
  /** lots the Perpl size asked for before the book clip */
  wantedLots: bigint;
  clippedToBook: boolean;
};

export function offsetOnMeridian(perplSide: PerplSide, perplSizeWad: bigint, lotSizeWad: bigint, bookLots: bigint | undefined): Offset {
  if (lotSizeWad <= 0n) throw new RangeError("lot size must be positive");
  const wantedLots = divFloor(abs(perplSizeWad), lotSizeWad); // rounds down: the hedge never exceeds the position
  const lots = bookLots !== undefined && bookLots < wantedLots ? (bookLots < 0n ? 0n : bookLots) : wantedLots;
  return { side: perplSide === "Long" ? "short" : "long", lots, sizeWad: lots * lotSizeWad, wantedLots, clippedToBook: lots < wantedLots };
}

/** The ticket's MON input for `lots` (whole MON when the lot is a whole number of MON). */
export const lotsToMonInput = (lots: bigint, lotSizeWad: bigint): string => {
  const wad = lots * lotSizeWad;
  const whole = wad / WAD;
  const frac = wad % WAD;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`;
};
