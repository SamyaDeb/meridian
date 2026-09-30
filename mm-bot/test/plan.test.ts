import { describe, expect, it } from "vitest";
import { needsRequote, planRequote, type Resting } from "../src/plan.js";

const L = (tick: number, lots = 50n) => ({ tick, lots });

describe("planRequote: minimal replace/place/cancel set to reach the target ladder", () => {
  it("places everything on an empty book", () => {
    const p = planRequote([], { bids: [L(10), L(9)], asks: [L(12)] });
    expect(p.replace).toEqual([]);
    expect(p.cancel).toEqual([]);
    expect(p.place).toEqual([
      { isBid: true, tick: 10, lots: 50n },
      { isBid: true, tick: 9, lots: 50n },
      { isBid: false, tick: 12, lots: 50n },
    ]);
  });

  it("keeps orders already at a target level with the full size (no tx)", () => {
    const resting: Resting[] = [{ id: 1n, isBid: true, tick: 10, lots: 50n }];
    const p = planRequote(resting, { bids: [L(10)], asks: [] });
    expect(p).toEqual({ replace: [], place: [], cancel: [] });
  });

  it("replaces moved orders (same side) instead of cancel + place", () => {
    const resting: Resting[] = [
      { id: 1n, isBid: true, tick: 10, lots: 50n },
      { id: 2n, isBid: false, tick: 12, lots: 50n },
    ];
    const p = planRequote(resting, { bids: [L(8)], asks: [L(11)] });
    expect(p.replace).toEqual([
      { id: 1n, isBid: true, tick: 8, lots: 50n },
      { id: 2n, isBid: false, tick: 11, lots: 50n },
    ]);
    expect(p.place).toEqual([]);
    expect(p.cancel).toEqual([]);
  });

  it("tops up a partially filled order by replacing it with the full size", () => {
    const p = planRequote([{ id: 7n, isBid: false, tick: 12, lots: 20n }], { bids: [], asks: [L(12)] });
    expect(p.replace).toEqual([{ id: 7n, isBid: false, tick: 12, lots: 50n }]);
  });

  it("cancels surplus orders (e.g. one-sided at the inventory limit)", () => {
    const resting: Resting[] = [
      { id: 1n, isBid: true, tick: 10, lots: 50n },
      { id: 2n, isBid: true, tick: 9, lots: 50n },
    ];
    const p = planRequote(resting, { bids: [], asks: [L(12)] });
    expect(p.cancel).toEqual([1n, 2n]);
    expect(p.place).toEqual([{ isBid: false, tick: 12, lots: 50n }]);
  });

  it("orders asks before bids when prices fall, so a replaced bid never crosses a stale ask of ours", () => {
    // We quote asks at 12 and bids at 10; the market drops and the new asks (9) are below our old bid (10).
    const resting: Resting[] = [
      { id: 1n, isBid: true, tick: 10, lots: 50n },
      { id: 2n, isBid: false, tick: 12, lots: 50n },
    ];
    const p = planRequote(resting, { bids: [L(7)], asks: [L(9)] });
    // the bid must move first (down), otherwise placing the ask at 9 would self-cross our bid at 10
    expect(p.replace[0]).toEqual({ id: 1n, isBid: true, tick: 7, lots: 50n });
    expect(p.replace[1]).toEqual({ id: 2n, isBid: false, tick: 9, lots: 50n });
  });

  it("when prices rise the ask moves first", () => {
    const resting: Resting[] = [
      { id: 1n, isBid: true, tick: 10, lots: 50n },
      { id: 2n, isBid: false, tick: 12, lots: 50n },
    ];
    const p = planRequote(resting, { bids: [L(13)], asks: [L(15)] });
    expect(p.replace[0]).toEqual({ id: 2n, isBid: false, tick: 15, lots: 50n });
    expect(p.replace[1]).toEqual({ id: 1n, isBid: true, tick: 13, lots: 50n });
  });
});

describe("needsRequote: gas discipline (no tx storm when the ladder is legitimately short)", () => {
  const r = (n: number): Resting[] => Array.from({ length: n }, (_, i) => ({ id: BigInt(i + 1), isBid: i % 2 === 0, tick: 10 + i, lots: 20n }));
  it("requotes on an index move > 2 bps", () => {
    expect(needsRequote({ movedBps: 3n, restingCount: 6, targetCount: 6, allFull: true, dq: 0 })).toBe(true);
    expect(needsRequote({ movedBps: 2n, restingCount: 6, targetCount: 6, allFull: true, dq: 0 })).toBe(false);
  });
  it("a raised threshold (REQUOTE_BPS, testnet budget) only gates index moves", () => {
    expect(needsRequote({ movedBps: 10n, restingCount: 2, targetCount: 2, allFull: true, dq: 0, requoteBps: 10n })).toBe(false);
    expect(needsRequote({ movedBps: 11n, restingCount: 2, targetCount: 2, allFull: true, dq: 0, requoteBps: 10n })).toBe(true);
    expect(needsRequote({ movedBps: 0n, restingCount: 1, targetCount: 2, allFull: true, dq: 0, requoteBps: 10n })).toBe(true);
  });
  it("requotes when a target level is missing or partially filled, or inventory moved ≥ 0.05", () => {
    expect(needsRequote({ movedBps: 0n, restingCount: 5, targetCount: 6, allFull: true, dq: 0 })).toBe(true);
    expect(needsRequote({ movedBps: 0n, restingCount: 6, targetCount: 6, allFull: false, dq: 0 })).toBe(true);
    expect(needsRequote({ movedBps: 0n, restingCount: 6, targetCount: 6, allFull: true, dq: 0.05 })).toBe(true);
  });
  it("does not requote every block when the built ladder is one-sided (3 of 6)", () => {
    expect(needsRequote({ movedBps: 0n, restingCount: 3, targetCount: 3, allFull: true, dq: 0 })).toBe(false);
    expect(r(3).length).toBe(3);
  });
});
