import { describe, expect, it } from "vitest";
import { blockRanges } from "./source";

describe("blockRanges (eth_getLogs caps: public Monad RPC 100 blocks, Alchemy free tier 10)", () => {
  it("covers [from, to] exactly in inclusive chunks of at most `span`", () => {
    expect(blockRanges(0n, 24n, 10n)).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 24n],
    ]);
    expect(blockRanges(5n, 5n, 100n)).toEqual([[5n, 5n]]);
    expect(blockRanges(6n, 5n, 100n)).toEqual([]);
  });
  it("a span larger than the range is one request (anvil default)", () => {
    expect(blockRanges(100n, 2_100n, 2_001n)).toEqual([[100n, 2_100n]]);
  });
  it("rejects a non-positive span", () => {
    expect(() => blockRanges(0n, 1n, 0n)).toThrow(/span/);
  });
});
