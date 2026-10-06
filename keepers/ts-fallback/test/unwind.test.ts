import { describe, expect, it } from "vitest";
import { type HeadroomInput, UnwindTracker, liquidationHeadroom, sizeAfterTake, unwindGasLimit, unwindPlan } from "../src/unwind.js";

const W = 10n ** 18n;
const LOT = 100n * W; // 10143 perp lotSizeWad (contracts/script/config/10143.json)
const TICK = 10n ** 12n; // tickSizeWad
const CAP = 25_000n * W; // maxPositionSize
const IMR = W / 5n; // 0.2
const MARK = W / 50n; // 0.02 AUSD / MON

const base: HeadroomInput = {
  keeperSize: 0n,
  keeperEquity: 1_000n * W,
  keeperReserved: 0n,
  targetSize: 5_000n * W,
  markWad: MARK,
  imr: IMR,
  maxPositionSize: CAP,
  lotSize: LOT,
  bufferBps: 200n,
};

/** The contract's check (ClearingHouse.liquidate) evaluated on the keeper after a take of x. */
function contractAccepts(i: HeadroomInput, x: bigint): boolean {
  const s = sizeAfterTake(i.keeperSize, i.targetSize, x);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const increases = s !== 0n && (i.keeperSize === 0n || i.keeperSize > 0n !== s > 0n || abs(s) > abs(i.keeperSize));
  if (increases && abs(s) > i.maxPositionSize) return false;
  const up = (a: bigint, b: bigint) => (a * b + W - 1n) / W; // mulWadUp
  const im = up(up(abs(s), i.markWad), i.imr) + i.keeperReserved;
  return i.keeperEquity >= im;
}

