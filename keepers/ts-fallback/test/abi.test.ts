import { describe, expect, it } from "vitest";
import { type Abi, type AbiEvent, type AbiFunction, toEventSelector, toFunctionSelector } from "viem";
import ch from "@pulse/abis/IClearingHouse.json" with { type: "json" };
import oracle from "@pulse/abis/IOracleAdapter.json" with { type: "json" };
import vault from "@pulse/abis/IPulseVault.json" with { type: "json" };
import swap from "@pulse/abis/IFundingSwapMarket.json" with { type: "json" };
import insurance from "@pulse/abis/IInsuranceFund.json" with { type: "json" };
import swapImpl from "@pulse/abis/FundingSwapMarket.json" with { type: "json" };
import { clearingHouseAbi, fundingSwapAbi, fundingSwapImplAbi, insuranceFundAbi, oracleAdapterAbi, pulseVaultAbi } from "../src/abi.js";

// Every fragment the keeper uses must exist, with the same selector, in the committed frozen-interface ABI.
function selectors(abi: Abi): Set<string> {
  const out = new Set<string>();
  for (const x of abi) {
    if (x.type === "function") out.add(toFunctionSelector(x as AbiFunction));
    if (x.type === "event") out.add(toEventSelector(x as AbiEvent));
  }
  return out;
}

describe("keeper ABI fragments match abis/*.json", () => {
  it.each([
    ["IClearingHouse", clearingHouseAbi, ch as Abi],
    ["IOracleAdapter", oracleAdapterAbi, oracle as Abi],
    ["IPulseVault", pulseVaultAbi, vault as Abi],
    ["IFundingSwapMarket", fundingSwapAbi, swap as Abi],
    ["FundingSwapMarket", fundingSwapImplAbi, swapImpl as Abi],
    ["IInsuranceFund", insuranceFundAbi, insurance as Abi],
  ] as const)("%s", (_, mine, frozen) => {
    const want = selectors(frozen);
    const have = [...selectors(mine as Abi)];
    expect(have.length).toBeGreaterThan(0);
    for (const s of have) expect(want.has(s), s).toBe(true);
  });
});
