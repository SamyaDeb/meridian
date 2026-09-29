// Contract addresses come from deployments/<chainId>.json (never hard-coded). 10143/143 files are
// written by DeployPulse.s.sol (testnet: B's daily deploy; mainnet: CP3) and get added here when they exist.
import local from "../../../deployments/31337.json";
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

export interface Deployment {
  chainId: number;
  mocks: boolean;
  startBlock: number;
  contracts: Partial<Record<ContractKey, Address>>;
}

export const DEPLOYMENTS: Readonly<Record<number, Deployment>> = {
  31337: local as Deployment,
};

export function contractAddress(chainId: number, key: ContractKey): Address | undefined {
  return DEPLOYMENTS[chainId]?.contracts[key];
}
