import { describe, expect, it } from "vitest";
import { closingIsBid, expiryBlockFor, pctFromTrigger, pnlAtTrigger, triggerFromPct, wouldFire, worstTick } from "./math";
import { PERP_TICK_SIZE_WAD as TICK, WAD } from "@/lib/units";

const P = 27_000n * TICK; // 0.027

describe("trigger price ↔ %", () => {
  it("long stop below, long TP above; short mirrored", () => {
    expect(triggerFromPct("StopMarket", true, P, 500n)).toBe((P * 95n) / 100n);
    expect(triggerFromPct("TakeProfitMarket", true, P, 500n)).toBe((P * 105n) / 100n);
    expect(triggerFromPct("StopMarket", false, P, 500n)).toBe((P * 105n) / 100n);
    expect(triggerFromPct("TakeProfitMarket", false, P, 500n)).toBe((P * 95n) / 100n);
  });
  it("round trip % → price → % within 1 bp (toward zero)", () => {
    for (const bps of [1n, 50n, 500n, 2_500n]) {
      const t = triggerFromPct("StopMarket", true, P, bps);
      const back = pctFromTrigger(P, t);
      expect(-back).toBeLessThanOrEqual(bps);
      expect(-back).toBeGreaterThanOrEqual(bps - 1n);
    }
  });
});

describe("onchain condition (index price)", () => {
  it("long stop fires at or below; long TP at or above", () => {
    expect(wouldFire("StopMarket", true, P, P)).toBe(true);
    expect(wouldFire("StopMarket", true, P + 1n, P)).toBe(false);
    expect(wouldFire("TakeProfitMarket", true, P, P)).toBe(true);
    expect(wouldFire("TakeProfitMarket", true, P - 1n, P)).toBe(false);
  });
  it("short mirrored", () => {
    expect(wouldFire("StopMarket", false, P + 1n, P)).toBe(true);
    expect(wouldFire("TakeProfitMarket", false, P - 1n, P)).toBe(true);
    expect(wouldFire("StopMarket", false, P - 1n, P)).toBe(false);
  });
});

describe("worst price → limitTick", () => {
  it("closing a long (sell) ceils the floor; closing a short (buy) floors the ceiling", () => {
    expect(closingIsBid(5n)).toBe(false);
    expect(closingIsBid(-5n)).toBe(true);
    const sell = worstTick(P, TICK, false, 100n); // 27000 · 0.99 = 26730
    expect(sell).toBe(26_730);
    expect(worstTick(P + 1n, TICK, false, 100n)).toBe(26_731); // remainder ⇒ ceil
    expect(worstTick(P, TICK, true, 100n)).toBe(27_270);
    expect(() => worstTick(10n ** 30n, TICK, true, 0n)).toThrow();
  });
});

describe("expiry / pnl", () => {
  it("expiry rounds blocks up", () => {
    expect(expiryBlockFor(1_000n, 3_600n, 300n)).toBe(1_000n + 12_000n);
    expect(expiryBlockFor(0n, 1n, 300n)).toBe(4n);
  });
  it("pnl at trigger: long loses below entry, short gains below entry", () => {
    expect(pnlAtTrigger(100n * WAD, P, P - TICK * 1_000n, 100n * WAD)).toBe(-(TICK * 1_000n * 100n));
    expect(pnlAtTrigger(-100n * WAD, P, P - TICK * 1_000n, 100n * WAD)).toBe(TICK * 1_000n * 100n);
  });
});
