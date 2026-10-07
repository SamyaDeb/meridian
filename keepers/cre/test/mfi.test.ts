import { describe, expect, it } from "vitest";
import { computeMfi, fundingInForce, meridianOiNotionalWad, perplFundingPath, perplOiNotionalWad, perplRateToAprWad, scaledToWad, WAD } from "../shared/mfi";
import * as service from "../../../mfi/src/perpl/units";
import { computeMfi as serviceMfi } from "../../../mfi/src/mfi/compute";

describe("MFI port matches the offchain service (mfi/)", () => {
  it("Perpl rate → APR, same as mfi/src/perpl/units.ts, rounds toward zero", () => {
    for (const [r, iv] of [[12, 2580], [-7, 2580], [40, 3600], [-1, 7], [0, 2580]] as const) {
      expect(perplRateToAprWad(BigInt(r), BigInt(iv))).toBe(service.perplRateToAprWad(r, iv));
    }
    // −1 micro over 7 s: −4.505…e15 truncates toward zero, not floor
    expect(perplRateToAprWad(-1n, 7n)).toBe(-(10n ** 12n * 31_536_000n) / 7n);
    expect(() => perplRateToAprWad(1n, 0n)).toThrow(RangeError);
  });

  it("OI notionals", () => {
    expect(perplOiNotionalWad(2_838_157n, 0, 2_710n, 5)).toBe(service.perplOiNotionalWad(2_838_157, 0, 2_710, 5));
    expect(meridianOiNotionalWad(10_000n * WAD, 29n * 10n ** 15n)).toBe(290n * WAD);
    expect(scaledToWad(5n, 18)).toBe(5n);
    expect(() => scaledToWad(1n, 19)).toThrow(RangeError);
  });

  it("index = OI-weighted mean, equal when no OI, null when empty; same as the service", () => {
    const venues = [
      { aprWad: 109_499_999_992_992_000n, oiWad: 93_173_850_000_000_000_000_000n },
      { aprWad: 105_120_000_000_000_000n, oiWad: 1_184_000_000_000_000_000_000_000n },
    ];
    const svc = serviceMfi([
      { id: "meridian", status: "ok", aprWad: venues[0]!.aprWad, weightOiWad: venues[0]!.oiWad },
      { id: "perpl", status: "ok", aprWad: venues[1]!.aprWad, weightOiWad: venues[1]!.oiWad },
    ]);
    expect(computeMfi(venues)).toBe(svc.aprWad);
    expect(computeMfi([{ aprWad: 3n, oiWad: 0n }, { aprWad: -4n, oiWad: 0n }])).toBe(0n); // (3 − 4) / 2 → 0 (toward zero)
    expect(computeMfi([])).toBeNull();
  });

  it("the index always lies within the venue APRs (what MeridianMfiFeed enforces)", () => {
    let seed = 7n;
    const rnd = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n);
    for (let i = 0; i < 500; i++) {
      const x = (rnd() % (20n * WAD)) - 10n * WAD;
      const y = (rnd() % (20n * WAD)) - 10n * WAD;
      const m = computeMfi([{ aprWad: x, oiWad: rnd() % 10n ** 30n }, { aprWad: y, oiWad: rnd() % 10n ** 30n }])!;
      expect(m >= (x < y ? x : y) && m <= (x < y ? y : x)).toBe(true);
    }
  });

  it("funding in force: newest with at.t <= now; future events ignored", () => {
    const ev = [
      { at: { t: 1000 }, feb: 1, rate: 5 },
      { at: { t: 3000 }, feb: 3, rate: 9 },
      { at: { t: 2000 }, feb: 2, rate: 7 },
    ];
    expect(fundingInForce(ev, 2500)?.feb).toBe(2);
    expect(fundingInForce(ev, 500)?.feb).toBe(1); // nothing in force yet: oldest
    expect(fundingInForce([], 1)).toBeUndefined();
    expect(perplFundingPath(64, 10_000_000, 2580)).toBe("/v1/market-data/64/funding/4840000-12580000");
  });
});
