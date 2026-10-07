import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, toFunctionSelector, type Abi, type AbiFunction } from "viem";
import { clearingHouseMfiAbi } from "../src/meridian/abi";
import { readMeridianVenue } from "../src/meridian/read";

const CH = "0x4c5fB2762986D15Bb626e15867Fc2385f3a4802f" as const; // deployments/10143.json ClearingHouse
const E18 = 10n ** 18n;

describe("ABI drift", () => {
  it("every function and error matches abis/IClearingHouse.json", () => {
    const committed = JSON.parse(readFileSync(new URL("../../abis/IClearingHouse.json", import.meta.url), "utf8")) as Abi;
    const sel = (f: AbiFunction) => `${toFunctionSelector(f)} ${f.outputs.map((o) => o.type).join(",")}`;
    for (const item of clearingHouseMfiAbi) {
      const twin = committed.find((x) => x.type === item.type && "name" in x && x.name === item.name);
      expect(twin, `${item.type} ${item.name}`).toBeDefined();
      if (item.type === "function") expect(sel(item)).toBe(sel(twin as AbiFunction));
    }
  });
});

const revert = (fn: string, errorName: "OracleStale" | "ObservationTooOld") =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: clearingHouseMfiAbi, data: encodeErrorResult({ abi: clearingHouseMfiAbi, errorName }), functionName: fn }), { abi: clearingHouseMfiAbi, functionName: fn, args: fn === "averageFundingApr" ? [12_000n] : [] });

type Call = { functionName: string; args?: readonly unknown[] };
function fake(over: Partial<Record<string, (c: Call) => unknown>> = {}, head = 1_000_000n) {
  const base: Record<string, (c: Call) => unknown> = {
    latestObservation: () => [5n, 7n, head],
    openInterest: () => [3_150_000n * E18, 3_150_000n * E18],
    markPrice: () => 29_579n * 10n ** 12n,
    averageFundingApr: () => 109_499_999_992_992_000n,
    ...over,
  };
  return {
    getBlockNumber: async () => head,
    readContract: (async (c: Call) => {
      const f = base[c.functionName];
      if (!f) throw new Error(`unexpected ${c.functionName}`);
      return f(c);
    }) as never,
  };
}

describe("readMeridianVenue", () => {
  it("1 h window APR and OI notional = longOI × mark (floor)", async () => {
    const r = await readMeridianVenue(fake(), CH);
    expect(r).toEqual({ ok: true, aprWad: 109_499_999_992_992_000n, windowBlocks: 12_000n, oiNotionalWad: 93_173_850n * 10n ** 15n, markWad: 29_579n * 10n ** 12n, asOfBlock: 1_000_000n, headBlock: 1_000_000n });
  });
  it("young ring buffer: falls back to a shorter window and reports it", async () => {
    const r = await readMeridianVenue(fake({ averageFundingApr: (c) => { if ((c.args?.[0] as bigint) > 2_400n) throw revert("averageFundingApr", "ObservationTooOld"); return 1n; } }), CH);
    expect(r).toMatchObject({ ok: true, aprWad: 1n, windowBlocks: 2_400n });
  });
  it("no checkpoint at all ⇒ stale", async () => {
    const r = await readMeridianVenue(fake({ averageFundingApr: () => { throw revert("averageFundingApr", "ObservationTooOld"); } }), CH);
    expect(r).toMatchObject({ ok: false, status: "stale" });
  });
  it("OracleStale revert ⇒ oracle-stale (excluded)", async () => {
    const r = await readMeridianVenue(fake({ latestObservation: () => { throw revert("latestObservation", "OracleStale"); } }), CH);
    expect(r).toMatchObject({ ok: false, status: "oracle-stale" });
  });
  it("observation lagging the head by > 200 blocks ⇒ stale", async () => {
    const r = await readMeridianVenue(fake({ latestObservation: () => [0n, 0n, 999_000n] }), CH);
    expect(r).toMatchObject({ ok: false, status: "stale" });
  });
  it("RPC down ⇒ unavailable", async () => {
    const r = await readMeridianVenue({ getBlockNumber: async () => { throw new Error("fetch failed"); }, readContract: (async () => 0n) as never }, CH);
    expect(r).toMatchObject({ ok: false, status: "unavailable" });
  });
});

describe("Meridian fees (RiskParams, for /v1/mfi/spread)", () => {
  const rp = { imr: 10n ** 17n, mmr: 5n * 10n ** 16n, takerFee: 5n * 10n ** 14n, makerFee: -(10n ** 14n), liqPenalty: 0n, keeperShare: 0n, maxOpenInterest: 0n, maxPositionSize: 0n };
  it("withFees reads riskParams at the same head", async () => {
    let at: unknown;
    const r = await readMeridianVenue(fake({ riskParams: (c) => { at = (c as { blockNumber?: bigint }).blockNumber; return rp; } }), CH, { withFees: true });
    expect(r).toMatchObject({ ok: true, fees: { takerWad: 5n * 10n ** 14n, makerWad: -(10n ** 14n) } });
    expect(at).toBe(1_000_000n);
  });
  it("a failing fee read never excludes the venue", async () => {
    const r = await readMeridianVenue(fake({ riskParams: () => { throw new Error("rpc"); } }), CH, { withFees: true });
    expect(r.ok).toBe(true);
    expect("fees" in r).toBe(false);
  });
});
