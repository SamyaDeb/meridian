import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEST_FILL } from "../scripts/gen-config.mjs";

const dep = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../deployments/31337.json"), "utf8")) as {
  contracts: Record<string, `0x${string}`>;
};

// Addresses are EIP-55 checksummed, as Envio decodes them (address_format: checksum).
const cs = (a: string) => a as `0x${string}`;

export const CHAIN = 31337 as const;
export const A = {
  CH: dep.contracts.ClearingHouse!,
  OB: dep.contracts.OrderBook!,
  VAULT: dep.contracts.PulseVault!,
  ORACLE: dep.contracts.OracleAdapter!,
  IF: dep.contracts.InsuranceFund!,
  HEDGER: dep.contracts.KuruHedger!,
  FACTORY: cs(TEST_FILL.MarketFactory),
  SWAP: cs(TEST_FILL.FundingSwapMarket),
  SWAP_OB: cs(TEST_FILL.SwapOrderBook),
  RECEIVER: cs(TEST_FILL.PulseKeeperReceiver),
};
export const ALICE = "0xa11ce00000000000000000000000000000000001" as const;
export const BOB = "0xb0b0000000000000000000000000000000000002" as const;
export const KEEPER = "0xcEe0000000000000000000000000000000000003" as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const WAD = 10n ** 18n;
export const blk = (number: number) => ({ number, timestamp: 1_790_000_000 + Math.floor((number * 3) / 10) });
