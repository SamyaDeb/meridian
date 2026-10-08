#!/usr/bin/env node
// Generates the Envio config for one chain from deployments/<chainId>.json (never hard-code addresses).
//   node scripts/gen-config.mjs 31337   -> config.yaml          (local anvil via DeployLocal; RPC, no HyperSync)
//   node scripts/gen-config.mjs 10143   -> config.testnet.yaml  (HyperSync, no RPC mode)
//   node scripts/gen-config.mjs 143     -> config.mainnet.yaml  (HyperSync, no RPC mode)
//   node scripts/gen-config.mjs 10143 --hosted -> config.hosted.testnet.yaml + abis/*.json copied in (Envio Cloud: Root
//     Directory = indexer/, nothing referenced outside it; docs/outputs/HOSTED_ENVIO.md)
// Contract keys match DeployMeridian.s.sol / DeployLocal.s.sol. Keys missing from a deployment are skipped
// (e.g. the Day-1 mock stack has no MarketFactory / FundingSwapMarket yet).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const INDEXER_DIR = resolve(HERE, "..");
export const REPO_DIR = resolve(INDEXER_DIR, "..");

/** Every event of every frozen interface (contracts/src/interfaces). ERC-4626 `Approval` is intentionally not indexed. */
export const CONTRACTS = [
  {
    name: "ClearingHouse",
    abi: "IClearingHouse",
    events: [
      "Deposited", "Withdrawn", "FundingUpdated", "FundingSettled", "PositionChanged", "Liquidated",
      "BadDebtSocialized", "OrderMarginChanged", "FeesCollected", "RiskParamsUpdated",
      "FundingParamsUpdated", "PausedSet", "FundingCheckpoint",
    ],
  },
  { name: "OrderBook", abi: "IOrderBook", events: ["OrderPlaced", "OrderCancelled", "OrderEvicted", "MakerFillSkipped", "Trade"] },
  { name: "SwapOrderBook", abi: "IOrderBook", events: ["OrderPlaced", "OrderCancelled", "OrderEvicted", "MakerFillSkipped", "Trade"] },
  {
    name: "FundingSwapMarket",
    abi: "IFundingSwapMarket",
    events: [
      "Deposited", "Withdrawn", "SwapPositionChanged", "SwapAccrualSettled", "SwapLiquidated",
      "MaturitySettled", "SwapParamsUpdated",
    ],
  },
  {
    name: "MeridianVault",
    abi: "IMeridianVault",
    events: [
      "Deposit", "Withdraw", "Transfer", "Rebalanced", "HedgeExited", "HedgeEntered", "NavSnapshot",
      "VaultParamsUpdated", "KeeperUpdated",
      // CR-014 (interfaces-v1.7): async withdrawals + emergency unwind
      "RedeemRequested", "RedeemCancelled", "RedeemFulfilled", "RedeemClaimed", "EmergencyUnwind",
    ],
  },
  { name: "OracleAdapter", abi: "IOracleAdapter", events: ["PriceUpdated", "DeviationGuardTripped", "OracleParamsUpdated"] },
  { name: "InsuranceFund", abi: "IInsuranceFund", events: ["Funded", "BadDebtCovered", "MarketAuthorized"] },
  { name: "MarketFactory", abi: "IMarketFactory", events: ["MarketRegistered", "MarketStatusChanged"] },
  { name: "KuruHedger", abi: "IKuruHedger", events: ["SpotBought", "SpotSold"] },
  {
    name: "MeridianKeeperReceiver",
    abi: "IMeridianKeeperReceiver",
    // CR-016 (interfaces-v1.8): Unwound, ExpectedWorkflowUpdated
    events: ["ReportExecuted", "ForwarderUpdated", "Unwound", "ExpectedWorkflowUpdated"],
  },
  // CR-016: the Meridian Funding Index onchain, written by the receiver (CRE W3)
  { name: "MeridianMfiFeed", abi: "IMeridianMfiFeed", events: ["MfiPublished"] },
  // Perpl's exchange (another Monad perp, K2.2): ABI vendored in indexer/abis (MIT, PerplFoundation/dex-sdk; see
  // abis/README.md), address from deployments/perpl.json. Only the events seen AND decoded on the deployed contract
  // (indexer/PERPL_EVENTS.md); PositionOpened/Increased v1, Deleveraged(V2), InsurancePaymentForSettlement and
  // PositionCollateralDecreased never appeared in the recordings, so they are not indexed.
  {
    name: "PerplExchange",
    abi: "PerplExchange",
    vendored: true,
    events: [
      "FundingEventCompleted", "MarkUpdated", "PositionOpenedV2", "PositionIncreasedV2", "PositionDecreased",
      "PositionClosed", "PositionInverted", "PositionLiquidated", "IncreasePositionCollateral", "CollateralDeposit",
      "CollateralWithdrawal", "AccountCreated",
    ],
  },
];

