// Price sources the chart can draw, with the label and one-line hint shown in the top bar (CHART_TOPBAR_SPEC §2).
import { REFERENCE_ENABLED } from "../datafeed/reference";
import type { PriceSource } from "../datafeed/types";

/** `label` in the menu, `short` on the toolbar button (one line at phone width; the chart's own label names the venue in full). */
export const SOURCE_LABEL: Record<PriceSource, { label: string; short: string; hint: string }> = {
  last: { label: "Last", short: "Last", hint: "Trades on Meridian's MON-PERP book" },
  mark: { label: "Mark", short: "Mark", hint: "Mark price (drives PnL, liquidation and funding)" },
  index: { label: "Index", short: "Index", hint: "Oracle MON/USD index (spot reference; nobody trades at it here)" },
  reference: { label: "MON/USD ref (Monad DEX)", short: "DEX ref", hint: "MON/USDC on Uniswap v4 (Monad mainnet) via GeckoTerminal. Not Meridian trades." },
  perpl: { label: "Perpl MON-PERP (ref)", short: "Perpl ref", hint: "Trades on Perpl's MON perp (Monad mainnet), another venue. Not Meridian trades." },
};

/**
 * Our own series first, then the DEX reference behind its flag (NEXT_PUBLIC_REFERENCE_CHART=1). Perpl is not a source
 * here: it is its own view-only market in the trade strip's dropdown (features/trade/venue.ts).
 */
export function sourceOptions(referenceEnabled = REFERENCE_ENABLED): PriceSource[] {
  return ["last", "mark", "index", ...(referenceEnabled ? (["reference"] as const) : [])];
}
