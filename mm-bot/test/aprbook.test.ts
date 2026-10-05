// Phase 4 step 3: swap-book quoting on the APR axis. Hand-computed values.
import { describe, expect, it } from "vitest";
import { quoteBps } from "../src/as.js";
import {
  aprBpsToTick,
  aprSigma,
  aprWadToBps,
  blocksFor,
  buildAprLadder,
  chooseAnchor,
  movedAprBps,
  rateToAprWad,
  tickToAprWad,
} from "../src/aprbook.js";

const TICK = 10n ** 14n; // 1 bp APR (WS-05 deploy wiring)

describe("APR ↔ tick (price = 1 + APR, tick 1e14 = 1 bp)", () => {
  it("12% ↔ tick 11,200 exactly, both ways", () => {
    expect(aprWadToBps(120_000_000_000_000_000n)).toBe(1200);
    expect(aprBpsToTick(1200, TICK, "bid")).toBe(11_200);
    expect(aprBpsToTick(1200, TICK, "ask")).toBe(11_200);
    expect(tickToAprWad(11_200, TICK)).toBe(120_000_000_000_000_000n);
  });
  it("off-grid APRs snap bid ↓ / ask ↑", () => {
    expect(aprBpsToTick(1200.5, TICK, "bid")).toBe(11_200);
    expect(aprBpsToTick(1200.5, TICK, "ask")).toBe(11_201);
  });
  it("negative APR: −0.5228% ⇒ price 0.994772", () => {
    expect(aprBpsToTick(-52.28, TICK, "bid")).toBe(9_947);
    expect(aprBpsToTick(-52.28, TICK, "ask")).toBe(9_948);
    expect(tickToAprWad(9_947, TICK)).toBe(-53n * 10n ** 14n);
  });
  it("APR ≤ −100% has no valid price", () => {
    expect(aprBpsToTick(-10_000, TICK, "bid")).toBe(0);
  });
});

describe("anchor choice", () => {
  it("realized 8 h APR when the perp has the history", () => {
    expect(chooseAnchor(150_000_000_000_000_000n, 3_472_222_222n)).toEqual({ aprWad: 150_000_000_000_000_000n, source: "realized-8h" });
  });
  it("else the perp's current rate as APR: the interest floor 3,472,222,222/s ⇒ 10.95% (MATH_SPEC §1.3)", () => {
    const a = chooseAnchor(null, 3_472_222_222n);
    expect(a.source).toBe("perp-rate");
    expect(a.aprWad).toBe(109_499_999_992_992_000n); // 3,472,222,222 · 31,536,000
    expect(rateToAprWad(-1n)).toBe(-31_536_000n);
    expect(Math.round(aprWadToBps(a.aprWad) * 1e4) / 1e4).toBe(1095);
  });
  it("blocksFor: 8 h at 300 ms = 96,000 blocks", () => {
    expect(blocksFor(28_800, 300n)).toBe(96_000n);
  });
  it("movedAprBps floors |Δ| to whole APR bps", () => {
    expect(movedAprBps(120_000_000_000_000_000n, 120_300_000_000_000_000n)).toBe(3n);
    expect(movedAprBps(120_000_000_000_000_000n, 120_009_000_000_000_000n)).toBe(0n);
  });
});

describe("aprSigma (absolute APR changes, bps/√s)", () => {
  const g = { fallback: 1, minCoverageSec: 10, max: 50 };
  it("√(Σ Δ² / Σ Δt): 1200 → 1203 → 1199 over 20 s ⇒ √(25/20) = 1.1180", () => {
    const s = aprSigma(
      [
        { t: 0, aprBps: 1200 },
        { t: 10, aprBps: 1203 },
        { t: 20, aprBps: 1199 },
      ],
      g,
    );
    expect(s).toBeCloseTo(1.118_034, 5);
  });
  it("fallback on thin, short or flat history; capped", () => {
    expect(aprSigma([{ t: 0, aprBps: 1 }], g)).toBe(1);
    expect(aprSigma([0, 1, 2].map((t) => ({ t, aprBps: t * 100 })), g)).toBe(1); // 2 s < 10 s coverage
    expect(aprSigma([0, 10, 20].map((t) => ({ t, aprBps: 1200 })), g)).toBe(1);
    expect(aprSigma([0, 10, 20].map((t, i) => ({ t, aprBps: i * 10_000 })), g)).toBe(50);
  });
});

