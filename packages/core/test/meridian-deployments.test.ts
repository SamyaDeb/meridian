import { type Abi, type AbiEvent, type AbiFunction, toEventSelector, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { clearingHouseAbi, fullAbis, mockTokenAbi, orderBookAbi, readMeridianDeployment, readPerplDeployment, swapAbi, tryReadMeridianDeployment, tryReadPerplDeployment, vaultAbi } from "../src/meridian";
import { repoJson } from "./helpers";

const selectors = (abi: Abi): Set<string> => {
  const out = new Set<string>();
  for (const i of abi) {
    if (i.type === "function") out.add(toFunctionSelector(i as AbiFunction));
    if (i.type === "event") out.add(toEventSelector(i as AbiEvent));
  }
  return out;
};

describe("ABI fragments match the committed ABIs (ported app/src/lib/abi.test.ts + swapParams)", () => {
  it.each([
    ["ClearingHouse", clearingHouseAbi],
    ["OrderBook", orderBookAbi],
    ["MeridianVault", vaultAbi],
    ["FundingSwapMarket", swapAbi],
    ["MockERC20", mockTokenAbi],
  ] as const)("%s", (name, frag) => {
    const committed = selectors(repoJson<Abi>(`abis/${name}.json`));
    for (const s of selectors(frag as Abi)) expect(committed.has(s), `${name} ${s}`).toBe(true);
  });
  it("the re-exported full ABIs are the committed JSON", () => {
    expect(fullAbis.ClearingHouse).toEqual(repoJson("abis/ClearingHouse.json"));
    expect(fullAbis.OrderBook).toEqual(repoJson("abis/OrderBook.json"));
  });
});

describe("Meridian deployment readers (deployments/<chainId>.json)", () => {
  it("10143: the committed record, addresses checksummed, mocks listed", () => {
    const d = readMeridianDeployment(repoJson("deployments/10143.json"), 10143);
    expect(d.chainId).toBe(10143);
    expect(d.contracts.ClearingHouse).toBe("0x1F90B5Eb6D59adAe2be147b3903c7aCb4c16a6eA");
    expect(d.contracts.OrderBook).toBe("0xCFB0169FF1957C347285Bb10Ab83E33F3C2bb207");
    expect(d.contracts.SwapOrderBook).toBe("0xb7D732a5ac88c159B3CA553c672182D2Be51E6Db");
    expect(d.mockContracts).toContain("AUSD");
    expect(d.startBlock).toBe(68_739_694n);
    expect(d.symbol).toBe("MON-PERP");
  });
  it("31337 (no `deployed` field) reads; a missing 143.json is 'not deployed', and the throwing reader refuses it", () => {
    expect(tryReadMeridianDeployment(repoJson("deployments/31337.json"), 31337).status).toBe("deployed");
    expect(tryReadMeridianDeployment(undefined, 143)).toEqual({ status: "not-deployed", reason: "no deployments/143.json" });
    expect(() => readMeridianDeployment(undefined, 143)).toThrow(/not deployed on chain 143/);
  });
  it("refuses deployed: false, a chain id mismatch and a bad address", () => {
    const base = repoJson<Record<string, unknown>>("deployments/10143.json");
    expect(tryReadMeridianDeployment({ ...base, chainId: 143, deployed: false }, 143)).toMatchObject({ status: "not-deployed" });
    expect(() => readMeridianDeployment({ ...base, chainId: 143, deployed: false }, 143)).toThrow(/deployed: false/);
    expect(() => readMeridianDeployment(base, 143)).toThrow(/chainId 10143 ≠ 143/);
    expect(() => readMeridianDeployment({ ...base, contracts: { ...(base.contracts as object), OrderBook: "0x123" } }, 10143)).toThrow(/OrderBook: expected an address/);
  });
});

describe("Perpl deployment reader (deployments/perpl.json)", () => {
  const perpl = repoJson("deployments/perpl.json");
  it("mainnet 143 and testnet 10143 as recorded; MON market + funding interval from the file", () => {
    const m = readPerplDeployment(perpl, 143);
    expect(m.exchange.toLowerCase()).toBe("0x34b6552d57a35a1d042ccae1951bd1c370112a6f");
    expect(m.collateralToken.toLowerCase()).toBe("0x00000000efe302beaa2b3e6e1b18d08d69a9012a");
    expect(m.collateralDecimals).toBe(6);
    expect(m.monMarketId).toBe(10);
    expect(m.markets[10]).toMatchObject({ name: "MON", symbol: "", priceDecimals: 6, sizeDecimals: 0, fundingIntervalSec: 2580, fundingIntervalBlocks: 8571 });
    expect(m.apiUrl).toBe("https://app.perpl.xyz/api");
    const t = readPerplDeployment(perpl, 10143);
    expect(t.monMarketId).toBe(64);
    expect(t.markets[64]).toMatchObject({ symbol: "MON", priceDecimals: 5, sizeDecimals: 0, fundingIntervalSec: 2580 });
    expect(t.apiUrl).toBe("https://testnet.perpl.xyz/api");
  });
  it("unknown chain ⇒ not deployed; malformed ⇒ throws", () => {
    expect(tryReadPerplDeployment(perpl, 1)).toMatchObject({ status: "not-deployed" });
    expect(() => readPerplDeployment(perpl, 1)).toThrow(/not configured/);
    expect(() => tryReadPerplDeployment({}, 143)).toThrow(/chains/);
  });
});
