import { describe, expect, it } from "vitest";
import { parseMfiCurrent, parseMfiHistory } from "./mfi";

// Shapes from docs/MFI.md §7 (values = MFI.md §8 example A, synthetic).
const current = {
  version: "mfi-v0", chainId: 10143, index: { aprWad: "105439534777780673", weighting: "oi" }, stale: false, warmup: false, updatedBlock: "41234567", updatedAt: 1791234567000, venuesIncluded: ["meridian", "perpl"],
  venues: [
    { id: "meridian", included: true, status: "ok", aprWad: "109499999992992000", weightBps: 729 },
    { id: "perpl", included: false, status: "unavailable", reason: "timeout" },
  ],
};

describe("MFI API parsing", () => {
  it("current: bigints from strings, venues with status", () => {
    const c = parseMfiCurrent(current);
    expect(c.aprWad).toBe(105_439_534_777_780_673n);
    expect(c.updatedBlock).toBe(41_234_567n);
    expect(c.venues[1]).toEqual({ id: "perpl", included: false, status: "unavailable", reason: "timeout" });
  });
  it("index null (no venue ever included) is allowed", () => {
    expect(parseMfiCurrent({ ...current, index: null, stale: true }).aprWad).toBeNull();
  });
  it("rejects wrong version, number-encoded WADs, unknown venue", () => {
    expect(() => parseMfiCurrent({ ...current, version: "v9" })).toThrow(/version/);
    expect(() => parseMfiCurrent({ ...current, index: { aprWad: 0.105, weighting: "oi" } })).toThrow(/aprWad/);
    expect(() => parseMfiCurrent({ ...current, venues: [{ id: "binance", included: true, status: "ok" }] })).toThrow(/id/);
  });
  it("history: nulls preserved (gaps are not zeros)", () => {
    const h = parseMfiHistory({ version: "mfi-v0", points: [{ updatedAt: 1, aprWad: "5", meridianAprWad: "5", perplAprWad: null, venuesIncluded: ["meridian"], stale: false }] });
    expect(h).toEqual([{ t: 1, mfi: 5n, meridian: 5n, perpl: null, stale: false }]);
    expect(() => parseMfiHistory({ version: "mfi-v0", points: [{ updatedAt: "x" }] })).toThrow();
  });
});
