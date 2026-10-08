// Perpl unit conversion (bigint only). Market decimals come from deployments/perpl.json (copied from /v1/pub/context) or
// a live context read, never from constants here. Sources: mfi/src/perpl/units.ts (main @ 0ba1664, docs/MFI.md §3),
// K5 risk/src/perpl.ts (rates-risk @ 1edb15f, PERPL_EVENTS.md "Units").
//   PNS = price · 10^-priceDecimals, LNS = size · 10^-sizeDecimals, CNS = collateral token units (AUSD 6 dp).
import { SECONDS_PER_YEAR, WAD, divCeil, divFloor, divTrunc, pow10, scaledToWad } from "../util/fixed";

const MICROS_TO_WAD = 10n ** 12n;
const PCT100K_TO_WAD = 10n ** 13n;

/** MFI.md §3.2: API `rate` (micros per funding interval) → annualized WAD. Rounds neutral (toward zero). */
export function perplRateToAprWad(rateMicros: number | bigint, fundingIntervalSec: number | bigint): bigint {
  if (typeof rateMicros === "number" && !Number.isSafeInteger(rateMicros)) throw new RangeError("rateMicros must be a safe integer");
  const iv = BigInt(fundingIntervalSec);
  if (iv <= 0n) throw new RangeError("fundingIntervalSec must be a positive integer");
  return divTrunc(BigInt(rateMicros) * MICROS_TO_WAD * SECONDS_PER_YEAR, iv);
}

/** PERPL_EVENTS "Units" 1: onchain `fundingRatePct100k` (per interval, ×1e5) → APR WAD. Rounds neutral. Equals micros/10. */
export const perplPct100kToAprWad = (ratePct100k: bigint, fundingIntervalSec: bigint): bigint => divTrunc(ratePct100k * PCT100K_TO_WAD * SECONDS_PER_YEAR, fundingIntervalSec);

/** Fee in micros (1000 = 0.1 % = 10 bps; types.md MarketConfig) → WAD fraction of notional. Exact. */
export const perplFeeWad = (micros: number | bigint): bigint => BigInt(micros) * MICROS_TO_WAD;

/** Perpl price (PNS integer) → WAD. Exact. */
export const pnsToWad = (pns: number | bigint, priceDecimals: number): bigint => scaledToWad(BigInt(pns), priceDecimals);

/** WAD price → PNS, rounded in the named direction (a buyer's limit rounds up, a seller's down: never worse than asked). */
export function wadToPns(wad: bigint, priceDecimals: number, dir: "up" | "down"): bigint {
  const scale = pow10(18 - priceDecimals);
  return dir === "up" ? divCeil(wad, scale) : divFloor(wad, scale);
}

/** Perpl size (LNS integer) → base WAD. Exact. */
export const lnsToWad = (lns: number | bigint, sizeDecimals: number): bigint => scaledToWad(BigInt(lns), sizeDecimals);

/** Base WAD → LNS, rounds DOWN to Perpl's size step (never more size than asked). */
export const wadToLns = (wad: bigint, sizeDecimals: number): bigint => divFloor(wad, pow10(18 - sizeDecimals));

/** One Perpl size step in base WAD (10^-sizeDecimals). */
export const perplLotWad = (sizeDecimals: number): bigint => pow10(18 - sizeDecimals);

/** Collateral token units (CNS) → WAD. Exact. */
export const cnsToWad = (cns: bigint, collateralDecimals: number): bigint => scaledToWad(cns, collateralDecimals);

/** WAD → collateral token units, rounds down (paid to the user) unless told otherwise (owed by the user ⇒ up). */
export function wadToCns(wad: bigint, collateralDecimals: number, dir: "up" | "down" = "down"): bigint {
  const scale = pow10(18 - collateralDecimals);
  return dir === "up" ? divCeil(wad, scale) : divFloor(wad, scale);
}

/** MFI.md §3.3: OI notional in quote WAD = oi · mark, both scaled. Rounds down (weights only). */
export function perplOiNotionalWad(oi: number, sizeDecimals: number, mark: number, priceDecimals: number): bigint {
  return (lnsToWad(oi, sizeDecimals) * pnsToWad(mark, priceDecimals)) / WAD;
}

/** README "Fees & fee tiers": tier entry if present and in range, else the base rate (micros). */
export function feeForTier(f: { makerMicros: number; takerMicros: number; makerTiers?: number[]; takerTiers?: number[] }, tier: number, isMaker: boolean): number {
  const tiers = isMaker ? f.makerTiers : f.takerTiers;
  const base = isMaker ? f.makerMicros : f.takerMicros;
  return tiers && Number.isInteger(tier) && tier >= 0 && tier < tiers.length ? tiers[tier]! : base;
}
