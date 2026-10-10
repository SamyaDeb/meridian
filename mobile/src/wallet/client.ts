// A wallet client per (account, chain): signs locally with the Mera session account, sends raw txs over the app RPC.
import { createWalletClient, http, type LocalAccount } from "viem";
import type { AppConfig } from "../config/appConfig";
import type { SignerWallet } from "./sendTx";

export function walletClientFor(account: LocalAccount, cfg: Pick<AppConfig, "chain" | "rpc">): SignerWallet {
  if (!cfg.rpc) throw new Error("No RPC is configured for this build");
  return createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpc.http, { retryCount: 0, timeout: 15_000 }) });
}