describe("liquidationHeadroom (H-1 sizing)", () => {
  it("takes the whole position when the keeper can absorb it", () => {
    const r = liquidationHeadroom(base);
    expect(r).toEqual({ size: 5_000n * W, limitedBy: "position" });
    expect(contractAccepts(base, r.size)).toBe(true);
  });

  it("is bounded by IM: 1,000 equity at mark 0.02, IMR 0.2 ⇒ ≤ 250,000 MON × 0.98, then the cap binds", () => {
    const i = { ...base, targetSize: 400_000n * W };
    const r = liquidationHeadroom(i);
    expect(r.size).toBe(CAP); // cap 25,000 < IM capacity 245,000
    expect(r.limitedBy).toBe("cap");
    const poor = { ...i, keeperEquity: 50n * W }; // capacity 12,250 MON ⇒ 12,200 in lots
    const p = liquidationHeadroom(poor);
    expect(p).toEqual({ size: 12_200n * W, limitedBy: "margin" });
    expect(contractAccepts(poor, p.size)).toBe(true);
    expect(contractAccepts(poor, p.size + 12n * LOT)).toBe(false); // beyond the buffer the contract would revert
  });

  it("counts the keeper's existing same-direction position against the cap (the P4/P6 demo keeper is long 5,000)", () => {
    const i = { ...base, keeperSize: 24_000n * W, keeperEquity: 10_000n * W, targetSize: 3_000n * W };
    const r = liquidationHeadroom(i);
    expect(r).toEqual({ size: 1_000n * W, limitedBy: "cap" });
    expect(contractAccepts(i, r.size)).toBe(true);
    expect(contractAccepts(i, r.size + LOT)).toBe(false);
  });

  it("headroom 0 at the cap ⇒ no liquidation sent, with a reason to page", () => {
    const r = liquidationHeadroom({ ...base, keeperSize: CAP, keeperEquity: 10_000n * W });
    expect(r.size).toBe(0n);
    expect(r.limitedBy).toBe("no-headroom");
    if (r.limitedBy === "no-headroom") expect(r.reason).toMatch(/position cap/);
  });

  it("headroom 0 without margin (equity ≤ reserved)", () => {
    const r = liquidationHeadroom({ ...base, keeperEquity: 5n * W, keeperReserved: 5n * W });
    expect(r.size).toBe(0n);
    if (r.limitedBy === "no-headroom") expect(r.reason).toMatch(/margin/);
  });

  it("an opposite position is reduced first and can flip up to min(cap, IM)", () => {
    const i = { ...base, keeperSize: -2_000n * W, keeperEquity: 100n * W, targetSize: 50_000n * W };
    // IM capacity 100·0.98/(0.02·0.2) = 24,500 ⇒ x ≤ 2,000 + 24,500
    const r = liquidationHeadroom(i);
    expect(r.size).toBe(26_500n * W);
    expect(contractAccepts(i, r.size)).toBe(true);
    expect(contractAccepts(i, r.size + 6n * LOT)).toBe(false); // past the 2% buffer: flipped 25,100 > IM capacity 25,000
  });

  it("an opposite position over its IM must be reduced by at least the excess", () => {
    // keeper short 30,000 with capacity 25,000 (24,500 after the 2% buffer): a take of 4,000 leaves it under IM
    const i = { ...base, keeperSize: -30_000n * W, keeperEquity: 100n * W, targetSize: 4_000n * W };
    expect(liquidationHeadroom(i).size).toBe(0n);
    expect(contractAccepts(i, 4_000n * W)).toBe(false);
    const j = { ...i, targetSize: 6_000n * W };
    const r = liquidationHeadroom(j);
    expect(r.size).toBe(6_000n * W);
    expect(contractAccepts(j, r.size)).toBe(true);
  });

  it("floors to whole lots (the unwind trades lots only)", () => {
    const r = liquidationHeadroom({ ...base, targetSize: 5_050n * W });
    expect(r.size).toBe(5_000n * W);
    expect(r.size % LOT).toBe(0n);
    expect(liquidationHeadroom({ ...base, targetSize: 50n * W }).size).toBe(0n); // < 1 lot
  });

  it("short targets: the keeper takes a short", () => {
    const i = { ...base, keeperSize: -24_500n * W, keeperEquity: 10_000n * W, targetSize: -1_000n * W };
    const r = liquidationHeadroom(i);
    expect(r.size).toBe(500n * W);
    expect(sizeAfterTake(i.keeperSize, i.targetSize, r.size)).toBe(-CAP);
  });

  it("never exceeds the cap or IM (property over a grid)", () => {
    const sizes = [-30_000n, -24_000n, -5_000n, -100n, 0n, 100n, 5_000n, 24_900n, 25_000n].map((x) => x * W);
    const targets = [-60_000n, -5_000n, -100n, 100n, 5_000n, 60_000n].map((x) => x * W);
    const equities = [0n, 1n, 40n, 500n, 50_000n].map((x) => x * W);
    const marks = [W / 100n, W / 50n, W / 10n];
    let checked = 0;
    for (const keeperSize of sizes)
      for (const targetSize of targets)
        for (const keeperEquity of equities)
          for (const markWad of marks) {
            const i = { ...base, keeperSize, targetSize, keeperEquity, markWad };
            const r = liquidationHeadroom(i);
            expect(r.size % LOT).toBe(0n);
            expect(r.size <= (targetSize < 0n ? -targetSize : targetSize)).toBe(true);
            if (r.size > 0n) {
              expect(contractAccepts(i, r.size)).toBe(true);
              checked++;
            }
          }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("unwindPlan (H-1 reduce-only IOC)", () => {
  const u = { keeperSize: 5_000n * W, lotSize: LOT, tickSize: TICK, indexOk: true, indexWad: MARK, maxSlippageBps: 100n };

  it("flat ⇒ nothing", () => {
    expect(unwindPlan({ ...u, keeperSize: 0n })).toEqual({ kind: "none" });
  });

  it("long ⇒ sell all lots, limit = index − 1% rounded up to a tick", () => {
    // 0.02 × 0.99 = 0.0198 = 19,800 ticks of 1e-6
    expect(unwindPlan(u)).toEqual({ kind: "order", isBid: false, lots: 50n, limitTick: 19_800n });
    const odd = unwindPlan({ ...u, indexWad: 20_000_123_456_789_012n }); // 0.020000123… × 0.99 = 0.0198001222… ⇒ tick 19,801
    expect(odd).toMatchObject({ isBid: false, limitTick: 19_801n });
  });

  it("short ⇒ buy back, limit = index + 1% rounded down to a tick", () => {
    expect(unwindPlan({ ...u, keeperSize: -300n * W })).toEqual({ kind: "order", isBid: true, lots: 3n, limitTick: 20_200n });
    const odd = unwindPlan({ ...u, keeperSize: -300n * W, indexWad: 20_000_999_999_999_999n }); // × 1.01 = 0.0202010099… ⇒ 20,201
    expect(odd).toMatchObject({ isBid: true, limitTick: 20_201n });
  });

  it("stale oracle ⇒ wait (never unwind into a stale price)", () => {
    expect(unwindPlan({ ...u, indexOk: false })).toEqual({ kind: "wait", reason: "stale-oracle" });
    expect(unwindPlan({ ...u, indexWad: 0n })).toEqual({ kind: "wait", reason: "stale-oracle" });
  });

  it("dust below one lot ⇒ wait, no tx", () => {
    expect(unwindPlan({ ...u, keeperSize: 99n * W })).toEqual({ kind: "wait", reason: "dust" });
  });

  it("partial fill: the next plan covers what is left", () => {
    const first = unwindPlan(u);
    expect(first).toMatchObject({ lots: 50n });
    const after = unwindPlan({ ...u, keeperSize: 5_000n * W - 20n * LOT }); // 20 of 50 lots filled
    expect(after).toMatchObject({ kind: "order", isBid: false, lots: 30n });
  });

  it("gas limit = ⌈estimate × 1.2⌉ + touch allowance", () => {
    expect(unwindGasLimit(100_000n, 70_000n)).toBe(190_000n);
    expect(unwindGasLimit(21_001n, 0n)).toBe(25_202n);
  });
});

describe("UnwindTracker (retry + paging)", () => {
  const rule = { maxFailures: 3, maxHoldBlocks: 200n };

  it("pages after 3 consecutive failures, a fill resets the count", () => {
    const t = new UnwindTracker(rule);
    t.observe(10n, 5_000n * W, LOT);
    t.failed();
    t.failed();
    expect(t.page(11n)).toBeNull();
    t.filled(5n); // partial fill = progress
    expect(t.consecutiveFailures).toBe(0);
    t.failed();
    t.filled(0n); // IOC filled nothing = failure
    t.failed();
    expect(t.page(12n)).toMatch(/3 consecutive failed unwinds/);
    expect(t.totalFailures).toBe(5);
  });

  it("pages when a position is held > UNWIND_PAGE_AFTER_BLOCKS, including while waiting on a stale oracle", () => {
    const t = new UnwindTracker(rule);
    t.observe(100n, 5_000n * W, LOT);
    t.waiting("stale-oracle");
    t.observe(250n, 5_000n * W, LOT);
    expect(t.page(300n)).toBeNull();
    expect(t.page(301n)).toMatch(/held a position for 201 blocks.*stale-oracle/);
    expect(t.pending).toBe(true);
  });

  it("flat (or dust) clears the hold timer and the failures", () => {
    const t = new UnwindTracker(rule);
    t.observe(100n, 5_000n * W, LOT);
    t.failed();
    t.failed();
    t.failed();
    t.observe(105n, 50n * W, LOT); // dust left
    expect(t.pending).toBe(false);
    expect(t.page(1_000n)).toBeNull();
  });
});
