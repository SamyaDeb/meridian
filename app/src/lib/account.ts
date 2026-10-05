// Account-card numbers from the live AccountView (MATH_SPEC §3.2). bigint WAD; display-side derivations only.
import type { AccountSummary } from "@/data/types";
import { divCeil } from "./math";
import { WAD } from "./units";

/** Free collateral = max(0, equity − initial margin). Rounds neutral (inputs are exact contract values). */
export const freeCollateralWad = (a: AccountSummary): bigint => (a.equity > a.initialMargin ? a.equity - a.initialMargin : 0n);

/**
 * Margin ratio = maintenance margin / equity (WAD). ≥ 1e18 ⇒ liquidatable. Rounds up (shows more risk, never less).
 * Equity ≤ 0 with a position ⇒ undefined (display "liquidatable"); flat ⇒ 0.
 */
export function marginRatioWad(a: AccountSummary): bigint | undefined {
  if (a.maintenanceMargin === 0n) return 0n;
  if (a.equity <= 0n) return undefined;
  return divCeil(a.maintenanceMargin * WAD, a.equity);
}

export type Health = "safe" | "warn" | "danger";
/** < 50 % safe, 50–80 % warn, ≥ 80 % or liquidatable danger. */
export function health(a: AccountSummary): Health {
  if (a.liquidatable) return "danger";
  const r = marginRatioWad(a);
  if (r === undefined || r >= (8n * WAD) / 10n) return "danger";
  if (r >= WAD / 2n) return "warn";
  return "safe";
}
