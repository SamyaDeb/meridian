// Liquidation views for the quote screen. Meridian: MATH_SPEC §3.2 isolated price (meridian/math liquidationPriceWad,
// long ↑ short ↓ to warn early) and the adverse distance (meridian/liqDistance, rounds down). Perpl: Perpl's own rule
// (./liqPerpl, from dex-sdk via K5).
import { liqDistanceBps } from "../meridian/liqDistance";
import { liquidationPriceWad } from "../meridian/math";

export type MeridianLiq = { liqPriceWad: bigint | undefined; distanceBps: bigint | undefined };

/** A Meridian position (or a preview of one): undefined price = flat or never liquidatable. */
export function meridianLiq(p: { sizeWad: bigint; entryWad: bigint; collateralWad: bigint; markWad: bigint; mmrWad: bigint }): MeridianLiq {
  return {
    liqPriceWad: liquidationPriceWad(p.entryWad, p.collateralWad, p.sizeWad, p.mmrWad),
    distanceBps: liqDistanceBps({ size: p.sizeWad, entryPrice: p.entryWad, collateralWad: p.collateralWad }, p.markWad, p.mmrWad),
  };
}
