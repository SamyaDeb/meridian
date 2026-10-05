import { describe, expect, it } from "vitest";
import { SECONDS_PER_DAY, aprOfRate, fundingOverWad } from "./fundingCard";
import { WAD } from "./units";

describe("funding card math (MATH_SPEC §1.7 b)", () => {
  // interest only: r = 3.4722e-9 /s (WAD 3_472_222_222), I = 0.029; 1,000,000 MON long for 1 day owes ≈ 8.70 AUSD
  const r = 3_472_222_222n;
  const I = 29n * 10n ** 15n;
  it("matches the worked example: 1M MON long pays ≈ 8.70 AUSD per day", () => {
    const owed = fundingOverWad(1_000_000n * WAD, r, I, SECONDS_PER_DAY);
    expect(owed).toBeGreaterThan(869n * 10n ** 16n);
    expect(owed).toBeLessThan(871n * 10n ** 16n);
  });
  it("a short earns the same magnitude, rounded toward zero (never overstated)", () => {
    const pay = fundingOverWad(1_000_000n * WAD, r, I, SECONDS_PER_DAY);
    const earn = fundingOverWad(-1_000_000n * WAD, r, I, SECONDS_PER_DAY);
    expect(earn).toBeLessThan(0n);
    expect(-earn).toBeLessThanOrEqual(pay);
    expect(pay + earn).toBeLessThanOrEqual(1n);
  });
  it("flat or zero rate ⇒ 0; APR = r·YEAR", () => {
    expect(fundingOverWad(0n, r, I, SECONDS_PER_DAY)).toBe(0n);
    expect(fundingOverWad(WAD, 0n, I, SECONDS_PER_DAY)).toBe(0n);
    expect(aprOfRate(r)).toBe(r * 31_536_000n);
    expect(Number(aprOfRate(r)) / 1e18).toBeCloseTo(0.1095, 4);
  });
});