/** Contracts whose address comes from deployments/perpl.json instead of deployments/<chainId>.json. */
export const PERPL_CONTRACT = "PerplExchange";

/**
 * Perpl event profiles. Envio Cloud's free Development plan has a soft limit of 100,000 processed events
 * (docs.envio.dev hosted-service-deployment, 7 Oct 2026), and Perpl's position + mark traffic alone is ~215k events
 * over Meridian's testnet window (~250k/day): "lean" keeps funding, liquidations and account ids (a few hundred events
 * a day per chain), which is all CrossVenueFunding needs. "full" adds positions, mark and collateral (tests, local, or
 * a paid plan). Positions for a single trader are exact and live from the exchange's views (getAccountByAddr,
 * getPosition), so the app reads those directly.
 */
export const PERPL_PROFILES = {
  full: null, // every event in CONTRACTS
  lean: ["FundingEventCompleted", "PositionLiquidated", "AccountCreated"],
};
/** Profile of the hosted (Envio Cloud) config. */
export const HOSTED_PERPL_PROFILE = "lean";

export const CHAINS = {
  31337: { file: "config.yaml", label: "local anvil (DeployLocal)" },
  10143: { file: "config.testnet.yaml", label: "Monad testnet", hypersync: "https://10143.hypersync.xyz" },
  143: { file: "config.mainnet.yaml", label: "Monad mainnet", hypersync: "https://143.hypersync.xyz" },
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Pure: hosted variant of renderConfig: ABIs resolved inside the indexer dir (./abis), so Envio Cloud's Root Directory
 *  can be `indexer/` (its docs: keep every import inside the indexer directory). */
export function renderHostedConfig(chainId, deployment, perpl, extraChains = [], perplProfile = HOSTED_PERPL_PROFILE) {
  return renderConfig(chainId, deployment, perpl, extraChains, perplProfile)
    .replaceAll("abi_file_path: ../abis/", "abi_file_path: ./abis/")
    .replace("). Do not edit.", ", Envio Cloud: ABIs vendored in indexer/abis). Do not edit.");
}

/** ABI files copied from the repo's abis/ into indexer/abis for the hosted config (vendored ones already live there). */
export const ABI_FILES = [...new Set(CONTRACTS.filter((c) => !c.vendored).map((c) => `${c.abi}.json`))];

/** deployments/perpl.json (Perpl exchange per chain + seeded market metadata); undefined if absent. */
export function readPerpl() {
  const f = resolve(REPO_DIR, "deployments/perpl.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
}

/**
 * Pure: deployment JSON -> config.yaml text. `perpl` = deployments/perpl.json (adds PerplExchange on that chain at the
 * same start block, so both venues cover the same window). `extraChains` = more chains that index only Perpl
 * (K2.3 multichain: [{ id, startBlock }]).
 */
export function renderConfig(chainId, deployment, perpl, extraChains = [], perplProfile = "full") {
  if (!(perplProfile in PERPL_PROFILES)) throw new Error(`unknown Perpl profile ${perplProfile}`);
  const only = PERPL_PROFILES[perplProfile];
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`unsupported chainId ${chainId}`);
  if (Number(deployment.chainId) !== Number(chainId)) {
    throw new Error(`deployments chainId ${deployment.chainId} != ${chainId}`);
  }
  if (deployment.deployed === false) {
    throw new Error(`deployments/${chainId}.json is a NOT DEPLOYED placeholder: run DeployMeridian.s.sol with --broadcast first`);
  }
  const addrs = deployment.contracts ?? {};
  const L = [];
  L.push("# yaml-language-server: $schema=./node_modules/envio/evm.schema.json");
  L.push(`# GENERATED by scripts/gen-config.mjs from deployments/${chainId}.json (${chain.label}). Do not edit.`);
  L.push("name: meridian-indexer");
  L.push("description: Meridian funding-rate layer (per-block funding perp, funding oracle, basis vault, funding swaps)");
  L.push("disable_default_cross_chain: true");
  L.push("# Handlers read transaction.hash (block number/timestamp are always selected).");
  L.push("field_selection:");
  L.push("  transaction_fields: [hash]");
  L.push("contracts:");
  for (const c of CONTRACTS) {
    L.push(`  - name: ${c.name}`);
    L.push(`    abi_file_path: ${c.vendored ? "./abis/" : "../abis/"}${c.abi}.json`);
    L.push("    events:");
    const events = c.name === PERPL_CONTRACT && only ? c.events.filter((e) => only.includes(e)) : c.events;
    for (const e of events) L.push(`      - event: ${e}`);
  }
  L.push("chains:");
  L.push(`  - id: ${chainId}`);
  L.push(`    start_block: ${Number(deployment.startBlock ?? 0)}`);
  if (chain.hypersync) {
    L.push("    hypersync_config:");
    L.push(`      url: ${chain.hypersync}`);
  } else {
    L.push("    rpc:");
    L.push("      - url: ${ENVIO_LOCAL_RPC_URL:-http://127.0.0.1:8545}");
    L.push("        for: sync");
  }
  L.push("    contracts:");
  let n = 0;
  for (const c of CONTRACTS) {
    const a = addrs[c.name];
    if (!a) continue;
    if (!ADDRESS_RE.test(a)) throw new Error(`deployments/${chainId}.json: bad address for ${c.name}: ${a}`);
    L.push(`      - name: ${c.name}`);
    L.push(`        address: "${a}"`);
    n++;
  }
  if (n === 0) throw new Error(`deployments/${chainId}.json has no indexable contracts`);
  const px = perplAddress(perpl, chainId);
  if (px) {
    L.push(`      - name: ${PERPL_CONTRACT}`);
    L.push(`        address: "${px}"`);
  }
  for (const x of extraChains) {
    const a = perplAddress(perpl, x.id);
    if (!a) throw new Error(`deployments/perpl.json has no exchange for extra chain ${x.id}`);
    if (!CHAINS[x.id]?.hypersync) throw new Error(`extra chain ${x.id} needs HyperSync`);
    if (!(Number.isSafeInteger(x.startBlock) && x.startBlock > 0)) throw new Error(`extra chain ${x.id}: bad startBlock`);
    L.push(`  - id: ${x.id}`);
    L.push(`    start_block: ${x.startBlock}`);
    L.push("    hypersync_config:");
    L.push(`      url: ${CHAINS[x.id].hypersync}`);
    L.push("    contracts:");
    L.push(`      - name: ${PERPL_CONTRACT}`);
    L.push(`        address: "${a}"`);
  }
  return L.join("\n") + "\n";
}

function perplAddress(perpl, chainId) {
  const a = perpl?.chains?.[String(chainId)]?.exchange;
  if (a === undefined) return undefined;
  if (!ADDRESS_RE.test(a)) throw new Error(`deployments/perpl.json: bad exchange address for ${chainId}: ${a}`);
  return a;
}

/** Pure: deployments/perpl.json -> src/perpl.gen.ts (market metadata the handlers read; never fetched at runtime). */
export function renderPerplTs(perpl) {
  const L = [
    "// GENERATED by scripts/gen-config.mjs from deployments/perpl.json (seeded by scripts/seed-perpl.mjs). Do not edit.",
    "export type PerplMarketMeta = {",
    "  readonly name: string;",
    "  readonly symbol: string;",
    "  readonly priceDecimals: number;",
    "  readonly sizeDecimals: number;",
    "  readonly fundingIntervalSec: number;",
    "  readonly fundingIntervalBlocks: number;",
    "};",
    "export type PerplChain = {",
    "  readonly exchange: string;",
    "  readonly collateralDecimals: number;",
    "  readonly monPerpId: number;",
    "  readonly fetched: string;",
    "  readonly markets: Readonly<Record<string, PerplMarketMeta>>;",
    "};",
    "export const PERPL: Readonly<Record<number, PerplChain>> = {",
  ];
  const chains = Object.entries(perpl?.chains ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [id, c] of chains) {
    if (!c.markets) throw new Error(`deployments/perpl.json chain ${id} has no markets: run scripts/seed-perpl.mjs`);
    L.push(`  ${Number(id)}: {`);
    L.push(`    exchange: "${c.exchange}",`);
    L.push(`    collateralDecimals: ${Number(c.collateralDecimals)},`);
    L.push(`    monPerpId: ${Number(c.monMarketId)},`);
    L.push(`    fetched: "${c.fetched}",`);
    L.push("    markets: {");
    for (const [pid, m] of Object.entries(c.markets).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      L.push(
        `      "${pid}": { name: ${JSON.stringify(m.name)}, symbol: ${JSON.stringify(m.symbol)}, priceDecimals: ${m.priceDecimals}, ` +
          `sizeDecimals: ${m.sizeDecimals}, fundingIntervalSec: ${m.fundingIntervalSec}, fundingIntervalBlocks: ${m.fundingIntervalBlocks} },`,
      );
    }
    L.push("    },");
    L.push("  },");
  }
  L.push("};");
  // vitest runs on 31337 (config.test.yaml): it reuses the testnet's market metadata with the test exchange address
  if (perpl?.chains?.["10143"]) {
    L.push("/** vitest only (config.test.yaml, chain 31337): the testnet metadata behind a test exchange address. */");
    L.push(`export const PERPL_TEST: PerplChain = { ...PERPL[10143]!, exchange: "${TEST_PERPL_EXCHANGE}" };`);
  }
  return L.join("\n") + "\n";
}

/** Pure: all deployments -> src/deployments.gen.ts (static book -> market wiring for handlers). */
export function renderDeploymentsTs(deployments) {
  const keys = ["ClearingHouse", "OrderBook", "FundingSwapMarket", "SwapOrderBook", "MeridianVault", "InsuranceFund"];
  const L = [
    "// GENERATED by scripts/gen-config.mjs from deployments/*.json. Do not edit.",
    "// Static wiring used when MarketFactory.MarketRegistered has not (yet) been indexed.",
    "export type DeploymentWiring = { readonly [K in \"" + keys.join("\" | \"") + "\"]?: string };",
    "export const DEPLOYMENTS: Readonly<Record<number, DeploymentWiring>> = {",
  ];
  for (const d of [...deployments].sort((a, b) => Number(a.chainId) - Number(b.chainId))) {
    const entries = keys.filter((k) => d.contracts?.[k]).map((k) => `${k}: "${d.contracts[k]}"`);
    L.push(`  ${Number(d.chainId)}: { ${entries.join(", ")} },`);
  }
  L.push("};");
  L.push("/** Labelled TEST markets (deployments demoMarket): the crash/liquidation demo market, never the product. */");
  L.push("export const TEST_MARKETS: Readonly<Record<number, readonly string[]>> = {");
  for (const d of [...deployments].sort((a, b) => Number(a.chainId) - Number(b.chainId))) {
    const ch = d.demoMarket?.ClearingHouse;
    if (ch) L.push(`  ${Number(d.chainId)}: ["${ch.toLowerCase()}"],`);
  }
  L.push("};");
  // Operator accounts (never external users): optional `mmAccounts` / `keeperAccounts` arrays + `owner` in the record.
  L.push("/** Our market-maker accounts (deployments `mmAccounts`): their volume is disclosed separately (RISKS E9). */");
  L.push("export const MM_ACCOUNTS: Readonly<Record<number, readonly string[]>> = {");
  for (const d of [...deployments].sort((a, b) => Number(a.chainId) - Number(b.chainId))) {
    const mm = operatorList(d.mmAccounts, d.chainId, "mmAccounts");
    if (mm.length) L.push(`  ${Number(d.chainId)}: [${mm.map((a) => `"${a}"`).join(", ")}],`);
  }
  L.push("};");
  L.push("/** Accounts that are ours (MM, keeper, owner): excluded from ProtocolStats.externalUsers. */");
  L.push("export const OPERATOR_ACCOUNTS: Readonly<Record<number, readonly string[]>> = {");
  for (const d of [...deployments].sort((a, b) => Number(a.chainId) - Number(b.chainId))) {
    const ops = [
      ...operatorList(d.mmAccounts, d.chainId, "mmAccounts"),
      ...operatorList(d.keeperAccounts, d.chainId, "keeperAccounts"),
      ...(typeof d.owner === "string" && ADDRESS_RE.test(d.owner) ? [d.owner.toLowerCase()] : []),
    ];
    const uniq = [...new Set(ops)];
    if (uniq.length) L.push(`  ${Number(d.chainId)}: [${uniq.map((a) => `"${a}"`).join(", ")}],`);
  }
  L.push("};");
  return L.join("\n") + "\n";
}

/** Lower-cased operator addresses; anything that isn't an address is a hard error (never guess). */
export function operatorList(value, chainId, key) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`deployments/${chainId}.json: ${key} must be an array of addresses`);
  return value.map((a) => {
    if (typeof a !== "string" || !ADDRESS_RE.test(a)) throw new Error(`deployments/${chainId}.json: bad address in ${key}: ${a}`);
    return a.toLowerCase();
  });
}

