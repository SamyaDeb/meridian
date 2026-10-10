// Contract addresses come from deployments/<chainId>.json (never hard-coded). 10143/143 files are
// written by DeployMeridian.s.sol; until a network is broadcast its file is a `deployed: false` placeholder
// and the network is left out of DEPLOYMENTS (the app then stays on the mock layer for it). 143 (mainnet) is bundled by
// scripts/sync-mainnet.mjs because deployments/143.json doesn't exist until A commits it.
import local from "../../../deployments/31337.json";
import testnet from "../../../deployments/10143.json";
import { MAINNET_RECORD } from "./mainnet.generated";
import type { Address } from "@/data/types";
import type { AddedMarketRecord } from "./markets";

export type ContractKey =
  | "AUSD"
  | "WMON"
  | "ClearingHouse"
  | "OrderBook"
  | "OracleAdapter"
  | "InsuranceFund"
  | "KuruHedger"
  | "MeridianVault"
  | "MarketFactory"
  | "FundingSwapMarket"
  | "SwapOrderBook"
  | "MeridianKeeperReceiver"
  /** CR-012 (Proposed): present only once the trigger manager is deployed; the trigger UI is hidden without it */
  | "TriggerOrderManager";

/** A second perp market that exists only for the crash/liquidation demo; the UI must label it "test market". */
export interface TestMarket {
  symbol: string;
  testMarket: true;
  ClearingHouse: Address;
  OrderBook: Address;
  OracleAdapter: Address;
}

export interface Deployment {
  chainId: number;
  mocks: boolean;
  startBlock: number;
  deployed?: boolean;
  oracleKind?: "pyth" | "keeper-fed";
  /** symbol of the primary market (contracts.*), e.g. MON-PERP */
  symbol?: string;
  contracts: Partial<Record<ContractKey, Address>>;
  demoMarket?: TestMarket;
  /** K7: markets added to this deployment by AddMarket.s.sol (ETH-PERP on 10143), see config/markets.ts */
  markets?: AddedMarketRecord[];
  /** contract keys deployed as our mocks (e.g. AUSD = MockERC20 with an open mint on testnet / anvil) */
  mockContracts?: string[];
  /** our perp MM, demo MM and house taker flow (deployments `_operators`): disclosed, never counted as users */
  mmAccounts?: Address[];
  /** our keepers (main + demo) */
  keeperAccounts?: Address[];
}

/** A deployment file is usable once it is not a placeholder and has the perp core. Pure. */
export function isLive(d: Deployment): boolean {
  return d.deployed !== false && d.contracts.ClearingHouse !== undefined && d.contracts.OrderBook !== undefined;
}

export function buildDeployments(files: readonly Deployment[]): Readonly<Record<number, Deployment>> {
  const out: Record<number, Deployment> = {};
  for (const d of files) if (isLive(d)) out[d.chainId] = d;
  return out;
}

/**
 * NEXT_PUBLIC_DEPLOYMENT_OVERRIDE = the JSON of one deployments file (build time), replacing that chain's entry. Local
 * rehearsals only: e.g. deployments/anvil-10143.json on a chain-id-10143 anvil, which must never be confused with
 * the real testnet record. Pure; an unparsable override is ignored.
 */
export function withOverride(files: readonly Deployment[], overrideJson: string | undefined): Deployment[] {
  if (!overrideJson) return [...files];
  try {
    const o = JSON.parse(overrideJson) as Deployment;
    if (typeof o.chainId !== "number" || typeof o.contracts !== "object") return [...files];
    return [...files.filter((f) => f.chainId !== o.chainId), o];
  } catch {
    return [...files];
  }
}

export const DEPLOYMENTS: Readonly<Record<number, Deployment>> = buildDeployments(
  withOverride(
    [local as Deployment, testnet as unknown as Deployment, ...(MAINNET_RECORD ? [MAINNET_RECORD] : [])],
    process.env.NEXT_PUBLIC_DEPLOYMENT_OVERRIDE,
  ),
);

/** Networks users can be pointed at; when one of these has no live record the UI says so instead of showing mocks. */
export const PUBLIC_CHAIN_IDS = [143, 10143] as const;

export type DeploymentState = "live" | "not-deployed" | "local";

/** Pure: live record ⇒ "live"; a public network without one ⇒ "not-deployed"; anything else (anvil) ⇒ "local". */
export function deploymentState(chainId: number, deployments: Readonly<Record<number, Deployment>> = DEPLOYMENTS): DeploymentState {
  if (deployments[chainId]) return "live";
  return (PUBLIC_CHAIN_IDS as readonly number[]).includes(chainId) ? "not-deployed" : "local";
}

export function contractAddress(chainId: number, key: ContractKey): Address | undefined {
  return DEPLOYMENTS[chainId]?.contracts[key];
}

export function deploymentFor(chainId: number): Deployment | undefined {
  return DEPLOYMENTS[chainId];
}

export function testMarket(chainId: number): TestMarket | undefined {
  return DEPLOYMENTS[chainId]?.demoMarket;
}

/** Operator accounts (MM, house flow, keepers) of `chainId`, lower-cased: excluded from user counts like ProtocolStats. */
export function operatorAccounts(chainId: number): { mm: string[]; all: string[] } {
  const d = deploymentFor(chainId);
  const mm = (d?.mmAccounts ?? []).map((a) => a.toLowerCase());
  return { mm, all: [...mm, ...(d?.keeperAccounts ?? []).map((a) => a.toLowerCase())] };
}
