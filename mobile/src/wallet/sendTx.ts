// The one write path for the native app (MOBILE_PLAN N3 §3, ported from app/src/lib/tx.ts): estimate → gas limit =
// estimate × 1.2 rounded up (Monad bills the limit, core gas.ts) → nonce from the pending block → EIP-1559 fees from the
// node → sign locally with the passkey session (viem local account) → explicit chainId → wait for the receipt → a
// revert becomes a plain-English TxError (re-simulated at the receipt's block to recover the reason).
import { gasLimitFromEstimate } from "@meridian/core/meridian";
import type { Abi, Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { explainTxError, meridianErrorsAbi } from "./revert";

export type TxRequest = { to: Address; data?: Hex; value?: bigint };

export type TxResult = { hash: Hex; blockNumber: bigint; gasUsed: bigint; gasLimit: bigint; gasEstimate: bigint; nonce: number };

export class TxError extends Error {
  constructor(
    message: string,
    readonly hash?: Hex,
  ) {
    super(message);
    this.name = "TxError";
  }
}

export type SignerWallet = WalletClient<Transport, Chain, Account>;

export type SendOpts = { abi?: Abi; pollingInterval?: number; receiptTimeoutMs?: number };

export async function sendTx(pub: PublicClient, wallet: SignerWallet, req: TxRequest, o: SendOpts = {}): Promise<TxResult> {
  const abi = o.abi ?? meridianErrorsAbi;
  const account = wallet.account;
  const chain = wallet.chain;
  const call = { account, to: req.to, ...(req.data ? { data: req.data } : {}), value: req.value ?? 0n };

  let gasEstimate: bigint;
  try {
    gasEstimate = await pub.estimateGas(call);
  } catch (e) {
    throw new TxError(explainTxError(e, abi));
  }
  const gas = gasLimitFromEstimate(gasEstimate);

  let hash: Hex;
  let nonce: number;
  try {
    nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    const fees = await pub.estimateFeesPerGas({ chain, type: "eip1559" });
    hash = await wallet.sendTransaction({
      ...call,
      chain,
      type: "eip1559",
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
  } catch (e) {
    if (e instanceof TxError) throw e;
    throw new TxError(explainTxError(e, abi));
  }

  let rcpt;
  try {
    rcpt = await pub.waitForTransactionReceipt({ hash, pollingInterval: o.pollingInterval ?? 400, timeout: o.receiptTimeoutMs ?? 60_000 });
  } catch {
    throw new TxError("Sent, but no confirmation yet. Check the explorer before trying again.", hash);
  }
  if (rcpt.status !== "success") {
    let reason = "The transaction reverted.";
    try {
      await pub.call({ ...call, account: account.address, gas, blockNumber: rcpt.blockNumber });
    } catch (e) {
      reason = explainTxError(e, abi);
    }
    throw new TxError(reason, hash);
  }
  return { hash, blockNumber: rcpt.blockNumber, gasUsed: rcpt.gasUsed, gasLimit: gas, gasEstimate, nonce };
}
