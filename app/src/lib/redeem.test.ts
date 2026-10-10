import { describe, expect, it } from "vitest";
import type { Address } from "@/data/types";
import { estimateRedeemToken, mergeRedeems, queuePosition, redeemActions, redeemStatusFromIndexer, redeemStatusName, withdrawRoute, type RedeemRow } from "./redeem";

const ME = "0x00000000000000000000000000000000000000a1" as Address;
const OTHER = "0x00000000000000000000000000000000000000b2" as Address;
const E18 = 10n ** 18n;

describe("redeem status", () => {
  it("maps the contract enum in order and refuses unknown values", () => {
    expect([0, 1, 2, 3].map(redeemStatusName)).toEqual(["requested", "claimable", "claimed", "cancelled"]);
    expect(() => redeemStatusName(4)).toThrow();
    expect(redeemStatusFromIndexer("Claimable")).toBe("claimable");
    expect(() => redeemStatusFromIndexer("Fulfilled")).toThrow();
  });
});

describe("withdrawRoute", () => {
  it("redeems now when idle covers the shares, requests beyond idle", () => {
    expect(withdrawRoute(0n, 10n, 0n, 0n)).toEqual({ kind: "none" });
    expect(withdrawRoute(10n * E18, 10n * E18, 10_000_000n, 0n)).toEqual({ kind: "redeem" });
    expect(withdrawRoute(10n * E18 + 1n, 10n * E18, 10_000_000n, 0n)).toEqual({ kind: "request" });
    expect(withdrawRoute(100n * E18, 0n, 100_000_000n, 200_000_000n)).toEqual({ kind: "request" });
  });
  it("asks to split above one slice, rounding the suggested size down so it fits", () => {
    const r = withdrawRoute(300n * E18, 0n, 299_850_000n, 100_000_000n);
    expect(r.kind).toBe("split");
    if (r.kind !== "split") return;
    // the suggestion's payout at the same price stays ≤ the cap
    expect((r.maxShares * 299_850_000n) / (300n * E18)).toBeLessThanOrEqual(100_000_000n);
    expect(r.maxShares).toBe((300n * E18 * 100_000_000n) / 299_850_000n);
  });
  it("maxSliceAssets 0 means no known cap", () => {
    expect(withdrawRoute(300n * E18, 0n, 10n ** 12n, 0n)).toEqual({ kind: "request" });
  });
});

describe("estimateRedeemToken", () => {
  it("is previewRedeem's formula at a price: gross down, 5 bps fee up", () => {
    // 100 shares at par (1e18 assets-WAD per share ⇒ 1e6 token each) = 100 AUSD gross, fee 0.05 ⇒ 99.95
    expect(estimateRedeemToken(100n * E18, E18)).toBe(99_950_000n);
    // 1 share-wei at par: gross 0 ⇒ 0 (never negative)
    expect(estimateRedeemToken(1n, E18)).toBe(0n);
    // fee rounds up: gross 1 token unit ⇒ fee 1 ⇒ 0
    expect(estimateRedeemToken(10n ** 12n, E18)).toBe(0n);
  });
  it("never pays more than shares × price", () => {
    for (const [s, p] of [
      [123_456_789_012_345_678_901n, 1_000_123_456_789_012_345n],
      [7n * E18, 999_999_999_999_999_999n],
      [E18 / 3n, 1_234_567_890_123_456_789n],
    ] as const) {
      const exact = (s * p) / E18; // token units × 1e12
      expect(estimateRedeemToken(s, p) * 10n ** 12n).toBeLessThanOrEqual(exact);
    }
  });
});

describe("queuePosition", () => {
  it("counts from the oldest pending id, ignores duplicates", () => {
    expect(queuePosition(7n, [9n, 3n, 7n, 3n])).toBe(2);
    expect(queuePosition(3n, [9n, 3n, 7n])).toBe(1);
    expect(queuePosition(4n, [9n, 3n])).toBeUndefined();
  });
});

describe("mergeRedeems", () => {
  const indexed: RedeemRow[] = [
    { id: 1n, owner: ME, receiver: ME, shares: 5n, status: "requested", requestedBlock: 10n, txHash: "0x01" },
    { id: 2n, owner: ME, receiver: ME, shares: 6n, status: "claimed", assets: 6n, requestedBlock: 11n, claimTxHash: "0x02" },
  ];
  it("lets the chain win on status and assets, keeps indexer-only fields, newest first", () => {
    const rows = mergeRedeems(indexed, [{ id: 1n, owner: ME, receiver: ME, shares: 5n, status: 1, assets: 4n, requestedBlock: 10n }]);
    expect(rows.map((r) => r.id)).toEqual([2n, 1n]);
    expect(rows[1]).toMatchObject({ status: "claimable", assets: 4n, txHash: "0x01" });
    expect(rows[0]).toMatchObject({ status: "claimed", claimTxHash: "0x02" });
  });
  it("adds ids the indexer hasn't seen; no assets on a pending row", () => {
    const rows = mergeRedeems([], [{ id: 9n, owner: ME, receiver: OTHER, shares: 1n, status: 0, assets: 0n, requestedBlock: 99n }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assets).toBeUndefined();
    expect(rows[0]!.receiver).toBe(OTHER);
  });
});

describe("redeemActions", () => {
  const row = (status: RedeemRow["status"], owner = ME): RedeemRow => ({ id: 1n, owner, receiver: owner, shares: 1n, status, requestedBlock: 1n });
  it("cancel only for the owner while pending; claim for anyone once claimable", () => {
    expect(redeemActions(row("requested"), ME)).toEqual({ cancel: true, claim: false });
    expect(redeemActions(row("requested"), OTHER)).toEqual({ cancel: false, claim: false });
    expect(redeemActions(row("requested", ME), ME.toUpperCase().replace("0X", "0x") as Address).cancel).toBe(true);
    expect(redeemActions(row("claimable"), OTHER)).toEqual({ cancel: false, claim: true });
    expect(redeemActions(row("claimed"), ME)).toEqual({ cancel: false, claim: false });
    expect(redeemActions(row("cancelled"), ME)).toEqual({ cancel: false, claim: false });
    expect(redeemActions(row("requested"), undefined).cancel).toBe(false);
  });
});
