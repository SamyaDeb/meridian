import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  ABI_FILES,
  CONTRACTS,
  PERPL_CONTRACT,
  PERPL_PROFILES,
  HOSTED_EXTRA_CHAINS,
  readPerpl,
  renderConfig,
  renderDeploymentsTs,
  renderHostedConfig,
  renderPerplTs,
} from "../scripts/gen-config.mjs";
import { findMon, snapshotFromContext } from "../scripts/seed-perpl.mjs";

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
    MeridianVault: "0x1000000000000000000000000000000000000003",
  },
});

describe("every interface event is indexed (SCHEMA.md checklist)", () => {
  // Frozen interfaces (contracts/src/interfaces/*.sol) → contract entries in config.
  const cases: [string, string, string[]][] = [
    ["IClearingHouse", "ClearingHouse", []],
    ["IOrderBook", "OrderBook", []],
    ["IOrderBook", "SwapOrderBook", []],
    ["IFundingSwapMarket", "FundingSwapMarket", []],
    ["IMeridianVault", "MeridianVault", ["Approval"]], // ERC-20 allowance: no product use
    ["IOracleAdapter", "OracleAdapter", []],
    ["IInsuranceFund", "InsuranceFund", []],
    ["IMarketFactory", "MarketFactory", []],
    ["IKuruHedger", "KuruHedger", []],
    ["IMeridianKeeperReceiver", "MeridianKeeperReceiver", []],
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

  it("10143: refuses the NOT DEPLOYED placeholder, renders the DeployMeridian dry-run shape", () => {
    // deployments/10143.json is broadcast now (30 Sep); the placeholder shape DeployMeridian overwrites stays tested inline
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

  it("committed testnet configs and deployments.gen.ts are up to date with deployments/10143.json", () => {
    const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments/10143.json"), "utf8"));
    const y = readFileSync(resolve(import.meta.dirname, "../config.testnet.yaml"), "utf8");
    expect(y).toBe(renderConfig(10143, dep, readPerpl()));
    for (const k of ["ClearingHouse", "OrderBook", "OracleAdapter", "MeridianVault", "FundingSwapMarket", "SwapOrderBook"]) {
      // the P4 relaunch ships no vault (vault v2 joins in P6): gen-config emits no address for an absent key
      if (dep.contracts[k] === undefined) continue;
      expect(y, k).toContain(`address: "${dep.contracts[k]}"`);
    }
    expect(y).not.toContain('address: "undefined"');
    // The MM, demo MM and the house taker flow are operators: never external users (chart-liquidity prompt, task 2).
    const gen = readFileSync(resolve(import.meta.dirname, "../src/deployments.gen.ts"), "utf8");
    const ops = gen.split("OPERATOR_ACCOUNTS")[1]!.split("10143:")[1]!.split("\n")[0]!;
    for (const a of [...dep.mmAccounts, ...dep.keeperAccounts, dep.owner]) expect(ops, a).toContain(a.toLowerCase());
  });

  it("deployments.gen.ts wiring", () => {
    const ts = renderDeploymentsTs([fake(143), fake(10143)]);
    expect(ts.indexOf("  143:")).toBeLessThan(ts.indexOf("10143:")); // sorted by chainId
    expect(ts).toContain('ClearingHouse: "0x1000000000000000000000000000000000000001"');
  });
});

describe("renderHostedConfig (Envio Cloud, docs/outputs/HOSTED_ENVIO.md)", () => {
  it("references ABIs only inside the indexer dir and otherwise equals the plain config", () => {
    const plain = renderConfig(10143, fake(10143), undefined, [], "lean");
    const hosted = renderHostedConfig(10143, fake(10143));
    expect(hosted).not.toContain("../");
    expect(hosted).toContain("abi_file_path: ./abis/IClearingHouse.json");
    expect(hosted).toContain("url: https://10143.hypersync.xyz");
    const body = (y: string) => y.split("\n").slice(2).join("\n").replaceAll("../abis/", "./abis/");
    expect(body(hosted)).toBe(body(plain));
  });
  it("vendors exactly the ABIs the contracts use", () => {
    const own = CONTRACTS.filter((c: { vendored?: boolean }) => !c.vendored);
    expect(ABI_FILES).toEqual([...new Set(own.map((c: { abi: string }) => `${c.abi}.json`))]);
    expect(ABI_FILES).toHaveLength(new Set(ABI_FILES).size);
    for (const c of CONTRACTS.filter((x: { vendored?: boolean }) => x.vendored)) {
      expect(readFileSync(resolve(import.meta.dirname, `../abis/${c.abi}.json`), "utf8").length).toBeGreaterThan(0);
    }
  });
  it("committed hosted config is up to date (Perpl lean profile, mainnet Perpl as a second chain)", () => {
    const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments/10143.json"), "utf8"));
    const y = readFileSync(resolve(import.meta.dirname, "../config.hosted.testnet.yaml"), "utf8");
    expect(y).toBe(renderHostedConfig(10143, dep, readPerpl(), HOSTED_EXTRA_CHAINS[10143]));
    const perplEvents = y.split("name: PerplExchange")[1]!.split("chains:")[0]!;
    expect(perplEvents.match(/- event: (\w+)/g)!.map((l) => l.split(": ")[1])).toEqual(PERPL_PROFILES.lean);
    expect(y).toContain("  - id: 143");
    expect(y).toContain(`address: "${readPerpl().chains["143"].exchange}"`);
    expect(y).toContain("abi_file_path: ./abis/PerplExchange.json");
    expect(y).toContain(`address: "${readPerpl().chains["10143"].exchange}"`);
    expect(y).not.toContain("../");
  });
});

describe("Perpl (K2.2): address from deployments/perpl.json, verified events only", () => {
  const perpl = readPerpl();
  const perplEvents = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../abis/PerplExchange.json"), "utf8")) as { type: string; name: string }[])
    .filter((e) => e.type === "event")
    .map((e) => e.name);
  const c = CONTRACTS.find((x: { name: string }) => x.name === PERPL_CONTRACT)!;

  it("indexes only events that exist in the vendored ABI and were seen decoding on 10143 (recorded fixtures)", () => {
    for (const e of c.events) expect(perplEvents, e).toContain(e);
    const dir = resolve(import.meta.dirname, "fixtures/perpl-10143");
    const seen: Record<string, number> = {};
    for (const f of readdirSync(dir).filter((x) => x === "summary.json" || x.startsWith("replay-"))) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(resolve(dir, f), "utf8")).counts as Record<string, number>)) seen[k] = (seen[k] ?? 0) + v;
    }
    for (const e of c.events) expect(seen[e] ?? 0, e).toBeGreaterThan(0);
  });

  it("puts the exchange on the same chain and start block as Meridian; never on a chain without an address", () => {
    const y = renderConfig(10143, fake(10143), perpl);
    const chain = y.split("chains:")[1]!;
    expect(chain).toContain(`name: ${PERPL_CONTRACT}`);
    expect(chain).toContain(`address: "${perpl.chains["10143"].exchange}"`);
    expect(chain).toContain("start_block: 1234");
    expect(renderConfig(31337, fake(31337), perpl).split("chains:")[1]).not.toContain(PERPL_CONTRACT);
    expect(renderConfig(10143, fake(10143)).split("chains:")[1]).not.toContain(PERPL_CONTRACT);
  });

  it("profiles: lean keeps funding / liquidations / account ids only; full (tests) keeps every verified event", () => {
    const lean = renderConfig(10143, fake(10143), perpl, [], "lean").split("name: PerplExchange")[1]!.split("  - name:")[0]!;
    const full = renderConfig(10143, fake(10143), perpl).split("name: PerplExchange")[1]!.split("chains:")[0]!;
    for (const e of c.events) expect(full, e).toContain(`- event: ${e}`);
    expect(lean).not.toContain("MarkUpdated");
    expect(lean).not.toContain("PositionIncreasedV2");
    for (const e of PERPL_PROFILES.lean!) expect(c.events).toContain(e);
    expect(() => renderConfig(10143, fake(10143), perpl, [], "everything")).toThrow(/profile/);
  });

  it("multichain: an extra chain indexes only Perpl, with its own start block and HyperSync", () => {
    const y = renderHostedConfig(10143, fake(10143), perpl, [{ id: 143, startBlock: 109_000_000 }]);
    const extra = y.split("  - id: 143")[1]!;
    expect(extra).toContain("start_block: 109000000");
    expect(extra).toContain("url: https://143.hypersync.xyz");
    expect(extra).toContain(`address: "${perpl.chains["143"].exchange}"`);
    expect(extra).not.toContain("ClearingHouse");
    expect(() => renderConfig(10143, fake(10143), perpl, [{ id: 31337, startBlock: 1 }])).toThrow();
    expect(() => renderConfig(10143, fake(10143), perpl, [{ id: 143, startBlock: 0 }])).toThrow(/startBlock/);
  });

  it("perpl.gen.ts is up to date and carries the seeded metadata (MON per chain)", () => {
    const ts = readFileSync(resolve(import.meta.dirname, "../src/perpl.gen.ts"), "utf8");
    expect(ts).toBe(renderPerplTs(perpl));
    expect(ts).toContain("monPerpId: 64");
    expect(ts).toContain("monPerpId: 10");
  });

  it("seed: snapshot from a context response; MON found by symbol, or by name when the symbol is empty", () => {
    const ctx = {
      chain: { chain_id: 143 },
      instances: [{ id: 1, address: "0xAB00000000000000000000000000000000000001", collateral_token_id: 1 }],
      tokens: [{ id: 1, symbol: "AUSD", decimals: 6, address: "0xa" }],
      markets: [
        { id: 10, perpetual_id: 10, instance_id: 1, symbol: "", name: "MON", funding_interval_sec: 2580, funding_interval_blocks: 8571, config: { price_decimals: 6, size_decimals: 0, funding_sum_scaling_exp: 2 } },
        { id: 1, perpetual_id: 1, instance_id: 1, symbol: "BTC", name: "BTC", funding_interval_sec: 2580, funding_interval_blocks: 8571, config: { price_decimals: 1, size_decimals: 5, funding_sum_scaling_exp: 0 } },
      ],
    };
    const snap = snapshotFromContext(ctx, 143, "0xab00000000000000000000000000000000000001");
    expect(snap.collateralDecimals).toBe(6);
    expect(findMon(snap.markets)).toBe(10);
    expect(() => snapshotFromContext(ctx, 10143, "0xab00000000000000000000000000000000000001")).toThrow(/chain/);
    expect(() => snapshotFromContext(ctx, 143, "0x0000000000000000000000000000000000000009")).toThrow(/instance/);
    const bad = structuredClone(ctx);
    bad.markets[0]!.config.price_decimals = 19;
    expect(() => snapshotFromContext(bad, 143, "0xab00000000000000000000000000000000000001")).toThrow(/price_decimals/);
  });
});