describe("buildAprLadder (A–S on the APR axis, MATH_SPEC §4)", () => {
  // σ = 1 bp/√s, γ 0.01, k 0.5, T−t 60: γσ²T = 0.6, (2/γ)ln(1.02) = 3.9605 ⇒ δ = 4.5605 APR bps
  const q0 = quoteBps({ sigma: 1, gamma: 0.01, k: 0.5, horizonSec: 60, q: 0 });
  it("two-sided around 12%: bid 1197.72 → 11,197 ↓, ask 1202.28 → 11,203 ↑, 5 bps apart", () => {
    expect(q0.spread).toBeCloseTo(4.5605, 4);
    const l = buildAprLadder({ anchorAprBps: 1200, tickSize: TICK, bidBps: q0.bidBps, askBps: q0.askBps, levels: 2, levelSpacingBps: 5, lotsPerLevel: 3n, q: 0 });
    expect(l.bids).toEqual([
      { tick: 11_197, lots: 3n },
      { tick: 11_192, lots: 3n },
    ]);
    expect(l.asks).toEqual([
      { tick: 11_203, lots: 3n },
      { tick: 11_208, lots: 3n },
    ]);
  });
  it("inventory skew: long q = 0.5 shifts the reservation −0.3 bps (bid 1197.42 → 11,197, ask 1201.98 → 11,202)", () => {
    const q = quoteBps({ sigma: 1, gamma: 0.01, k: 0.5, horizonSec: 60, q: 0.5 });
    expect(q.reservation).toBeCloseTo(-0.3, 10);
    const l = buildAprLadder({ anchorAprBps: 1200, tickSize: TICK, bidBps: q.bidBps, askBps: q.askBps, levels: 1, levelSpacingBps: 5, lotsPerLevel: 1n, q: 0.5 });
    expect([l.bids[0]!.tick, l.asks[0]!.tick]).toEqual([11_197, 11_202]);
  });
  it("one-sided at the inventory limits", () => {
    const base = { anchorAprBps: 1200, tickSize: TICK, bidBps: -2, askBps: 2, levels: 2, levelSpacingBps: 5, lotsPerLevel: 1n };
    expect(buildAprLadder({ ...base, q: 1 }).bids).toEqual([]);
    expect(buildAprLadder({ ...base, q: -1 }).asks).toEqual([]);
  });
  it("never emits a tick < 1 when the anchor is at or below −100% APR (price = 1 + APR ≤ 0)", () => {
    // P3/P4 mainnet fork, 5 Oct: no 8 h history ⇒ anchor = perp rate × YEAR = −113.5% APR; the ask side used to emit
    // tick 0 and every requote reverted InvalidTick() (0xce8ef7fc) on the OrderBook (tick == 0 is invalid).
    const base = { tickSize: TICK, bidBps: -2, askBps: 2, levels: 3, levelSpacingBps: 5, lotsPerLevel: 1n, q: 0 };
    for (const anchorAprBps of [-11_350, -10_000, -10_004]) {
      const l = buildAprLadder({ ...base, anchorAprBps });
      for (const lv of [...l.bids, ...l.asks]) expect(lv.tick).toBeGreaterThanOrEqual(1);
    }
    // just above −100% (−99.95%): price = 1 + APR > 0 for the asks (−99.93/−99.88/−99.83% ⇒ ticks 7/12/17) and the
    // inner bid (−99.97% ⇒ tick 3); the outer bids would price ≤ 0 and are dropped
    const near = buildAprLadder({ ...base, anchorAprBps: -9_995 });
    expect(near.asks.map((a) => a.tick)).toEqual([7, 12, 17]);
    expect(near.bids.map((b) => b.tick)).toEqual([3]);
  });
  it("inner bid < inner ask even when the spread is under one tick", () => {
    const l = buildAprLadder({ anchorAprBps: 1200, tickSize: TICK, bidBps: -0.1, askBps: 0.1, levels: 1, levelSpacingBps: 5, lotsPerLevel: 1n, q: 0 });
    expect(l.bids[0]!.tick).toBe(11_199);
    expect(l.asks[0]!.tick).toBe(11_201);
  });
});
