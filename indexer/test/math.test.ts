import { describe, it, expect } from "vitest";
import {
  WAD,
  SECONDS_PER_YEAR,
  realizedAprWad,
  rateToAprWad,
  windowBlocks,
  checkpointBucket,
  applyPerpFill,
  entryPriceWad,
  applySwapFill,
  avgFixedAprWad,
  swapPriceToAprWad,
  oiDelta,
  annualizedChangeWad,
  divCeil,
  divFloor,
  bucketStart,
} from "../src/lib/math.js";

/** MATH_SPEC §1.2 integer accrual for n blocks at constant r and I (blockTimeMs = 300). */
function accrue(blocks: number, rate: bigint, index: bigint, f0 = 0n, g0 = 0n) {
  let f = f0;
  let g = g0;
  for (let i = 0; i < blocks; i++) {
    const dtMs = 300n;
    f += (rate * index * dtMs) / (WAD * 1000n);
    g += (index * dtMs) / 1000n;
  }
  return { f, g };
}

describe("realized funding APR (MATH_SPEC §1.8)", () => {
  it("is ΔF·1e18/ΔG·YEAR with the contract's operation order", () => {
    const f1 = 123_456_789n, g1 = 10n ** 20n, f2 = 987_654_321_000n, g2 = 7n * 10n ** 22n;
    const avgRate = ((f2 - f1) * WAD) / (g2 - g1);
    expect(realizedAprWad(f1, g1, f2, g2)).toBe(avgRate * SECONDS_PER_YEAR);
  });

  it("recovers a constant 10.95% APR rate to 1e-6 (the lead's formula ·31,536,000/1e18)", () => {
    const rate = 3_472_222_222n; // MATH_SPEC §1.3 interest floor, per-second WAD
    const index = 29n * 10n ** 15n; // 0.029 AUSD / MON
    const a = accrue(1_000, rate, index);
    const b = accrue(12_000, rate, index, a.f, a.g);
    const apr = realizedAprWad(a.f, a.g, b.f, b.g)!;
    const aprFloat = Number(apr) / 1e18; // display only
    expect(Math.abs(aprFloat - Number(rateToAprWad(rate)) / 1e18)).toBeLessThan(1e-6);
    expect(aprFloat).toBeCloseTo(0.1095, 4);
  });

  it("handles negative funding and truncates toward zero like Solidity sdiv", () => {
    expect(realizedAprWad(0n, 0n, -1n, 3n)).toBe(((-1n * WAD) / 3n) * SECONDS_PER_YEAR);
    expect(((-1n * WAD) / 3n) < 0n).toBe(true);
  });

  it("is undefined for an empty window", () => {
    expect(realizedAprWad(5n, 7n, 9n, 7n)).toBeUndefined();
    expect(realizedAprWad(5n, 8n, 9n, 7n)).toBeUndefined();
  });

  it("windows are block-based (MATH_SPEC §1.1) and checkpoints bucket by 200", () => {
    expect(windowBlocks(3_600n, 300n)).toBe(12_000n);
    expect(windowBlocks(28_800n, 300n)).toBe(96_000n);
    expect(windowBlocks(86_400n, 400n)).toBe(216_000n);
    expect(windowBlocks(3_600n, 0n)).toBe(12_000n); // falls back to 300 ms
    expect(checkpointBucket(199n)).toBe(0n);
    expect(checkpointBucket(200n)).toBe(1n);
  });
});

describe("perp position mirror (MATH_SPEC §3.1)", () => {
  const P = 30n * 10n ** 15n; // 0.030

  it("increase adds Δq·P", () => {
    const r = applyPerpFill(0n, 0n, 1_000n * WAD, P);
    expect(r).toEqual({ q: 1_000n * WAD, on: 30n * WAD });
    expect(entryPriceWad(r.q, r.on)).toBe(P);
  });

  it("partial decrease releases ON·c/|q| rounded toward +∞ (long and short)", () => {
    // long 3 at ON = 10 wei-quote: close 1 ⇒ released = ceil(10/3) = 4
    expect(applyPerpFill(3n, 10n, -1n, 0n)).toEqual({ q: 2n, on: 6n });
    // short −3 at ON = −10: close 1 ⇒ released = ceil(−10/3) = −3 (toward +∞)
    expect(applyPerpFill(-3n, -10n, 1n, 0n)).toEqual({ q: -2n, on: -7n });
  });

  it("full close leaves ON = 0; overshoot flips at P", () => {
    expect(applyPerpFill(5n * WAD, 150n * WAD, -5n * WAD, P)).toEqual({ q: 0n, on: 0n });
    const flip = applyPerpFill(5n * WAD, 150n * WAD, -8n * WAD, P);
    expect(flip.q).toBe(-3n * WAD);
    expect(flip.on).toBe((-3n * WAD * P) / WAD);
  });

  it("entry price is 0 when flat", () => expect(entryPriceWad(0n, 0n)).toBe(0n));
});

describe("funding swap mirror (MATH_SPEC §6)", () => {
  it("offset example: long 1M at 12%, sell 1M at 15% ⇒ q = 0, K = −30,000 (locked spread)", () => {
    const q = 1_000_000n * WAD;
    let k = applySwapFill(0n, q, 12n * 10n ** 16n);
    expect(k).toBe(120_000n * WAD);
    expect(avgFixedAprWad(q, k)).toBe(12n * 10n ** 16n);
    k = applySwapFill(k, -q, 15n * 10n ** 16n);
    expect(k).toBe(-30_000n * WAD);
    expect(avgFixedAprWad(0n, k)).toBeUndefined();
  });

  it("book price p ⇒ fixed APR p − 1", () => {
    expect(swapPriceToAprWad(112n * 10n ** 16n)).toBe(12n * 10n ** 16n);
    expect(swapPriceToAprWad(95n * 10n ** 16n)).toBe(-5n * 10n ** 16n);
  });
});

describe("misc", () => {
  it("open-interest deltas per side", () => {
    expect(oiDelta(0n, 5n)).toEqual({ long: 5n, short: 0n });
    expect(oiDelta(5n, -2n)).toEqual({ long: -5n, short: 2n });
    expect(oiDelta(-2n, -1n)).toEqual({ long: 0n, short: -1n });
  });

  it("vault APY is the simple annualized share-price change", () => {
    const day = 86_400n;
    // +0.1% in a day ⇒ 36.5% simple APR
    expect(annualizedChangeWad(WAD, WAD + WAD / 1000n, day)).toBe((365n * WAD) / 1000n);
    expect(annualizedChangeWad(0n, WAD, day)).toBeUndefined();
    expect(annualizedChangeWad(WAD, WAD, 0n)).toBeUndefined();
  });

  it("ceil/floor division directions", () => {
    expect(divCeil(7n, 2n)).toBe(4n);
    expect(divCeil(-7n, 2n)).toBe(-3n);
    expect(divFloor(7n, 2n)).toBe(3n);
    expect(divFloor(-7n, 2n)).toBe(-4n);
    expect(() => divCeil(1n, 0n)).toThrow();
  });

  it("candle buckets", () => {
    expect(bucketStart(1_790_000_059n, 60n)).toBe(1_790_000_040n);
    expect(bucketStart(1_790_003_599n, 3_600n)).toBe(1_790_002_800n);
  });
});
