// Write path. Monad bills the gas LIMIT (CONTRIBUTING.md §7): every tx is estimated first and sent with estimate × 1.2.
// Two transports share one core (K1.2): a sponsored send (Privy embedded wallet, `sponsor: true`, testnet only, see
// lib/sponsor.ts) or the wallet's own writeContract. Both wait for the receipt and refuse a reverted call.
import {
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { clearingHouseAbi, erc20Abi, mockTokenAbi, swapAbi, vaultAbi } from "./abi";
import { gasLimitFromEstimate } from "./gas";
import { assertPermitUsable, buildPermitTypedData, permitDeadline, splitSignature } from "./permit";
import { SponsorError, isSponsorRefusal } from "./sponsor";

/** A fully built call handed to the sponsored transport (Privy `sendTransaction(…, { sponsor: true })`). */
export type SponsoredCall = { from: Address; to: Address; data: Hex; value: bigint; gas: bigint; chainId: number };
export type SponsoredSend = (call: SponsoredCall) => Promise<Hex>;

// Wallets whose writes go through a sponsored transport. A wrapper copy is registered, never the wagmi client itself,
// so a non-sponsored caller holding the original can't be routed by accident.
const sponsoredSenders = new WeakMap<WalletClient, SponsoredSend>();

/** The same wallet, but `sendTx` sends its calls through `send` (gas paid by the app). */
export function withSponsoredSend(wallet: WalletClient, send: SponsoredSend): WalletClient {
  const w = { ...wallet } as WalletClient;
  sponsoredSenders.set(w, send);
  return w;
}

export const isSponsoredWallet = (wallet: WalletClient): boolean => sponsoredSenders.has(wallet);

// ERC-4337 EntryPoint event (same signature in v0.6 and v0.7). A sponsored call may land inside a bundle whose outer
// transaction succeeds while the user's own call reverted; this event carries the inner result.
const userOpEventAbi = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

/** Throws unless the receipt shows the call succeeded, including the inner call of a bundled (sponsored) operation. */
export function assertReceiptSuccess(rcpt: Pick<TransactionReceipt, "status" | "logs" | "transactionHash">, sender: Address): void {
  if (rcpt.status !== "success") throw new Error(`tx reverted: ${rcpt.transactionHash}`);
  const ops = parseEventLogs({ abi: userOpEventAbi, logs: rcpt.logs, strict: true }).filter((l) => isAddressEqual(l.args.sender, sender));
  if (ops.some((l) => !l.args.success)) throw new Error(`tx reverted: ${rcpt.transactionHash}`);
}

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
  const sponsored = sponsoredSenders.get(wallet);
  let hash: Hex;
  if (sponsored) {
    const data = encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args });
    const chainId = wallet.chain?.id ?? (await pub.getChainId());
    try {
      hash = await sponsored({ from: account.address, to: req.address, data, value: 0n, gas, chainId });
    } catch (e) {
      // never fall back to charging the user: surface the refusal and let them choose (add MON, retry later)
      if (isSponsorRefusal(e)) {
        console.warn("[meridian] gas sponsorship refused", e);
        throw new SponsorError(e);
      }
      throw e;
    }
  } else {
    hash = await wallet.writeContract({ ...r, account, chain: wallet.chain, gas });
  }
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  assertReceiptSuccess(rcpt, account.address);
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
      const deadline = permitDeadline(Date.now());
      const chainId = await pub.getChainId();
      assertPermitUsable({ walletChainId: wallet.chain?.id, nodeChainId: chainId, deadline, nowMs: Date.now() });
      const sig = await wallet.signTypedData({
        account: wallet.account!,
        ...buildPermitTypedData({ token, owner, spender: ch, value: amountToken, nonce, deadline, chainId }),
      });
      const { v, r, s } = splitSignature(sig);
      await sendTx(pub, wallet, { address: token, abi: erc20Abi, functionName: "permit", args: [owner, ch, amountToken, deadline, v, r, s] });
    } else {
      await sendTx(pub, wallet, { address: token, abi: erc20Abi, functionName: "approve", args: [ch, amountToken] });
    }
  }
}

/** Testnet faucet (K1.3): MockERC20.mint(me, amount). Callers gate it with lib/faucet.ts (never on 143). */
export async function mintTestAusd(pub: PublicClient, wallet: WalletClient, token: Address, amountToken: bigint) {
  const me = wallet.account?.address;
  if (!me) throw new Error("wallet not connected");
  return sendTx(pub, wallet, { address: token, abi: mockTokenAbi, functionName: "mint", args: [me, amountToken] });
}

/** Plain approve (the onboarding flow runs approve and deposit as separate, separately reported steps). */
export async function approveToken(pub: PublicClient, wallet: WalletClient, token: Address, spender: Address, amountToken: bigint) {
  return sendTx(pub, wallet, { address: token, abi: erc20Abi, functionName: "approve", args: [spender, amountToken] });
}

export async function depositCollateral(pub: PublicClient, wallet: WalletClient, ch: Address, amountToken: bigint) {
  return sendTx(pub, wallet, { address: ch, abi: clearingHouseAbi, functionName: "deposit", args: [amountToken] });
}
