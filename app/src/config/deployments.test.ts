import { describe, expect, it } from "vitest";
import dryRun from "../../../deployments/dry-run/10143.json";
import testnet from "../../../deployments/10143.json";
import { type Deployment, DEPLOYMENTS, buildDeployments, isLive, withOverride } from "./deployments";

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
