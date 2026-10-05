import { describe, expect, it } from "vitest";
import { histogram, liqDistanceBps } from "./liqDistance";
import { WAD } from "./units";

const mmr = WAD / 10n; // 10 %
describe("liquidation distance", () => {
  // long 1 MON at entry 1.00 with 0.20 collateral: liq = (1 − 0.2)/(1 − 0.1) = 0.8889 ⇒ from a 1.00 mark: 11.11 % ⇒ 1111 bps
  it("long: hand-computed", () => {
    expect(liqDistanceBps({ size: WAD, entryPrice: WAD, collateralWad: WAD / 5n }, WAD, mmr)).toBe(1_111n);
  });
  // short 1 MON at 1.00 with 0.20: liq = 1.2/1.1 = 1.0909 ⇒ 9.09 % above ⇒ 909 bps
  it("short: hand-computed", () => {
    expect(liqDistanceBps({ size: -WAD, entryPrice: WAD, collateralWad: WAD / 5n }, WAD, mmr)).toBe(909n);
  });
  it("already past liq ⇒ 0; never liquidatable ⇒ undefined; flat ⇒ undefined", () => {
    expect(liqDistanceBps({ size: WAD, entryPrice: WAD, collateralWad: WAD / 5n }, (WAD * 8n) / 10n, mmr)).toBe(0n);
    expect(liqDistanceBps({ size: WAD, entryPrice: WAD, collateralWad: 2n * WAD }, WAD, mmr)).toBeUndefined();
    expect(liqDistanceBps({ size: 0n, entryPrice: 0n, collateralWad: 0n }, WAD, mmr)).toBeUndefined();
  });
  it("histogram counts every open position once, sizes summed", () => {
    const h = histogram(
      [
        { size: WAD, entryPrice: WAD, collateralWad: WAD / 5n }, // 11.11 % ⇒ ≤ 20 %
        { size: -2n * WAD, entryPrice: WAD, collateralWad: (2n * WAD) / 5n }, // 9.09 % ⇒ ≤ 10 %
        { size: WAD, entryPrice: WAD, collateralWad: 2n * WAD }, // never
        { size: 0n, entryPrice: 0n, collateralWad: 0n }, // flat: skipped
      ],
      WAD,
      mmr,
    );
    expect(h.map((r) => r.count)).toEqual([0, 0, 1, 1, 0, 0, 1]);
    expect(h[2]!.sizeWad).toBe(2n * WAD);
    expect(h.reduce((s, r) => s + r.count, 0)).toBe(3);
  });
});