function writeDeploymentsTs() {
  const dir = resolve(REPO_DIR, "deployments");
  const all = readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")));
  writeFileSync(resolve(INDEXER_DIR, "src/deployments.gen.ts"), renderDeploymentsTs(all));
  writeFileSync(resolve(INDEXER_DIR, "src/perpl.gen.ts"), renderPerplTs(readPerpl()));
}

/** Test-only addresses (EIP-55 checksummed) for contracts the Day-1 mock deployment doesn't have yet (config.test.yaml only). */
export const TEST_FILL = {
  MarketFactory: "0x00000000000000000000000000000000000000f1",
  FundingSwapMarket: "0x00000000000000000000000000000000000000F2",
  SwapOrderBook: "0x00000000000000000000000000000000000000f3",
  MeridianKeeperReceiver: "0x00000000000000000000000000000000000000F4",
  MeridianMfiFeed: "0x00000000000000000000000000000000000000F6",
};
/** Test-only Perpl exchange on 31337 (config.test.yaml); its market metadata is PERPL_TEST in src/perpl.gen.ts. */
export const TEST_PERPL_EXCHANGE = "0x00000000000000000000000000000000000000f5";

/**
 * K2.3: Perpl on Monad mainnet in the same hosted indexer (Envio multichain; the Development plan includes it).
 * Start = mainnet head 111,352,347 (7 Oct 2026 ~14:40 UTC) − 2,016,000 blocks ≈ 7 days at Perpl's 8,571 blocks per
 * 2,580 s, rounded down. Lean profile on mainnet ≈ 4k events for those 7 days (464 funding + 42 liquidations per
 * 250k blocks recorded, PERPL_EVENTS.md), so the whole indexer stays far below the plan's 100k soft limit.
 */
