// Test funds on testnet (MOBILE_PLAN N4b "Get test funds"): MON from the Monad faucet (ARCHITECTURE R29), test AUSD
// from Meridian's AUSD mock, whose mint(to, amount) is open (contracts/src/mocks/MockERC20.sol; the web app's K1.3
// faucet does the same). Never on 143: mainnet AUSD is the real token. Perpl's test AUSD has no public mint.
import { mockTokenAbi } from "@meridian/core/meridian";
import { encodeFunctionData, type Address } from "viem";
import type { AppConfig } from "../config/appConfig";
import type { TxRequest } from "./sendTx";

/** Monad testnet faucet: docs/ARCHITECTURE.md R29 (docs.monad.xyz/developer-essentials/testnet). */
export const TESTNET_FAUCET = "https://faucet.monad.xyz";

/** Whole test AUSD per tap (the web faucet's amount). */
export const TEST_AUSD_WHOLE = 10_000n;

/** Meridian's AUSD when it is a mock on a test chain; undefined otherwise (mainnet, or not deployed). */
export function mintableTestAusd(cfg: Pick<AppConfig, "chainId" | "meridian">): Address | undefined {
  if (cfg.chainId === 143 || cfg.meridian.status !== "deployed") return undefined;
  const d = cfg.meridian.deployment;
  return d.mockContracts.includes("AUSD") ? d.contracts.AUSD : undefined;
}

export function mintTestAusdTx(token: Address, to: Address, decimals: number): TxRequest {
  return { to: token, data: encodeFunctionData({ abi: mockTokenAbi, functionName: "mint", args: [to, TEST_AUSD_WHOLE * 10n ** BigInt(decimals)] }) };
}
