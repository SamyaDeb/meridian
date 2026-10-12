// Pure model of the cross-venue funding panel: Meridian (per block, indexer FundingWindow) vs Perpl (per interval,
// indexer PerplFunding = FundingEventCompleted rows, PERPL_EVENTS.md), the spread and its history.
import { perplRealizedApr, perplWindowBlocks, spreadAprWad, type PerplRatePoint } from "@meridian/risk";
import type { CrossVenueHour } from "@/data/indexer/funding";
import type { PerplFunding } from "@/data/indexer/perpl";
import type { Market } from "@/data/types";
import type { MfiPoint } from "@/data/mfi";

export const WINDOWS = [
  { id: "1h", sec: 3_600n },
  { id: "8h", sec: 28_800n },
  { id: "24h", sec: 86_400n },
  { id: "7d", sec: 604_800n },
] as const;
export type WindowId = (typeof WINDOWS)[number]["id"];
export type Windows = Partial<Record<WindowId, bigint>>;

/** Meridian's realized windows as the indexer computed them (the ring-buffer ΔF/ΔG, same as averageFundingApr). */
export const meridianWindows = (m: Pick<Market, "realizedApr1hWad" | "realizedApr8hWad" | "realizedApr24hWad" | "realizedApr7dWad">): Windows => ({
  ...(m.realizedApr1hWad !== undefined ? { "1h": m.realizedApr1hWad } : {}),
  ...(m.realizedApr8hWad !== undefined ? { "8h": m.realizedApr8hWad } : {}),
  ...(m.realizedApr24hWad !== undefined ? { "24h": m.realizedApr24hWad } : {}),
  ...(m.realizedApr7dWad !== undefined ? { "7d": m.realizedApr7dWad } : {}),
});

/** Indexer rows (oldest first) → rate points; a row without `aprWad` (perp missing from the seeded context) is skipped. */
export const perplRatePoints = (rows: readonly PerplFunding[]): PerplRatePoint[] =>
  rows.filter((r): r is PerplFunding & { aprWad: bigint } => r.aprWad !== undefined).map((r) => ({ feb: r.fundingEventBlock, aprWad: r.aprWad }));

/**
 * Perpl's realized windows at `headBlock` (its chain's head), from its own funding events, each rate weighted by the
 * blocks it was in force (@meridian/risk perplRealizedApr). A window the history doesn't cover is left out.
 */
export function perplWindows(points: readonly PerplRatePoint[], headBlock: bigint, intervalSec: bigint, intervalBlocks: bigint): Windows {
  const out: Windows = {};
  for (const w of WINDOWS) {
    const r = perplRealizedApr(points, headBlock, perplWindowBlocks(w.sec, intervalSec, intervalBlocks));
    if (r) out[w.id] = r.aprWad;
  }
  return out;
}

/**
 * Hourly history of both venues and the spread. Testnet (10143): the indexer's own CrossVenueFunding rows (both
 * venues on one chain). Mainnet Perpl (143) next to Meridian testnet: the Perpl rate in force at the end of each hour
 * (its funding rows by block timestamp; hourly alignment only, no per-block math) beside Meridian's realized 1 h.
 */
export function spreadHistory(hours: readonly CrossVenueHour[], perplChain: number, perplRows: readonly PerplFunding[]): MfiPoint[] {
  const rows = perplRows.filter((r) => r.aprWad !== undefined);
  let j = -1;
  return hours.map((h) => {
    let perpl: bigint | null;
    if (perplChain === 10143) perpl = h.perplAprWad ?? null;
    else {
      const end = BigInt(h.hour + 3_600);
      while (j + 1 < rows.length && rows[j + 1]!.timestamp < end) j++;
      perpl = j >= 0 ? rows[j]!.aprWad! : null;
    }
    const meridian = h.meridianAprWad ?? null;
    return { t: h.hour * 1000, mfi: null, meridian, perpl, spread: meridian !== null && perpl !== null ? spreadAprWad(meridian, perpl) : null, stale: false };
  });
}

/** MFI history points (MFI service, one per 60 s) folded into the hourly series: the last MFI value inside each hour. */
export function withMfi(points: MfiPoint[], mfi: readonly MfiPoint[]): MfiPoint[] {
  let j = -1;
  return points.map((p) => {
    while (j + 1 < mfi.length && mfi[j + 1]!.t < p.t + 3_600_000) j++;
    const v = j >= 0 && mfi[j]!.t >= p.t ? mfi[j]!.mfi : null;
    return { ...p, mfi: v };
  });
}

/**
 * CR-017: the Perpl-funding swap market's fixed APR against Perpl's floating APR. `spreadNowWad` = fixed − floating
 * now (what paying fixed costs over receiving floating at today's rate); `spread8hWad` against the realized 8 h. Pure.
 */
export function perplFixedVsFloating(
  fixedAprWad: bigint | undefined,
  floatingNowAprWad: bigint | undefined,
  realized8hAprWad: bigint | undefined,
): { spreadNowWad: bigint | undefined; spread8hWad: bigint | undefined } {
  return {
    spreadNowWad: fixedAprWad !== undefined && floatingNowAprWad !== undefined ? fixedAprWad - floatingNowAprWad : undefined,
    spread8hWad: fixedAprWad !== undefined && realized8hAprWad !== undefined ? fixedAprWad - realized8hAprWad : undefined,
  };
}
