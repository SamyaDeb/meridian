import { describe, expect, it } from "vitest";
import { meridianWindows, perplRatePoints, perplWindows, spreadHistory, withMfi } from "./crossVenue";
import type { PerplFunding } from "@/data/indexer/perpl";

const pct = (x: bigint) => x * 10n ** 16n;
const row = (feb: bigint, aprWad: bigint | undefined, timestamp: bigint): PerplFunding => ({ fundingEventBlock: feb, ratePct100k: 0n, timestamp, ...(aprWad !== undefined ? { aprWad } : {}) });

describe("cross-venue model", () => {
  it("Meridian windows straight from the indexer (missing ⇒ left out, never 0)", () => {
    expect(meridianWindows({ realizedApr1hWad: 5n, realizedApr7dWad: 7n })).toEqual({ "1h": 5n, "7d": 7n });
  });
  it("Perpl windows from FundingEventCompleted rows at Perpl's block cadence; rows without aprWad are skipped", () => {
    const rows = [row(0n, pct(10n), 0n), row(8_571n, undefined, 2_580n), row(17_142n, pct(20n), 5_160n)];
    const pts = perplRatePoints(rows);
    expect(pts).toEqual([{ feb: 0n, aprWad: pct(10n) }, { feb: 17_142n, aprWad: pct(20n) }]);
    const w = perplWindows(pts, 20_000n, 2_580n, 8_571n);
    // 1 h = 11,960 blocks back from 20,000 ⇒ [8,040, 20,000): 10 % for 9,102 blocks, 20 % for 2,858
    expect(w["1h"]).toBe((pct(10n) * 9_102n + pct(20n) * 2_858n) / 11_960n);
    expect(w["8h"]).toBeUndefined(); // history shorter than 8 h
  });
  it("testnet spread history uses the indexer's own CrossVenueFunding values", () => {
    const h = spreadHistory([{ hour: 3_600, meridianAprWad: pct(11n), perplAprWad: pct(30n) }, { hour: 7_200, meridianAprWad: pct(11n) }], 10143, []);
    expect(h.map((p) => [p.meridian, p.perpl, p.spread])).toEqual([
      [pct(11n), pct(30n), pct(-19n)],
      [pct(11n), null, null],
    ]);
  });
  it("mainnet Perpl: the rate in force at the end of each hour (by block timestamp)", () => {
    const rows = [row(1n, pct(5n), 3_000n), row(2n, pct(6n), 7_000n), row(3n, pct(9n), 11_000n)];
    const h = spreadHistory([{ hour: 0, meridianAprWad: pct(1n) }, { hour: 3_600, meridianAprWad: pct(1n) }, { hour: 7_200 }], 143, rows);
    expect(h.map((p) => p.perpl)).toEqual([pct(5n), pct(6n), pct(6n)]); // the 11,000 s event is after the last hour ends (10,800 s)
    expect(h[2]!.spread).toBeNull(); // no Meridian value ⇒ no spread
  });
  it("MFI folds in as the last service point inside each hour, else a gap", () => {
    const pts = spreadHistory([{ hour: 0 }, { hour: 3_600 }], 10143, []);
    const out = withMfi(pts, [{ t: 1_000, mfi: 1n, meridian: null, perpl: null, stale: false }, { t: 2_000, mfi: 2n, meridian: null, perpl: null, stale: false }]);
    expect(out.map((p) => p.mfi)).toEqual([2n, null]);
  });
});
