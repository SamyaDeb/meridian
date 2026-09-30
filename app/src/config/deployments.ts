// Contract addresses come from deployments/<chainId>.json (never hard-coded). 10143/143 files are
// written by DeployPulse.s.sol; until a network is broadcast its file is a `deployed: false` placeholder
// and the network is left out of DEPLOYMENTS (the app then stays on the mock layer for it).
import local from "../../../deployments/31337.json";
import testnet from "../../../deployments/10143.json";
import type { Address } from "@/data/types";

export type ContractKey =
  | "AUSD"
  | "WMON"
  | "ClearingHouse"
  | "OrderBook"
  | "OracleAdapter"
  | "InsuranceFund"
  | "KuruHedger"
  | "PulseVault"
  | "MarketFactory"
  | "FundingSwapMarket"
  | "SwapOrderBook"
  | "PulseKeeperReceiver";

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
  contracts: Partial<Record<ContractKey, Address>>;
  demoMarket?: TestMarket;
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
  withOverride([local as Deployment, testnet as unknown as Deployment], process.env.NEXT_PUBLIC_DEPLOYMENT_OVERRIDE),
);

export function contractAddress(chainId: number, key: ContractKey): Address | undefined {
  return DEPLOYMENTS[chainId]?.contracts[key];
}

export function testMarket(chainId: number): TestMarket | undefined {
  return DEPLOYMENTS[chainId]?.demoMarket;
}
