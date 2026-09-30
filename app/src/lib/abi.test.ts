import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Abi, type AbiEvent, type AbiFunction, toEventSelector, toFunctionSelector } from "viem";
import { clearingHouseAbi, orderBookAbi, swapAbi, vaultAbi } from "./abi";

const selectors = (abi: Abi): Set<string> => {
  const out = new Set<string>();
  for (const i of abi) {
    if (i.type === "function") out.add(toFunctionSelector(i as AbiFunction));
    if (i.type === "event") out.add(toEventSelector(i as AbiEvent));
  }
  return out;
};
const load = (n: string): Abi => JSON.parse(readFileSync(new URL(`../../../abis/${n}.json`, import.meta.url), "utf8")) as Abi;

describe("app ABI fragments match the committed ABIs", () => {
  it.each([
    ["ClearingHouse", clearingHouseAbi],
    ["OrderBook", orderBookAbi],
    ["PulseVault", vaultAbi],
    ["FundingSwapMarket", swapAbi],
  ] as const)("%s", (name, frag) => {
    const committed = selectors(load(name));
    for (const s of selectors(frag as Abi)) expect(committed.has(s), `${name} ${s}`).toBe(true);
  });
});
