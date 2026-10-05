// Bottom range bar of Meridian's chart: each range picks a sensible timeframe and the window it shows. Pure.
import type { Timeframe } from "../datafeed/types";

export type RangeId = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "All";
export const RANGES: readonly RangeId[] = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"];
const DAY = 86_400;
const TF: Record<RangeId, Timeframe> = { "1D": "1m", "5D": "5m", "1M": "30m", "3M": "1h", "6M": "2h", YTD: "1D", "1Y": "1D", "5Y": "1W", All: "1D" };

/** Timeframe and [from, to] window (unix seconds) for a range at `nowSec`; "All" returns no window (fit content). */
export function rangeWindow(id: RangeId, nowSec: number): { timeframe: Timeframe; from?: number; to?: number } {
  const span: Partial<Record<RangeId, number>> = { "1D": DAY, "5D": 5 * DAY, "1M": 30 * DAY, "3M": 91 * DAY, "6M": 182 * DAY, "1Y": 365 * DAY, "5Y": 5 * 365 * DAY };
  if (id === "All") return { timeframe: TF.All };
  if (id === "YTD") {
    const y = new Date(nowSec * 1_000).getUTCFullYear();
    return { timeframe: TF.YTD, from: Date.UTC(y, 0, 1) / 1_000, to: nowSec };
  }
  return { timeframe: TF[id], from: nowSec - span[id]!, to: nowSec };
}
