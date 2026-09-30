// Phase 4 step 2: funding-swap keeper duties (pure decisions).
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { type SwapSnapshot, shouldSettleMaturity, swapAccountIsInert, swapAccountsToCheck, swapIsHot, swapLiquidationCandidates } from "../src/swap.js";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const C = "0x000000000000000000000000000000000000000c" as Address;
const K = "0x00000000000000000000000000000000000000ff" as Address;
const W = 10n ** 18n;
const snap = (account: Address, o: Partial<SwapSnapshot>): SwapSnapshot => ({
  account,
  size: 1_000n * W,
  unrealizedPnl: 0n,
  equity: 100n * W,
  maintenanceMargin: 50n * W,
  liquidatable: false,
  ...o,
});

describe("swapLiquidationCandidates", () => {
  it("eligible only, most under water first, capped, never the keeper", () => {
    const got = swapLiquidationCandidates(
      [
        snap(A, { liquidatable: true, equity: 40n * W }), // short 10
        snap(B, { liquidatable: true, equity: 10n * W }), // short 40
        snap(C, {}),
        snap(K, { liquidatable: true, equity: 0n }),
      ],
      5,
      K,
    );
    expect(got.map((s) => s.account)).toEqual([B, A]);
    expect(swapLiquidationCandidates([snap(A, { liquidatable: true }), snap(B, { liquidatable: true })], 1).length).toBe(1);
  });
  it("a flat account with a losing locked-spread stream is still a candidate (MATH_SPEC §6.4)", () => {
    const flat = snap(A, { size: 0n, unrealizedPnl: -5n * W, equity: -1n * W, maintenanceMargin: 2n * W, liquidatable: true });
    expect(swapLiquidationCandidates([flat], 5).map((s) => s.account)).toEqual([A]);
  });
});

describe("swapAccountIsInert: when the keeper stops tracking an account", () => {
  it("size 0 alone is not enough (K ≠ 0 keeps a stream)", () => {
    expect(swapAccountIsInert({ size: 0n, unrealizedPnl: 47n * W, maintenanceMargin: 1n })).toBe(false);
    expect(swapAccountIsInert({ size: 1n, unrealizedPnl: 0n, maintenanceMargin: 0n })).toBe(false);
    expect(swapAccountIsInert({ size: 0n, unrealizedPnl: 0n, maintenanceMargin: 0n })).toBe(true);
  });
});

describe("swapAccountsToCheck", () => {
  const base = { block: 105n, tracked: new Set([A, B, C]), changed: new Set<Address>(), hot: new Set<Address>(), lastFullBlock: 100n, fullEvery: 10n };
  it("changed and hot accounts every block, everyone every N blocks", () => {
    expect(swapAccountsToCheck(base)).toEqual({ accounts: [], full: false });
    expect(swapAccountsToCheck({ ...base, changed: new Set([A]), hot: new Set([C]) }).accounts).toEqual([A, C]);
    expect(swapAccountsToCheck({ ...base, block: 110n })).toEqual({ accounts: [A, B, C], full: true });
    expect(swapAccountsToCheck({ ...base, lastFullBlock: -1n }).full).toBe(true);
  });
  it("swapIsHot: eligible or equity < 2·MM", () => {
    expect(swapIsHot({ liquidatable: true, equity: 100n, maintenanceMargin: 1n })).toBe(true);
    expect(swapIsHot({ liquidatable: false, equity: 99n, maintenanceMargin: 50n })).toBe(true);
    expect(swapIsHot({ liquidatable: false, equity: 100n, maintenanceMargin: 50n })).toBe(false);
    expect(swapIsHot({ liquidatable: false, equity: -1n, maintenanceMargin: 0n })).toBe(false);
  });
});

describe("shouldSettleMaturity: exactly once", () => {
  const i = { nowSec: 1_000n, maturity: 1_000n, snapped: false, pending: false };
  it("fires at/after maturity with no snapshot and none of ours in flight", () => {
    expect(shouldSettleMaturity(i)).toBe(true);
    expect(shouldSettleMaturity({ ...i, nowSec: 999n })).toBe(false);
    expect(shouldSettleMaturity({ ...i, snapped: true })).toBe(false); // lazily snapped by a trade, or ours landed
    expect(shouldSettleMaturity({ ...i, pending: true })).toBe(false);
  });
});
