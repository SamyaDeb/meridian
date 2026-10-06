import { describe, expect, it } from "vitest";
import { type Abi, type AbiEvent, type AbiFunction, toEventSelector, toFunctionSelector } from "viem";
import ch from "@meridian/abis/IClearingHouse.json" with { type: "json" };
import oracle from "@meridian/abis/IOracleAdapter.json" with { type: "json" };
import vault from "@meridian/abis/IMeridianVault.json" with { type: "json" };
import swap from "@meridian/abis/IFundingSwapMarket.json" with { type: "json" };
import insurance from "@meridian/abis/IInsuranceFund.json" with { type: "json" };
import swapImpl from "@meridian/abis/FundingSwapMarket.json" with { type: "json" };
import hedger from "@meridian/abis/IKuruHedger.json" with { type: "json" };
import ob from "@meridian/abis/IOrderBook.json" with { type: "json" };
import agg from "@meridian/abis/AggregatorV3Interface.json" with { type: "json" };
import {
  aggregatorAbi,
  clearingHouseAbi,
  fundingSwapAbi,
  fundingSwapImplAbi,
  fundingSwapWatchAbi,
  insuranceFundAbi,
  kuruHedgerAbi,
  oracleAdapterAbi,
  orderBookWatchAbi,
  meridianVaultAbi,
} from "../src/abi.js";

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
    ["IMeridianVault", meridianVaultAbi, vault as Abi],
    ["IFundingSwapMarket", fundingSwapAbi, swap as Abi],
    ["FundingSwapMarket", fundingSwapImplAbi, swapImpl as Abi],
    ["IInsuranceFund", insuranceFundAbi, insurance as Abi],
    ["IKuruHedger", kuruHedgerAbi, hedger as Abi],
    ["IOrderBook", orderBookWatchAbi, ob as Abi],
    ["IFundingSwapMarket (watch)", fundingSwapWatchAbi, swap as Abi],
    ["AggregatorV3Interface", aggregatorAbi, agg as Abi],
  ] as const)("%s", (_, mine, frozen) => {
    const want = selectors(frozen);
    const have = [...selectors(mine as Abi)];
    expect(have.length).toBeGreaterThan(0);
    for (const s of have) expect(want.has(s), s).toBe(true);
  });
});
