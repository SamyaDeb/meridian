// Basis trade plan (MOBILE_PLAN N1.4 / N6): short the venue whose funding APR is higher, long the other, EQUAL MON size
// rounded down to BOTH venues' size steps (so net MON exposure is exactly 0), and the net spread after the round-trip
// taker fees amortised over the horizon (default 30 d). `edge` = net spread > minNetApr. bigint only; costs round up,
// what the user earns rounds down. The spread is assumed to hold: the UI says so next to the number.
import { SECONDS_PER_DAY, SECONDS_PER_YEAR, WAD, abs, divCeil, divFloor } from "../util/fixed";
import type { Venue } from "./router";

export type BasisVenue = {
  /** funding APR (WAD, signed) of REAL time: meridianEffectiveAprWad / perplRateToAprWad */
  aprWad: bigint;
  takerFeeWad: bigint;
  stepWad: bigint;
};

export type BasisInput = {
  meridian: BasisVenue;
  perpl: BasisVenue;
  /** desired MON size per leg, base WAD */
  sizeWad: bigint;
  markWad: bigint;
  horizonDays?: bigint;
  /** extra entry+exit cost (e.g. book slippage from walkBook vs mark), WAD fraction of notional; rounds up as a cost */
  slippageWad?: bigint;
  minNetAprWad?: bigint;
};

export type BasisLeg = { venue: Venue; side: "long" | "short"; sizeWad: bigint };

export type BasisPlan = {
  shortVenue: Venue;
  longVenue: Venue;
  legs: [BasisLeg, BasisLeg];
  /** common step: lcm of the two venues' steps */
  stepWad: bigint;
  sizeWad: bigint;
  /** long size − short size: 0 by construction; anything else is flagged */
  netExposureWad: bigint;
  notionalWad: bigint;
  /** |APR_short − APR_long| collected by the pair */
  grossAprWad: bigint;
  /** (2·(fee_m + fee_p) + slippage) · 365 / horizon, rounds up */
  feeDragAprWad: bigint;
  netAprWad: bigint;
  /** notional · net / 365, rounds down */
  estPerDayWad: bigint;
  edge: boolean;
  flags: ("size-below-step" | "no-spread" | "net-exposure")[];
};

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
export const lcm = (a: bigint, b: bigint): bigint => {
  if (a <= 0n || b <= 0n) throw new RangeError("steps must be positive");
  return (a / gcd(a, b)) * b;
};

export function planBasis(i: BasisInput): BasisPlan {
  const horizon = i.horizonDays ?? 30n;
  if (horizon <= 0n) throw new RangeError("horizon must be positive");
  const shortVenue: Venue = i.perpl.aprWad > i.meridian.aprWad ? "perpl" : "meridian"; // tie ⇒ short Meridian (no edge anyway)
  const longVenue: Venue = shortVenue === "perpl" ? "meridian" : "perpl";
  const step = lcm(i.meridian.stepWad, i.perpl.stepWad);
  const size = (i.sizeWad / step) * step; // equal size on both legs, rounded down to both steps
  const legs: [BasisLeg, BasisLeg] = [
    { venue: "perpl", side: shortVenue === "perpl" ? "short" : "long", sizeWad: size },
    { venue: "meridian", side: shortVenue === "meridian" ? "short" : "long", sizeWad: size },
  ];
  const signed = (l: BasisLeg) => (l.side === "long" ? l.sizeWad : -l.sizeWad);
  const netExposureWad = signed(legs[0]) + signed(legs[1]);
  const notionalWad = divFloor(size * i.markWad, WAD);
  const grossAprWad = abs(i.perpl.aprWad - i.meridian.aprWad);
  const roundTrip = 2n * (i.meridian.takerFeeWad + i.perpl.takerFeeWad) + (i.slippageWad ?? 0n);
  const feeDragAprWad = divCeil(roundTrip * 365n, horizon); // cost, rounds up
  const netAprWad = grossAprWad - feeDragAprWad;
  const estPerDayWad = divFloor(notionalWad * netAprWad * SECONDS_PER_DAY, WAD * SECONDS_PER_YEAR); // earned, rounds down
  const flags: BasisPlan["flags"] = [];
  if (size === 0n) flags.push("size-below-step");
  if (grossAprWad === 0n) flags.push("no-spread");
  if (netExposureWad !== 0n) flags.push("net-exposure");
  return { shortVenue, longVenue, legs, stepWad: step, sizeWad: size, netExposureWad, notionalWad, grossAprWad, feeDragAprWad, netAprWad, estPerDayWad, edge: flags.length === 0 && netAprWad > (i.minNetAprWad ?? 0n), flags };
}
