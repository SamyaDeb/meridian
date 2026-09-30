// Write path. Monad bills the gas LIMIT (CLAUDE.md §7): every tx is estimated first and sent with estimate × 1.2.
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, PublicClient, WalletClient } from "viem";
import { clearingHouseAbi, erc20Abi, swapAbi, vaultAbi } from "./abi";
import { gasLimitFromEstimate } from "./gas";

export async function sendTx<const abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">>(
  pub: PublicClient,
  wallet: WalletClient,
  req: { address: Address; abi: abi; functionName: fn; args: ContractFunctionArgs<abi, "nonpayable" | "payable", fn> },
): Promise<{ hash: `0x${string}`; block: bigint; gasUsed: bigint; gasLimit: bigint }> {
  const account = wallet.account;
  if (!account) throw new Error("wallet not connected");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = req as any;
  const est = await pub.estimateContractGas({ ...r, account });
  const gas = gasLimitFromEstimate(est);
  const hash = await wallet.writeContract({ ...r, account, chain: wallet.chain, gas });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return { hash, block: rcpt.blockNumber, gasUsed: rcpt.gasUsed, gasLimit: gas };
}

/** Does the token implement EIP-2612 (nonces)? AUSD does; the local tAUSD mock doesn't. */
export async function supportsPermit(pub: PublicClient, token: Address, owner: Address): Promise<boolean> {
  try {
    await pub.readContract({ address: token, abi: erc20Abi, functionName: "nonces", args: [owner] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deposit `amountToken` (6 dp) into the ClearingHouse. With EIP-2612 (domain "Agora Dollar", version "1",
 * chainId, verifyingContract = AUSD) the approval is a signature + permit; otherwise approve + deposit.
 */
export async function deposit(pub: PublicClient, wallet: WalletClient, token: Address, ch: Address, amountToken: bigint) {
  await approveOrPermit(pub, wallet, token, ch, amountToken);
  return sendTx(pub, wallet, { address: ch, abi: clearingHouseAbi, functionName: "deposit", args: [amountToken] });
}

/** Vault: ERC-4626 deposit(assets, receiver = me) after permit/approve. Deposits stay idle until a rebalance. */
export async function vaultDeposit(pub: PublicClient, wallet: WalletClient, token: Address, vault: Address, amountToken: bigint) {
  const me = wallet.account?.address;
  if (!me) throw new Error("wallet not connected");
  await approveOrPermit(pub, wallet, token, vault, amountToken);
  return sendTx(pub, wallet, { address: vault, abi: vaultAbi, functionName: "deposit", args: [amountToken, me] });
}

/** Vault: redeem(shares) to me (5 bps fee; an unwind's measured cost if idle AUSD doesn't cover it). */
export async function vaultRedeem(pub: PublicClient, wallet: WalletClient, vault: Address, shares: bigint) {
  const me = wallet.account?.address;
  if (!me) throw new Error("wallet not connected");
  return sendTx(pub, wallet, { address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, me, me] });
}

/** Swap market collateral (same AUSD units as the perp). */
export async function swapDeposit(pub: PublicClient, wallet: WalletClient, token: Address, swap: Address, amountToken: bigint) {
  await approveOrPermit(pub, wallet, token, swap, amountToken);
  return sendTx(pub, wallet, { address: swap, abi: swapAbi, functionName: "deposit", args: [amountToken] });
}

export async function swapWithdraw(pub: PublicClient, wallet: WalletClient, swap: Address, amountToken: bigint) {
  return sendTx(pub, wallet, { address: swap, abi: swapAbi, functionName: "withdraw", args: [amountToken] });
}

/** Allowance for `spender`: EIP-2612 permit when the token supports it (AUSD), else approve (tAUSD mock). */
export async function approveOrPermit(pub: PublicClient, wallet: WalletClient, token: Address, ch: Address, amountToken: bigint) {
  const owner = wallet.account?.address;
  if (!owner) throw new Error("wallet not connected");
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, ch] });
  if (allowance < amountToken) {
    if (await supportsPermit(pub, token, owner)) {
      const nonce = await pub.readContract({ address: token, abi: erc20Abi, functionName: "nonces", args: [owner] });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      const chainId = await pub.getChainId();
      const sig = await wallet.signTypedData({
        account: wallet.account!,
        domain: { name: "Agora Dollar", version: "1", chainId, verifyingContract: token },
        types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "Permit",
        message: { owner, spender: ch, value: amountToken, nonce, deadline },
      });
      const r = `0x${sig.slice(2, 66)}` as `0x${string}`;
      const s = `0x${sig.slice(66, 130)}` as `0x${string}`;
      const v = Number.parseInt(sig.slice(130, 132), 16);
      await sendTx(pub, wallet, { address: token, abi: erc20Abi, functionName: "permit", args: [owner, ch, amountToken, deadline, v, r, s] });
    } else {
      await sendTx(pub, wallet, { address: token, abi: erc20Abi, functionName: "approve", args: [ch, amountToken] });
    }
  }
}
