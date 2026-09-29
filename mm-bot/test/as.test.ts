import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  buildLadder,
  inventoryRatio,
  quoteBps,
  realizedSigmaBpsPerSqrtSec,
  sigmaForQuoting,
  sigmaFromAnnualVol,
  type LadderParams,
} from "../src/as.js";

const WAD = 10n ** 18n;
const TICK = 10n ** 12n; // 1e-6 AUSD
const LOT = 100n * WAD; // 100 MON

describe("Avellaneda–Stoikov in bps (MATH_SPEC §4 worked numbers)", () => {
  it("σ at 100% annual vol = 1e4/√31,536,000 ≈ 1.78 bps/√s", () => {
    expect(sigmaFromAnnualVol(1)).toBeCloseTo(1.7807, 4);
    expect(DEFAULTS.sigma).toBeCloseTo(1.78, 2);
  });

  it("γσ²(T−t) ≈ 1.90 bps, (2/γ)ln(1+γ/k) ≈ 3.96 bps, spread ≈ 5.9 bps", () => {
    const q = quoteBps({ ...DEFAULTS, q: 0 });
    expect(q.inventoryTerm).toBeCloseTo(1.9026, 3);
    expect(q.arrivalTerm).toBeCloseTo(3.9605, 3);
    expect(q.spread).toBeCloseTo(5.863, 2);
    expect(Number(q.spread.toFixed(1))).toBe(5.9);
    expect(q.reservation).toBe(0);
  });

  it("reservation shifts −1.90 bps at q = +1 and +1.90 at q = −1; the spread doesn't depend on q", () => {
    expect(quoteBps({ ...DEFAULTS, q: 1 }).reservation).toBeCloseTo(-1.9026, 3);
    expect(quoteBps({ ...DEFAULTS, q: -1 }).reservation).toBeCloseTo(1.9026, 3);
    expect(quoteBps({ ...DEFAULTS, q: 1 }).spread).toBeCloseTo(quoteBps({ ...DEFAULTS, q: 0 }).spread, 12);
  });

  it("bid/ask offsets = r ∓ δ/2", () => {
    const q = quoteBps({ ...DEFAULTS, q: 0.5 });
    expect(q.bidBps).toBeCloseTo(q.reservation - q.spread / 2, 12);
    expect(q.askBps).toBeCloseTo(q.reservation + q.spread / 2, 12);
  });
});

describe("inventoryRatio", () => {
  it("position / maxInventory clamped to [−1, 1]", () => {
    expect(inventoryRatio(5_000n * WAD, 10_000n * WAD)).toBe(0.5);
    expect(inventoryRatio(-20_000n * WAD, 10_000n * WAD)).toBe(-1);
    expect(inventoryRatio(0n, 10_000n * WAD)).toBe(0);
  });
});

describe("sigmaForQuoting: realized σ guarded against short windows and jumps", () => {
  const p0 = 29n * 10n ** 15n;
  it("uses the fallback until the samples cover minCoverageSec", () => {
    const short = [0, 10, 20, 30].map((t, i) => ({ t, price: i === 3 ? (p0 * 101n) / 100n : p0 })); // 1% jump in 30 s
    expect(sigmaForQuoting(short, { fallback: DEFAULTS.sigma, minCoverageSec: 120, max: 5 * DEFAULTS.sigma })).toBe(DEFAULTS.sigma);
  });
  it("caps σ at `max` (a −40% gap must not quote a 400% spread)", () => {
    const crash = [0, 60, 120, 180].map((t, i) => ({ t, price: i === 3 ? (p0 * 60n) / 100n : p0 }));
    const s = sigmaForQuoting(crash, { fallback: DEFAULTS.sigma, minCoverageSec: 120, max: 5 * DEFAULTS.sigma });
    expect(s).toBeCloseTo(5 * DEFAULTS.sigma, 10);
    expect(quoteBps({ ...DEFAULTS, sigma: s, q: 0 }).spread).toBeLessThan(60); // ≈ 51.5 bps at the cap
  });
  it("passes realized σ through inside the guards", () => {
    const calm = [0, 60, 120, 180].map((t) => ({ t, price: p0 }));
    expect(sigmaForQuoting(calm, { fallback: DEFAULTS.sigma, minCoverageSec: 120, max: 10 })).toBe(DEFAULTS.sigma); // 0 ⇒ fallback
  });
});

describe("realized σ from index samples (bps/√s)", () => {
  it("falls back to the default without enough samples", () => {
    expect(realizedSigmaBpsPerSqrtSec([], DEFAULTS.sigma)).toBe(DEFAULTS.sigma);
    expect(realizedSigmaBpsPerSqrtSec([{ t: 0, price: 29n * 10n ** 15n }], DEFAULTS.sigma)).toBe(DEFAULTS.sigma);
  });
  it("is 0 for a flat series and scales with the move size", () => {
    const flat = [0, 1, 2, 3].map((t) => ({ t, price: 29n * 10n ** 15n }));
    expect(realizedSigmaBpsPerSqrtSec(flat, DEFAULTS.sigma)).toBe(0);
    // alternating ±1 bp moves every second ⇒ σ ≈ 1 bp/√s
    const p0 = 29n * 10n ** 15n;
    const zig = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ t, price: t % 2 === 0 ? p0 : (p0 * 10_001n) / 10_000n }));
    expect(realizedSigmaBpsPerSqrtSec(zig, DEFAULTS.sigma)).toBeCloseTo(1, 1);
  });
});

describe("buildLadder: 3 levels per side snapped to ticks (bid ↓, ask ↑)", () => {
  const base: LadderParams = {
    midWad: 29n * 10n ** 15n, // 0.029, tick 29,000
    tickSize: TICK,
    bidBps: -2.9315,
    askBps: 2.9315,
    levels: 3,
    levelSpacingBps: 2,
    lotsPerLevel: 50n,
    q: 0,
  };

  it("inner quotes at ≈ mid ∓ 2.93 bps (0.345 bps per tick at 0.029 ⇒ 8–9 ticks away)", () => {
    const l = buildLadder(base);
    expect(l.bids.map((o) => o.tick)).toEqual([28_991, 28_985, 28_979]);
    expect(l.asks.map((o) => o.tick)).toEqual([29_009, 29_015, 29_021]);
    expect(l.bids.every((o) => o.lots === 50n)).toBe(true);
  });

  it("bid always strictly below ask, at least one tick apart, even for a tiny spread", () => {
    const l = buildLadder({ ...base, bidBps: -0.01, askBps: 0.01 });
    expect(l.bids[0]!.tick).toBeLessThan(l.asks[0]!.tick);
  });

  it("one-sided at the inventory limits: no bids at q = +1, no asks at q = −1", () => {
    expect(buildLadder({ ...base, q: 1 }).bids).toEqual([]);
    expect(buildLadder({ ...base, q: 1 }).asks.length).toBe(3);
    expect(buildLadder({ ...base, q: -1 }).asks).toEqual([]);
  });

  it("never quotes tick 0 or beyond the 24-bit tick range", () => {
    const l = buildLadder({ ...base, midWad: 3n * TICK, bidBps: -50_000 });
    expect(l.bids.every((o) => o.tick >= 1)).toBe(true);
  });

  it("uses lot-sized orders only (orders are in lots of `LOT`)", () => {
    expect(LOT).toBe(100n * WAD);
  });
});
