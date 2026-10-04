import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAINNET_RECORD } from "./mainnet.generated";
import { type Deployment, buildDeployments, deploymentState } from "./deployments";

const RECORD = fileURLToPath(new URL("../../../deployments/143.json", import.meta.url));

describe("mainnet record (deployments/143.json → mainnet.generated.ts)", () => {
  it("generated file matches the deploy record (run `node app/scripts/sync-mainnet.mjs` if this fails)", () => {
    const onDisk = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : null;
    expect(MAINNET_RECORD).toEqual(onDisk);
  });
});

describe("deploymentState", () => {
  const live = { chainId: 10143, mocks: false, startBlock: 1, contracts: { ClearingHouse: "0x1111111111111111111111111111111111111111", OrderBook: "0x2222222222222222222222222222222222222222" } } as Deployment;
  const placeholder143 = { chainId: 143, mocks: false, startBlock: 0, deployed: false, contracts: {} } as Deployment;
  const d = buildDeployments([live, placeholder143]);
  it("live record ⇒ live", () => expect(deploymentState(10143, d)).toBe("live"));
  it("mainnet placeholder or missing ⇒ not-deployed (never silently mock)", () => {
    expect(deploymentState(143, d)).toBe("not-deployed");
    expect(deploymentState(143, {})).toBe("not-deployed");
  });
  it("anvil ⇒ local", () => expect(deploymentState(31337, {})).toBe("local"));
});
