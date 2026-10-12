import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import type { MeridianDataSource } from "../source";
import { blockRanges, createChainSource } from "./source";

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

describe("market(): oracle freshness (the ClearingHouse refuses new risk on a stale index)", () => {
  const CH = "0x00000000000000000000000000000000000000c1" as const;
  const OB = "0x00000000000000000000000000000000000000b1" as const;
  const ORACLE = "0x00000000000000000000000000000000000000a1" as const;
  const fakeClient = (oracle: readonly [boolean, bigint, bigint] | Error) =>
    ({
      getBlockNumber: async () => 100n,
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "previewFundingState":
            return { cumFunding: 0n, cumIndexTime: 0n, emaPremium: 0n, rate: 0n, lastUpdateBlock: 100n };
          case "markPrice":
          case "indexPrice":
            return 10n ** 18n;
          case "openInterest":
            return [0n, 0n];
          case "paused":
            return false;
          case "fundingParams":
            return { blockTimeMs: 400n };
          case "tryGetIndexPrice":
            if (oracle instanceof Error) throw oracle;
            return oracle;
          default:
            throw new Error(`unexpected ${functionName}`);
        }
      },
    }) as unknown as PublicClient;
  const src = (c: PublicClient, oracle?: typeof ORACLE) =>
    createChainSource(c, { chainId: 10143, clearingHouse: CH, orderBook: OB, ...(oracle ? { oracle } : {}) }, {} as MeridianDataSource);

  it("flags a stale oracle and keeps its last update time", async () => {
    const m = await src(fakeClient([false, 10n ** 18n, 1_700_000_000n]), ORACLE).market();
    expect(m.oracleStale).toBe(true);
    expect(m.oracleUpdatedAt).toBe(1_700_000_000n);
  });
  it("a fresh oracle is not stale", async () => {
    expect((await src(fakeClient([true, 10n ** 18n, 1n]), ORACLE).market()).oracleStale).toBe(false);
  });
  it("a failed read or no oracle address leaves it unknown, never stale", async () => {
    expect((await src(fakeClient(new Error("rpc")), ORACLE).market()).oracleStale).toBeUndefined();
    expect((await src(fakeClient([false, 0n, 0n])).market()).oracleStale).toBeUndefined();
  });
});
