import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACTS, renderConfig, renderDeploymentsTs } from "../scripts/gen-config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const abiEvents = (name: string): string[] =>
  (JSON.parse(readFileSync(resolve(ROOT, "abis", `${name}.json`), "utf8")) as { type: string; name: string }[])
    .filter((e) => e.type === "event")
    .map((e) => e.name)
    .sort();

const fake = (chainId: number) => ({
  chainId,
  startBlock: 1234,
  contracts: {
    ClearingHouse: "0x1000000000000000000000000000000000000001",
    OrderBook: "0x1000000000000000000000000000000000000002",
    PulseVault: "0x1000000000000000000000000000000000000003",
  },
});

describe("every interface event is indexed (SCHEMA.md checklist)", () => {
  // Frozen interfaces (contracts/src/interfaces/*.sol) → contract entries in config.
  const cases: [string, string, string[]][] = [
    ["IClearingHouse", "ClearingHouse", []],
    ["IOrderBook", "OrderBook", []],
    ["IOrderBook", "SwapOrderBook", []],
    ["IFundingSwapMarket", "FundingSwapMarket", []],
    ["IPulseVault", "PulseVault", ["Approval"]], // ERC-20 allowance: no product use
    ["IOracleAdapter", "OracleAdapter", []],
    ["IInsuranceFund", "InsuranceFund", []],
    ["IMarketFactory", "MarketFactory", []],
    ["IKuruHedger", "KuruHedger", []],
    ["IPulseKeeperReceiver", "PulseKeeperReceiver", []],
  ];
  it.each(cases)("%s → %s", (abi, name, excluded) => {
    const c = CONTRACTS.find((x: { name: string }) => x.name === name)!;
    expect(c.abi).toBe(abi);
    expect([...c.events].sort()).toEqual(abiEvents(abi).filter((e) => !excluded.includes(e)));
  });

  it("every configured event has a handler", () => {
    const dir = resolve(import.meta.dirname, "../src/handlers");
    const src = readdirSync(dir).map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n");
    for (const c of CONTRACTS) {
      for (const e of c.events) {
        expect(src, `${c.name}.${e}`).toContain(`contract: "${c.name}", event: "${e}"`);
      }
    }
  });

  it("covers every event declared in contracts/src/interfaces/*.sol", () => {
    const dir = resolve(ROOT, "contracts/src/interfaces");
    const declared = readdirSync(dir)
      .filter((f) => f.endsWith(".sol"))
      .flatMap((f) => [...readFileSync(resolve(dir, f), "utf8").matchAll(/^\s*event (\w+)\(/gm)].map((m) => m[1]!));
    const indexed = new Set(CONTRACTS.flatMap((c: { events: string[] }) => c.events));
    expect(declared.filter((e) => !indexed.has(e))).toEqual([]);
  });
});

describe("renderConfig", () => {
  it("testnet and mainnet use HyperSync, not RPC", () => {
    for (const [id, url] of [
      [10143, "https://10143.hypersync.xyz"],
      [143, "https://143.hypersync.xyz"],
    ] as const) {
      const y = renderConfig(id, fake(id));
      expect(y).toContain(`url: ${url}`);
      expect(y).not.toMatch(/\brpc:/);
      expect(y).toContain("start_block: 1234");
    }
  });

  it("local anvil uses RPC (no HyperSync for 31337)", () => {
    const y = renderConfig(31337, fake(31337));
    expect(y).toContain("rpc:");
    expect(y).toContain("${ENVIO_LOCAL_RPC_URL:-http://127.0.0.1:8545}");
    expect(y).not.toContain("hypersync");
  });

  it("takes addresses from the deployment and skips missing keys", () => {
    const y = renderConfig(10143, fake(10143));
    expect(y).toContain('address: "0x1000000000000000000000000000000000000001"');
    expect(y.split("chains:")[1]).not.toContain("FundingSwapMarket");
    expect(y.split("chains:")[0]).toContain("name: FundingSwapMarket"); // still declared for codegen
  });

  it("rejects bad input", () => {
    expect(() => renderConfig(1, fake(1))).toThrow(/unsupported/);
    expect(() => renderConfig(143, fake(10143))).toThrow(/chainId/);
    expect(() => renderConfig(143, { ...fake(143), contracts: { ClearingHouse: "0x12" } })).toThrow(/bad address/);
    expect(() => renderConfig(143, { ...fake(143), contracts: {} })).toThrow(/no indexable/);
  });

  it("10143: refuses the NOT DEPLOYED placeholder, renders the DeployPulse dry-run shape", () => {
    // deployments/10143.json is broadcast now (30 Sep); the placeholder shape DeployPulse overwrites stays tested inline
    const placeholder = { chainId: 10143, deployed: false, startBlock: 0, contracts: {} };
    expect(() => renderConfig(10143, placeholder)).toThrow(/NOT DEPLOYED/);
    const dry = JSON.parse(readFileSync(resolve(ROOT, "deployments/dry-run/10143.json"), "utf8"));
    const y = renderConfig(10143, dry);
    expect(y).toContain("url: https://10143.hypersync.xyz");
    expect(y).toContain(`start_block: ${dry.startBlock}`);
    expect(y).toContain(`address: "${dry.contracts.ClearingHouse}"`);
    expect(y).toContain(`address: "${dry.contracts.MarketFactory}"`); // demo market is registered there, indexed dynamically
    expect(y).not.toContain(dry.demoMarket.ClearingHouse);
  });

  it("committed config.yaml is up to date with deployments/31337.json", () => {
    const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments/31337.json"), "utf8"));
    expect(readFileSync(resolve(import.meta.dirname, "../config.yaml"), "utf8")).toBe(renderConfig(31337, dep));
  });

  it("deployments.gen.ts wiring", () => {
    const ts = renderDeploymentsTs([fake(143), fake(10143)]);
    expect(ts.indexOf("  143:")).toBeLessThan(ts.indexOf("10143:")); // sorted by chainId
    expect(ts).toContain('ClearingHouse: "0x1000000000000000000000000000000000000001"');
  });
});
