// Price sources the chart can draw, with the label and one-line hint shown in the top bar (CHART_TOPBAR_SPEC §2).
import { REFERENCE_ENABLED } from "../datafeed/reference";
import type { PriceSource } from "../datafeed/types";

export const SOURCE_LABEL: Record<PriceSource, { label: string; hint: string }> = {
  last: { label: "Last", hint: "Trades on Meridian's MON-PERP book" },
  mark: { label: "Mark", hint: "Mark price (drives PnL, liquidation and funding)" },
  index: { label: "Index", hint: "Oracle MON/USD index (spot reference; nobody trades at it here)" },
  reference: { label: "MON/USD ref (Monad DEX)", hint: "MON/USDC on Uniswap v4 (Monad mainnet) via GeckoTerminal. Not Meridian trades." },
};

/** Our own series first; the outside reference only behind its flag, and always last. */
export function sourceOptions(referenceEnabled = REFERENCE_ENABLED): PriceSource[] {
  const own: PriceSource[] = ["last", "mark", "index"];
  return referenceEnabled ? [...own, "reference"] : own;
}
