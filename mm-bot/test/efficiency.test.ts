// Phase 4 step 1: MM RPC/gas discipline. Pure functions, hand-computed values.
import { describe, expect, it } from "vitest";
import { idsToRefresh, shouldTick, type Resting } from "../src/plan.js";
import { type BatchIo, gasLimitFor, gasLimitsForBatch, sendBatch } from "../src/send.js";

describe("shouldTick (TICK_EVERY_BLOCKS)", () => {
  it("every block by default, every N blocks when throttled", () => {
    expect(shouldTick(10n, -1n, 3n)).toBe(true);
    expect(shouldTick(11n, 10n, 1n)).toBe(true);
    expect(shouldTick(12n, 10n, 3n)).toBe(false);
    expect(shouldTick(13n, 10n, 3n)).toBe(true);
    expect(shouldTick(20n, 10n, 3n)).toBe(true); // missed blocks never stall the MM
  });
});

describe("idsToRefresh: getOrder only for ids a Trade/OrderEvicted log mentioned", () => {
  const r = (id: bigint): Resting => ({ id, isBid: true, tick: 1, lots: 20n });
  const resting = [r(1n), r(2n), r(3n)];
  it("only touched ids between full refreshes", () => {
    expect(idsToRefresh(resting, new Set([2n, 99n]), 1, 20)).toEqual([2n]);
    expect(idsToRefresh(resting, new Set(), 7, 20)).toEqual([]);
  });
  it("every id on the safety-net tick, or when fullEvery ≤ 1", () => {
    expect(idsToRefresh(resting, new Set(), 20, 20)).toEqual([1n, 2n, 3n]);
    expect(idsToRefresh(resting, new Set(), 7, 1)).toEqual([1n, 2n, 3n]);
  });
});

describe("gasLimitsForBatch (per-tx limits; Monad bills the limit)", () => {
  const policy = { conflictBufferGas: 45_000n, touchAllowanceGas: 0n };
  it("independent txs get their own estimate × 1.2", () => {
    const limits = gasLimitsForBatch(
      [
        { estimate: 122_000n, side: "ask" },
        { estimate: 184_000n, side: "bid" },
      ],
      policy,
    );
    expect(limits).toEqual([146_400n, 220_800n]);
  });
  it("a later tx on a side an earlier tx wrote gets the conflict buffer", () => {
    const limits = gasLimitsForBatch(
      [
        { estimate: 150_000n, side: "bid" },
        { estimate: 120_000n, side: "bid" },
        { estimate: 120_000n, side: "ask" },
      ],
      policy,
    );
    expect(limits).toEqual([180_000n, 180_000n, 144_000n]); // (120k + 45k)·1.2 = 198k, capped at the old 180k
  });
  it("never exceeds the Phase 3 rule (uniform estimates: 30 Sep rehearsal, 3 replaces at ≈ 188.8k each)", () => {
    const est = [188_812n, 188_812n, 188_812n];
    const limits = gasLimitsForBatch(est.map((e) => ({ estimate: e, side: "bid" as const })), policy);
    expect(limits).toEqual([226_575n, 226_575n, 226_575n]);
    const mixed = gasLimitsForBatch(
      [
        { estimate: 100_000n, side: "bid" },
        { estimate: 90_000n, side: "bid" },
        { estimate: 200_000n, side: "ask" },
      ],
      policy,
    );
    expect(mixed).toEqual([120_000n, 162_000n, 240_000n]);
    expect(mixed.every((l) => l <= gasLimitFor(200_000n))).toBe(true);
  });
  it("adds the touch allowance to every tx when estimates may miss the first funding touch", () => {
    expect(gasLimitsForBatch([{ estimate: 100_000n, side: null }], { conflictBufferGas: 45_000n, touchAllowanceGas: 60_000n })).toEqual([192_000n]);
  });
  it("Phase 3 rehearsal shape: 6-tx re-quote billed far below 6 × max", () => {
    const est = [122_000n, 150_000n, 184_000n, 122_000n, 150_000n, 276_592n];
    const sides = ["ask", "ask", "ask", "bid", "bid", "bid"] as const;
    const mine = gasLimitsForBatch(est.map((e, i) => ({ estimate: e, side: sides[i]! })), policy);
    const old = 6n * gasLimitFor(276_592n);
    const total = mine.reduce((a, b) => a + b, 0n);
    expect(old).toBe(6n * 331_911n);
    // 146,400 + 234,000 + 274,800 + 146,400 + 234,000 + min(⌈321,592·1.2⌉, 331,911) = 1,367,511 vs 1,991,466: −31%
    expect(total).toBe(1_367_511n);
    expect(total < old).toBe(true);
  });
});

describe("sendBatch with a limits policy", () => {
  it("sends each tx with the policy's limit, in order", async () => {
    const sent: string[] = [];
    let n = 0;
    const io: BatchIo<{ id: string; est: bigint }, string> = {
      estimate: async (t) => t.est,
      send: async (t, gas) => {
        sent.push(`${t.id}:${gas}`);
        return `0x${(n++).toString(16).padStart(2, "0")}` as `0x${string}`;
      },
      wait: async (h) => h,
      limits: (txs, est) => est.map((e, i) => e + BigInt(i)),
    };
    const r = await sendBatch([{ id: "a", est: 100n }, { id: "b", est: 200n }], io);
    expect(sent).toEqual(["a:100", "b:201"]);
    expect(r.gasLimits).toEqual([100n, 201n]);
    expect(r.pipelined).toBe(true);
  });
});
