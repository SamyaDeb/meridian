// Trigger-order maths for the ticket (CR-012). bigint WAD; rounding in the user's favour where a bound protects them.
import { divCeil } from "@/lib/math";
import { WAD } from "@/lib/units";
import type { TriggerKind } from "./abi";

/** The order a trigger sends closes the position: a long closes by selling (isBid false). */
export const closingIsBid = (positionSizeWad: bigint): boolean => positionSizeWad < 0n;

/**
 * Trigger price from a % move off a reference (entry or mark): a stop sits against the position, a take-profit with it.
 * Long stop = ref·(1 − pct), long TP = ref·(1 + pct); shorts mirrored. pct in basis points. Rounds to the nearest wei.
 */
export function triggerFromPct(kind: TriggerKind, positionLong: boolean, refWad: bigint, bps: bigint): bigint {
  const up = (kind === "TakeProfitMarket") === positionLong;
  return (refWad * (up ? 10_000n + bps : 10_000n - bps)) / 10_000n;
}

/** Inverse for display: % distance of a trigger from the reference (bps, signed, toward zero). */
export const pctFromTrigger = (refWad: bigint, triggerWad: bigint): bigint => (refWad === 0n ? 0n : ((triggerWad - refWad) * 10_000n) / refWad);

/**
 * Onchain condition (CR-012 (2), index price by default): a long's stop fires at P ≤ trigger and its TP at P ≥ trigger;
 * a short's mirrored. Used to warn when a trigger would fire immediately.
 */
export function wouldFire(kind: TriggerKind, positionLong: boolean, priceWad: bigint, triggerWad: bigint): boolean {
  const fireBelow = (kind === "StopMarket") === positionLong;
  return fireBelow ? priceWad <= triggerWad : priceWad >= triggerWad;
}

/**
 * Worst acceptable tick for the closing market order (the user's stored limitTick): trigger ± slippage. A sell's floor
 * ceils to a tick, a buy's ceiling floors (the bound protects the user).
 */
export function worstTick(triggerWad: bigint, tickSize: bigint, closeIsBid: boolean, slippageBps: bigint): number {
  const t = closeIsBid ? (triggerWad * (10_000n + slippageBps)) / (10_000n * tickSize) : divCeil(triggerWad * (10_000n - slippageBps), 10_000n * tickSize);
  if (t < 1n || t > 16_777_215n) throw new RangeError("price outside the tick range");
  return Number(t);
}

/** Expiry block from a duration: now + ceil(seconds·1000 / blockTimeMs). */
export const expiryBlockFor = (headBlock: bigint, seconds: bigint, blockTimeMs: bigint): bigint => headBlock + divCeil(seconds * 1_000n, blockTimeMs > 0n ? blockTimeMs : 300n);

/** Estimated PnL at the trigger for the closed lots (display; realized PnL rounds down onchain). */
export const pnlAtTrigger = (positionSizeWad: bigint, entryWad: bigint, triggerWad: bigint, closeSizeWad: bigint): bigint =>
  ((positionSizeWad > 0n ? triggerWad - entryWad : entryWad - triggerWad) * closeSizeWad) / WAD;
