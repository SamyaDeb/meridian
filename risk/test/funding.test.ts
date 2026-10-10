import { describe, expect, it } from "vitest";
import { WAD, lotsToMonInput, netCarry, offsetOnMeridian, perplCountdown, perplRealizedApr, perplWindowBlocks, spreadAprWad } from "../src";

const pct = (x: bigint) => x * 10n ** 16n; // whole percent → WAD

describe("Perpl realized windows (FundingEventCompleted rows)", () => {
  const pts = [
    { feb: 1_000n, aprWad: pct(10n) },
    { feb: 9_571n, aprWad: pct(-20n) },
    { feb: 18_142n, aprWad: pct(30n) },
  ];
  it("weights each rate by the blocks it was in force", () => {
    // window 10,000 back from 20,000: [10,000, 20,000): −20 % for 8,142 blocks, 30 % for 1,858
    const r = perplRealizedApr(pts, 20_000n, 10_000n)!;
    expect(r.aprWad).toBe((pct(-20n) * 8_142n + pct(30n) * 1_858n) / 10_000n);
  });
  it("undefined when the history doesn't reach back (no estimate)", () => {
    expect(perplRealizedApr(pts, 20_000n, 19_500n)).toBeUndefined();
    expect(perplRealizedApr([], 20_000n, 10n)).toBeUndefined();
  });
  it("a republished feb (same block) keeps the later row", () => {
    const r = perplRealizedApr([{ feb: 0n, aprWad: pct(5n) }, { feb: 100n, aprWad: pct(1n) }, { feb: 100n, aprWad: pct(2n) }], 200n, 200n)!;
    expect(r.aprWad).toBe((pct(5n) * 100n + pct(2n) * 100n) / 200n);
  });
  it("rounds toward zero for negative rates too", () => {
    const r = perplRealizedApr([{ feb: 0n, aprWad: -1n }, { feb: 1n, aprWad: 0n }], 3n, 3n)!;
    expect(r.aprWad).toBe(0n); // −1/3 → 0, not −1
  });
  it("window seconds → Perpl blocks at its published cadence, rounded up: 1 h = 11,960 blocks", () => {
    expect(perplWindowBlocks(3_600n, 2_580n, 8_571n)).toBe(11_960n); // 11,959.5…
    expect(perplWindowBlocks(2_580n, 2_580n, 8_571n)).toBe(8_571n);
  });
});

describe("countdown to the next Perpl funding event (blocks, never timestamps)", () => {
  it("last feb + 8,571 blocks; seconds at 2,580 s / 8,571 blocks, rounded up", () => {
    const c = perplCountdown(69_150_828n, 69_156_421n, 8_571n, 2_580n);
    expect(c.nextBlock).toBe(69_159_399n);
    expect(c.blocksLeft).toBe(2_978n);
    expect(c.secondsLeft).toBe(897n); // 896.4… → 897
    expect(c.due).toBe(false);
  });
  it("due once the head passes it", () => {
    const c = perplCountdown(100n, 9_000n, 8_571n, 2_580n);
    expect(c).toEqual({ nextBlock: 8_671n, blocksLeft: 0n, secondsLeft: 0n, due: true });
  });
  it("rejects a zero interval", () => expect(() => perplCountdown(0n, 0n, 0n, 1n)).toThrow());
});

describe("spread and net carry", () => {
  it("spread = Meridian − Perpl", () => expect(spreadAprWad(pct(11n), pct(37n))).toBe(pct(-26n)));
  it("Perpl longs pay more ⇒ long Meridian, short Perpl; fees round up, carry rounds down", () => {
    // 10,000 AUSD, spread −26 %: 10,000 · 0.26 / 365 = 7.1232876… per day
    const c = netCarry({ spreadAprWad: pct(-26n), notionalWad: 10_000n * WAD, meridianFeeWad: 5n * 10n ** 14n, perplFeeWad: 345n * 10n ** 12n, horizonDays: 7n });
    expect(c.meridianSide).toBe("long");
    expect(c.perplSide).toBe("short");
    expect(c.grossPerDayWad).toBe(7_123_287_671_232_876_712n); // floor
    expect(c.roundTripFeesWad).toBe(16_900_000_000_000_000_000n); // 2 · 10,000 · (5 + 3.45) bps = 16.9
    expect(c.breakEvenDays).toBe(3n); // 16.9 / 7.12 = 2.37 → 3
    expect(c.netWad).toBe(7_123_287_671_232_876_712n * 7n - 16_900_000_000_000_000_000n);
  });
  it("zero spread ⇒ no break-even, net = −fees", () => {
    const c = netCarry({ spreadAprWad: 0n, notionalWad: 100n * WAD, meridianFeeWad: 0n, perplFeeWad: 1n, horizonDays: 1n });
    expect(c.breakEvenDays).toBeUndefined();
    expect(c.netWad).toBe(-200n); // fees = 2 · 100e18 · 1 wei / 1e18 = 200 wei
  });
});

describe("offset on Meridian", () => {
  const LOT = 100n * WAD; // Meridian MON-PERP lot (app/src/lib/units.ts PERP_LOT_SIZE_WAD)
  it("opposite side, whole lots rounded down, clipped to the book", () => {
    expect(offsetOnMeridian("Long", 2_600n * WAD, LOT, undefined)).toEqual({ side: "short", lots: 26n, sizeWad: 2_600n * WAD, wantedLots: 26n, clippedToBook: false });
    expect(offsetOnMeridian("Short", 2_650n * WAD, LOT, 10n)).toEqual({ side: "long", lots: 10n, sizeWad: 1_000n * WAD, wantedLots: 26n, clippedToBook: true });
    expect(offsetOnMeridian("Long", 99n * WAD, LOT, 5n).lots).toBe(0n);
  });
  it("ticket input in MON", () => {
    expect(lotsToMonInput(26n, LOT)).toBe("2600");
    expect(lotsToMonInput(3n, WAD / 2n)).toBe("1.5");
  });
});
