// Meridian funding card numbers (FRONTEND_TRADE_PLAN §6.6). bigint WAD; MATH_SPEC §1.2 / §1.4.
import { divCeil } from "./math";
import { WAD } from "./units";

/**
 * Funding over `seconds` for a position of size q at the current per-second rate r and index I:
 * ΔF = r·I·dt (per base unit), owed = q·ΔF. + = the account pays, − = earns. Pays round up, earnings round down in
 * magnitude (CLAUDE.md §2: never overstate what the user receives).
 */
export function fundingOverWad(sizeWad: bigint, ratePerSecondWad: bigint, indexWad: bigint, seconds: bigint): bigint {
  const num = sizeWad * ratePerSecondWad * indexWad * seconds; // WAD³
  const d = WAD * WAD;
  return num >= 0n ? divCeil(num, d) : -(-num / d); // earnings: magnitude truncated (toward zero)
}

export const SECONDS_PER_DAY = 86_400n;

/** Funding APR WAD of the per-second rate (r·YEAR). */
export const aprOfRate = (ratePerSecondWad: bigint): bigint => ratePerSecondWad * 31_536_000n;
