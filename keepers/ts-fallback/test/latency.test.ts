import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { LiquidationLatency } from "../src/latency.js";

const A = "0x000000000000000000000000000000000000000A" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;

describe("LiquidationLatency (benchmark B7: eligibility block → liquidation block)", () => {
  it("records the first block an account was seen eligible and measures to the liquidation block", () => {
    const l = new LiquidationLatency();
    l.observe(100n, [A]);
    l.observe(101n, [A]); // still eligible: first-seen stays 100
    expect(l.firstSeen(A)).toBe(100n);
    expect(l.liquidated(A, 102n)).toBe(2n);
    expect(l.firstSeen(A)).toBeUndefined(); // cleared after the liquidation
  });

  it("is case-insensitive on addresses", () => {
    const l = new LiquidationLatency();
    l.observe(5n, [A]);
    expect(l.liquidated(A.toLowerCase() as Address, 6n)).toBe(1n);
  });

  it("forgets accounts that recovered before being liquidated", () => {
    const l = new LiquidationLatency();
    l.observe(10n, [A, B]);
    l.observe(11n, [B]); // A recovered
    expect(l.firstSeen(A)).toBeUndefined();
    l.observe(12n, [A, B]);
    expect(l.liquidated(A, 13n)).toBe(1n); // measured from the new episode (12)
    expect(l.liquidated(B, 13n)).toBe(3n);
  });

  it("returns undefined for an account it never saw eligible (someone else's pre-existing eligibility)", () => {
    const l = new LiquidationLatency();
    expect(l.liquidated(A, 7n)).toBeUndefined();
  });

  it("summarises p50 / p95 / max over recorded latencies (nearest-rank)", () => {
    const l = new LiquidationLatency();
    const lat = [1n, 1n, 2n, 1n, 3n, 1n, 2n, 1n, 1n, 4n];
    lat.forEach((d, i) => {
      const acct = `0x${(i + 1).toString(16).padStart(40, "0")}` as Address;
      l.observe(1000n, [acct]);
      l.liquidated(acct, 1000n + d);
    });
    expect(l.summary()).toEqual({ n: 10, p50: 1n, p95: 4n, max: 4n, withinThreeBlocks: 9 });
  });

  it("summary of nothing is empty", () => {
    expect(new LiquidationLatency().summary()).toEqual({ n: 0, p50: 0n, p95: 0n, max: 0n, withinThreeBlocks: 0 });
  });
});
