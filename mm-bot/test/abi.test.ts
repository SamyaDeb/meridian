import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Abi, toFunctionSelector, toEventSelector, type AbiFunction, type AbiEvent } from "viem";
import { clearingHouseAbi, fundingSwapAbi, oracleAdapterAbi, orderBookAbi } from "../src/abi.js";

const load = (name: string): Abi =>
  JSON.parse(readFileSync(new URL(`../../abis/${name}.json`, import.meta.url), "utf8")) as Abi;

function selectors(abi: Abi): Set<string> {
  const out = new Set<string>();
  for (const item of abi) {
    if (item.type === "function") out.add(toFunctionSelector(item as AbiFunction));
    if (item.type === "event") out.add(toEventSelector(item as AbiEvent));
  }
  return out;
}

describe("ABI fragments match the committed interfaces", () => {
  it.each([
    ["IOrderBook", orderBookAbi],
    ["IClearingHouse", clearingHouseAbi],
    ["IOracleAdapter", oracleAdapterAbi],
    ["IFundingSwapMarket", fundingSwapAbi],
  ] as const)("%s", (name, fragment) => {
    const committed = selectors(load(name));
    for (const s of selectors(fragment as Abi)) expect(committed.has(s), `${name}: ${s}`).toBe(true);
  });
});