export const HOSTED_EXTRA_CHAINS = { 10143: [{ id: 143, startBlock: 109_336_000 }] };

function main() {
  if (process.argv[2] === "test") {
    // Vitest config: local 31337 deployment + TEST_FILL for missing keys (simulate() only routes configured addresses).
    const d = JSON.parse(readFileSync(resolve(REPO_DIR, "deployments/31337.json"), "utf8"));
    d.contracts = { ...TEST_FILL, ...d.contracts };
    d.startBlock = 0; // synthetic test blocks start low; the live deployment's startBlock must not filter them
    const perpl = { chains: { 31337: { exchange: TEST_PERPL_EXCHANGE } } };
    writeFileSync(
      resolve(INDEXER_DIR, "config.test.yaml"),
      renderConfig(31337, d, perpl).replace("(local anvil (DeployLocal))", "(vitest: 31337 + TEST_FILL)"),
    );
    console.log("wrote config.test.yaml");
    return;
  }
  const chainId = Number(process.argv[2] ?? 31337);
  const hosted = process.argv.includes("--hosted");
  const path = resolve(REPO_DIR, "deployments", `${chainId}.json`);
  if (!existsSync(path)) {
    console.error(`deployments/${chainId}.json not found. It is written by DeployMeridian.s.sol (B deploys testnet daily 21:00; mainnet at CP3).`);
    process.exit(1);
  }
  const dep = JSON.parse(readFileSync(path, "utf8"));
  if (hosted) {
    if (!CHAINS[chainId]?.hypersync) throw new Error("--hosted needs a HyperSync chain (10143 or 143)");
    mkdirSync(resolve(INDEXER_DIR, "abis"), { recursive: true });
    for (const f of ABI_FILES) copyFileSync(resolve(REPO_DIR, "abis", f), resolve(INDEXER_DIR, "abis", f));
    const file = CHAINS[chainId].file.replace("config.", "config.hosted.");
    writeFileSync(resolve(INDEXER_DIR, file), renderHostedConfig(chainId, dep, readPerpl(), HOSTED_EXTRA_CHAINS[chainId] ?? []));
    writeDeploymentsTs();
    console.log(`wrote ${file} + abis/ (${ABI_FILES.length} files)`);
    return;
  }
  const out = renderConfig(chainId, dep, readPerpl());
  writeFileSync(resolve(INDEXER_DIR, CHAINS[chainId].file), out);
  writeDeploymentsTs();
  console.log(`wrote ${CHAINS[chainId].file} and src/deployments.gen.ts`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
