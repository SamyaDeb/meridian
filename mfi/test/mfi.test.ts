import { describe, expect, it } from "vitest";
import { MinOiWindow, computeMfi } from "../src/mfi/compute";

const E18 = 10n ** 18n;
// MFI.md §8 (synthetic inputs, also checked by docs/mfi/worked-examples.mjs)
const aM = 109_499_999_992_992_000n;
const aP = 105_120_000_000_000_000n;
const oiM = 93_173_850n * 10n ** 15n;
const oiP = 1_184_000n * E18;

describe("computeMfi weighting (MFI.md §4.2)", () => {
  it("example A: OI-weighted, both venues", () => {
    const r = computeMfi([{ id: "meridian", status: "ok", aprWad: aM, weightOiWad: oiM }, { id: "perpl", status: "ok", aprWad: aP, weightOiWad: oiP }]);
    expect(r).toEqual({ aprWad: 105_439_534_777_780_673n, weighting: "oi", included: ["meridian", "perpl"], weightBps: { meridian: 729, perpl: 9270 } });
  });
  it("example B: one venue down ⇒ the other's rate exactly, with the venue list saying so", () => {
    const r = computeMfi([{ id: "meridian", status: "ok", aprWad: aM, weightOiWad: oiM }, { id: "perpl", status: "unavailable", reason: "timeout" }]);
    expect(r.aprWad).toBe(aM);
    expect(r.included).toEqual(["meridian"]);
    expect(r.weightBps).toEqual({ meridian: 10_000 });
  });
  it("a venue with a stale/invalid status is excluded even if it carries an APR", () => {
    const r = computeMfi([{ id: "meridian", status: "ok", aprWad: aM, weightOiWad: oiM }, { id: "perpl", status: "stale", aprWad: -10n * E18, weightOiWad: oiP }]);
    expect(r.aprWad).toBe(aM);
  });
  it("example D: zero OI ⇒ equal weights", () => {
    const r = computeMfi([{ id: "meridian", status: "ok", aprWad: aM, weightOiWad: 0n }, { id: "perpl", status: "ok", aprWad: aP }]);
    expect(r).toMatchObject({ aprWad: 107_309_999_996_496_000n, weighting: "equal", weightBps: { meridian: 5000, perpl: 5000 } });
  });
  it("example E: nothing live ⇒ null", () => {
    expect(computeMfi([{ id: "meridian", status: "oracle-stale" }, { id: "perpl", status: "invalid" }])).toEqual({ aprWad: null, weighting: "none", included: [], weightBps: {} });
  });
});

describe("rounding (neutral = toward zero, MFI.md §4.4)", () => {
  it("example C: negative rate", () => {
    const r = computeMfi([{ id: "meridian", status: "ok", aprWad: aM, weightOiWad: oiM }, { id: "perpl", status: "ok", aprWad: -85_862_310_385_064_177n, weightOiWad: oiP }]);
    expect(r.aprWad).toBe(-71_610_015_286_148_356n);
  });
  it("symmetric: flipping every sign flips the index exactly (no floor bias)", () => {
    const v = (s: bigint) => computeMfi([{ id: "meridian", status: "ok", aprWad: s * 7n, weightOiWad: 3n }, { id: "perpl", status: "ok", aprWad: s * 2n, weightOiWad: 1n }]).aprWad;
    expect(v(1n)).toBe(5n); // (21 + 2) / 4 = 5.75 → 5
    expect(v(-1n)).toBe(-5n); // −5.75 → −5 (a floor would give −6)
  });
  it("the index lies within [min, max] of the included rates", () => {
    for (let i = 0; i < 200; i++) {
      const a = BigInt(Math.floor(Math.random() * 2e6) - 1e6) * 10n ** 12n;
      const b = BigInt(Math.floor(Math.random() * 2e6) - 1e6) * 10n ** 12n;
      const wa = BigInt(Math.floor(Math.random() * 1e9));
      const wb = BigInt(Math.floor(Math.random() * 1e9)) + 1n;
      const r = computeMfi([{ id: "meridian", status: "ok", aprWad: a, weightOiWad: wa }, { id: "perpl", status: "ok", aprWad: b, weightOiWad: wb }]).aprWad!;
      expect(r >= (a < b ? a : b) && r <= (a > b ? a : b)).toBe(true);
    }
  });
});

describe("MinOiWindow (MFI.md §4.1)", () => {
  it("weight = 1 h minimum; a spike moves nothing, a sustained drop does", () => {
    const w = new MinOiWindow();
    const t0 = 1_000_000_000;
    for (let i = 0; i <= 60; i++) w.add(t0 + i * 60_000, 100n);
    w.add(t0 + 61 * 60_000, 10_000n); // pump
    expect(w.min(t0 + 61 * 60_000)).toBe(100n);
    w.add(t0 + 62 * 60_000, 50n);
    expect(w.min(t0 + 62 * 60_000)).toBe(50n);
    expect(w.warmup(t0 + 62 * 60_000)).toBe(false);
  });
  it("forgets samples older than the window and reports warm-up", () => {
    const w = new MinOiWindow(3_600_000);
    w.add(0, 1n);
    expect(w.warmup(60_000)).toBe(true);
    w.add(3_700_000, 5n);
    expect(w.min(3_700_000)).toBe(5n);
  });
});
