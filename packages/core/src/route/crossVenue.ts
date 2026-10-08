// Ported from meridian-k5/risk/src/funding.ts (rates-risk @ 1edb15f).
// Cross-venue funding math: Perpl realized windows from FundingEventCompleted rows, the countdown to Perpl's next
// funding event, the Meridian−Perpl spread and the net carry after fees. Block numbers only, never timestamp deltas
// (MATH_SPEC §1.1: 1 s timestamps, sub-second blocks).
import { SECONDS_PER_DAY, SECONDS_PER_YEAR, WAD, abs, divCeil, divFloor, divTrunc } from "../util/fixed";

/** One Perpl funding event: the rate (APR WAD, already annualized) applies from block `feb` until the next event. */
export type PerplRatePoint = { feb: bigint; aprWad: bigint };

/**
 * Perpl's interval is published in both seconds and blocks (`/v1/pub/context` `funding_interval_sec` 2,580 and
 * `funding_interval_blocks` 8,571, PERPL_EVENTS.md): a window of `sec` seconds is `sec · blocks / interval_sec`
 * blocks, rounded up so the window never comes out shorter than asked.
 */
export const perplWindowBlocks = (sec: bigint, intervalSec: bigint, intervalBlocks: bigint): bigint => divCeil(sec * intervalBlocks, intervalSec);

export type Realized = { aprWad: bigint; windowBlocks: bigint };

/**
 * Realized APR over the last `windowBlocks` blocks before `headBlock` (PERPL_EVENTS row FundingEventCompleted): each
 * rate weighted by the blocks it was in force inside the window. `points` oldest first. Undefined when the history
 * doesn't reach back to the window start (no estimate). Rounds neutral (a reference value, docs/MFI.md §4.4).
 */
export function perplRealizedApr(points: readonly PerplRatePoint[], headBlock: bigint, windowBlocks: bigint): Realized | undefined {
  if (windowBlocks <= 0n || points.length === 0) return undefined;
  const from = headBlock - windowBlocks;
  const first = points[0]!;
  if (first.feb > from) return undefined;
  let acc = 0n;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const next = points[i + 1]?.feb ?? headBlock;
    if (next <= p.feb) continue; // republished feb or out of order: the later row wins
    const lo = p.feb > from ? p.feb : from;
    const hi = next < headBlock ? next : headBlock;
    if (hi > lo) acc += p.aprWad * (hi - lo);
  }
  return { aprWad: divTrunc(acc, windowBlocks), windowBlocks };
}

export type Countdown = {
  /** block the next event is due at: last `fundingEventBlock` + interval blocks */
  nextBlock: bigint;
  /** blocks to go, 0 once due (Perpl settles it with the next event) */
  blocksLeft: bigint;
  /** seconds at Perpl's own block cadence (interval_sec / interval_blocks), rounded up */
  secondsLeft: bigint;
  /** the head is past the due block and no new event is indexed yet */
  due: boolean;
};

/** Countdown to Perpl's next funding event from the last `fundingEventBlock` (indexer PerplMarket / exchange getFundingSumAtBlock). */
export function perplCountdown(lastFeb: bigint, headBlock: bigint, intervalBlocks: bigint, intervalSec: bigint): Countdown {
  if (intervalBlocks <= 0n || intervalSec <= 0n) throw new RangeError("bad interval");
  const nextBlock = lastFeb + intervalBlocks;
  const blocksLeft = nextBlock > headBlock ? nextBlock - headBlock : 0n;
  return { nextBlock, blocksLeft, secondsLeft: divCeil(blocksLeft * intervalSec, intervalBlocks), due: headBlock >= nextBlock };
}

/** Spread APR_meridian − APR_perpl (WAD): > 0 ⇒ Meridian longs pay more than Perpl longs. Exact. */
export const spreadAprWad = (meridianAprWad: bigint, perplAprWad: bigint): bigint => meridianAprWad - perplAprWad;

export type Carry = {
  /** the leg on each venue that collects the spread */
  meridianSide: "long" | "short";
  perplSide: "long" | "short";
  /** |spread| · notional / 365 per day, rounds down (paid to the trader) */
  grossPerDayWad: bigint;
  /** open + close on both venues at the taker fee: 2·notional·(fee_m + fee_p), rounds up (paid by the trader) */
  roundTripFeesWad: bigint;
  /** gross over the horizon minus the round trip, rounds down */
  netWad: bigint;
  /** days of carry that pay the round trip, rounded up; undefined when the spread is 0 */
  breakEvenDays: bigint | undefined;
};

/**
 * Net carry of a delta-neutral pair across the venues (short the venue whose longs pay more, long the other) at the
 * current spread, held `horizonDays` days. Fees are WAD fractions of notional (Meridian riskParams.takerFee; Perpl
 * `taker_fee` micros · 1e12). The spread is assumed to stay put: the panel says so next to the number.
 */
export function netCarry(o: { spreadAprWad: bigint; notionalWad: bigint; meridianFeeWad: bigint; perplFeeWad: bigint; horizonDays: bigint }): Carry {
  const n = abs(o.notionalWad);
  const grossPerDayWad = divFloor(abs(o.spreadAprWad) * n * SECONDS_PER_DAY, WAD * SECONDS_PER_YEAR);
  const roundTripFeesWad = divCeil(2n * n * (o.meridianFeeWad + o.perplFeeWad), WAD);
  const shortMeridian = o.spreadAprWad > 0n; // Meridian longs pay more ⇒ be short there and long on Perpl
  return {
    meridianSide: shortMeridian ? "short" : "long",
    perplSide: shortMeridian ? "long" : "short",
    grossPerDayWad,
    roundTripFeesWad,
    netWad: grossPerDayWad * o.horizonDays - roundTripFeesWad,
    breakEvenDays: grossPerDayWad > 0n ? divCeil(roundTripFeesWad, grossPerDayWad) : undefined,
  };
}
