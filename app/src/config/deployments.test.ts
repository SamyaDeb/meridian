import { describe, expect, it } from "vitest";
import dryRun from "../../../deployments/dry-run/10143.json";
import testnet from "../../../deployments/10143.json";
import { type Deployment, DEPLOYMENTS, buildDeployments, isLive, swapMarketFor, swapMarketsFor, swapMarketsOf, withOverride } from "./deployments";

describe("deployments", () => {
  it("leaves a `deployed: false` placeholder out; 10143 is live since the 30 Sep broadcast", () => {
    const placeholder = { chainId: 10143, deployed: false, startBlock: 0, contracts: {} };
    expect(isLive(placeholder as unknown as Deployment)).toBe(false);
    expect(DEPLOYMENTS[10143]?.contracts.ClearingHouse).toBe(testnet.contracts.ClearingHouse);
    expect(DEPLOYMENTS[10143]?.demoMarket?.testMarket).toBe(true);
    expect(DEPLOYMENTS[31337]?.contracts.ClearingHouse).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("accepts the DeployMeridian 10143 shape, demo market labelled as a test market", () => {
    const d = buildDeployments([dryRun as unknown as Deployment])[10143];
    expect(d?.contracts.ClearingHouse).toBe("0x6C58b8bfeA118d1D627112Ab076988733f978304");
    expect(d?.oracleKind).toBe("keeper-fed");
    expect(d?.demoMarket?.symbol).toBe("MON-PERP-DEMO");
    expect(d?.demoMarket?.testMarket).toBe(true);
    expect(d?.demoMarket?.ClearingHouse).not.toBe(d?.contracts.ClearingHouse);
  });
});

describe("withOverride (local rehearsal deployments, build time)", () => {
  const real = { chainId: 10143, mocks: false, startBlock: 1, contracts: { ClearingHouse: "0x1111111111111111111111111111111111111111", OrderBook: "0x2222222222222222222222222222222222222222" } } as Deployment;
  const other = { ...real, chainId: 31337 } as Deployment;
  it("replaces only the override's chain", () => {
    const o = { ...real, contracts: { ...real.contracts, MeridianVault: "0x3333333333333333333333333333333333333333" } };
    const out = withOverride([real, other], JSON.stringify(o));
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.chainId === 10143)?.contracts.MeridianVault).toBe("0x3333333333333333333333333333333333333333");
    expect(out.find((d) => d.chainId === 31337)).toBe(other);
  });
  it("ignores an absent or broken override", () => {
    expect(withOverride([real], undefined)).toEqual([real]);
    expect(withOverride([real], "{not json")).toEqual([real]);
    expect(withOverride([real], JSON.stringify({ foo: 1 }))).toEqual([real]);
  });
});

describe("swap markets (CR-017)", () => {
  it("10143: Meridian funding first, then the Perpl-funding market from swapMarkets[]", () => {
    const m = swapMarketsFor(10143);
    expect(m.map((x) => [x.source, x.symbol])).toEqual([
      ["meridian", "MON-FUNDING"],
      ["perpl", "MON-FUNDING-PERPL"],
    ]);
    expect(swapMarketFor(10143, "perpl")).toMatchObject({
      swapMarket: "0x4e5A8b88e8F09FDf2DC178B4641a25676d181bde",
      swapOrderBook: "0x5D4f03B6Afa525ed580C75878A2F51A35c202334",
      fundingSource: "0xC008aF47fCC651889a1d66f0734da941A55224cC",
      perplPerpId: 64,
    });
    expect(swapMarketFor(10143, "meridian")?.fundingSource).toBe(testnet.contracts.ClearingHouse);
  });
  it("never serves an entry without deployed: true or with an unknown source", () => {
    const d = testnet as unknown as Deployment;
    const e = d.swapMarkets![0]!;
    expect(swapMarketsOf({ ...d, swapMarkets: [{ ...e, deployed: false }] }).map((x) => x.source)).toEqual(["meridian"]);
    expect(swapMarketsOf({ ...d, swapMarkets: [{ ...e, deployed: undefined }] }).map((x) => x.source)).toEqual(["meridian"]);
    expect(swapMarketsOf({ ...d, swapMarkets: [{ ...e, fundingSource: "hl" }] }).map((x) => x.source)).toEqual(["meridian"]);
    expect(swapMarketsOf(undefined)).toEqual([]);
  });
});
