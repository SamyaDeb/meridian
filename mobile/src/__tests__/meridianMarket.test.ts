import type { PublicClient } from "viem";
import { MeridianMarketReader } from "../live/meridianMarket";

const WAD = 10n ** 18n;
const CH = "0x1F90B5Eb6D59adAe2be147b3903c7aCb4c16a6eA" as const; // deployments/10143.json
const OB = "0xCFB0169FF1957C347285Bb10Ab83E33F3C2bb207" as const;

function fakeClient(depth: { bids: [number[], bigint[]]; asks: [number[], bigint[]] }) {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const client = {
    multicall: async ({ contracts, allowFailure }: { contracts: { functionName: string }[]; allowFailure: boolean }) => {
      calls.push(contracts.map((c) => c.functionName).join(","));
      if (!allowFailure) return [{ blockTimeMs: 400n }, 10n ** 15n, 10n ** 16n]; // fundingParams, tickSize, lotSize
      await new Promise<void>((r) => (release = r));
      const ok = (result: unknown) => ({ status: "success", result });
      return [ok({ rate: 5n }), ok(2n * WAD), ok(2n * WAD), ok(depth.bids), ok(depth.asks)];
    },
  } as unknown as PublicClient;
  return { client, calls, release: () => release?.() };
}

it("reads once per block, skips while a read is in flight, maps ticks to prices", async () => {
  const f = fakeClient({ bids: [[1999], [3n]], asks: [[2001], [4n]] });
  const r = new MeridianMarketReader({ client: f.client, clearingHouse: CH, orderBook: OB });
  const p = r.onBlock(10n);
  await Promise.resolve();
  await Promise.resolve();
  expect(r.onBlock(11n)).toBeUndefined(); // in flight
  f.release();
  await p;
  const s = r.store.get();
  expect(s).toMatchObject({ atBlock: 10n, rateWad: 5n, paramBlockTimeMs: 400n, tickSizeWad: 10n ** 15n, markWad: 2n * WAD, bookKnown: true });
  expect(s.bestBidWad).toBe(1999n * 10n ** 15n);
  expect(s.bestAskWad).toBe(2001n * 10n ** 15n);
  expect(r.onBlock(10n)).toBeUndefined(); // same block again
  expect(f.calls.filter((c) => c === "fundingParams,tickSize,lotSize")).toHaveLength(1);
});

it("an empty book is known-empty (UI: No liquidity right now), never invented levels", async () => {
  const f = fakeClient({ bids: [[], []], asks: [[], []] });
  const r = new MeridianMarketReader({ client: f.client, clearingHouse: CH, orderBook: OB });
  const p = r.onBlock(1n);
  await new Promise((res) => setTimeout(res, 0));
  f.release();
  await p;
  expect(r.store.get()).toMatchObject({ bookKnown: true, bestBidWad: undefined, bestAskWad: undefined });
});
