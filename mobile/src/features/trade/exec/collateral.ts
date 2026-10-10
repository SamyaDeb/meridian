// Meridian collateral for a trade, ported from app/src/lib/tx.ts (approveOrPermit + deposit, main @ 0ba1664) onto the
// native write path (wallet/sendTx: gas = estimate × 1.2, plain-English reverts). EIP-2612 permit when the token has
// `nonces` (mainnet AUSD: domain "Agora Dollar" v"1", core meridian/permit), else approve EXACTLY the amount (testnet
// mock). Signed with a per-transaction session from a fresh passkey prompt (N3: deposits re-prompt).
import { assertPermitUsable, buildPermitTypedData, clearingHouseAbi, erc20PermitAbi, permitDeadline, splitSignature } from "@meridian/core/meridian";
import { divCeil } from "@meridian/core/util";
import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { sendTx, type SignerWallet } from "../../../wallet/sendTx";

const TOKEN = 10n ** 12n; // AUSD 6 dp ↔ WAD

/** WAD owed by the user → whole AUSD token units, rounded up. */
export const owedToken = (wad: bigint): bigint => divCeil(wad, TOKEN);

export async function supportsPermit(pub: PublicClient, token: Address, owner: Address): Promise<boolean> {
  try {
    await pub.readContract({ address: token, abi: erc20PermitAbi, functionName: "nonces", args: [owner] });
    return true;
  } catch {
    return false;
  }
}

/** Allowance for `spender` of exactly `amountToken`: permit (one signature + one tx) or approve. */
export async function approveOrPermit(pub: PublicClient, wallet: SignerWallet, token: Address, spender: Address, amountToken: bigint, nowMs: () => number = Date.now): Promise<void> {
  const owner = wallet.account.address;
  const allowance = await pub.readContract({ address: token, abi: erc20PermitAbi, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amountToken) return;
  if (await supportsPermit(pub, token, owner)) {
    const nonce = await pub.readContract({ address: token, abi: erc20PermitAbi, functionName: "nonces", args: [owner] });
    const deadline = permitDeadline(nowMs());
    const chainId = await pub.getChainId();
    assertPermitUsable({ walletChainId: wallet.chain.id, nodeChainId: chainId, deadline, nowMs: nowMs() });
    const sig = await wallet.signTypedData({ account: wallet.account, ...buildPermitTypedData({ token, owner, spender, value: amountToken, nonce, deadline, chainId }) });
    const { v, r, s } = splitSignature(sig);
    await sendTx(pub, wallet, { to: token, data: encodeFunctionData({ abi: erc20PermitAbi, functionName: "permit", args: [owner, spender, amountToken, deadline, v, r, s] }) });
  } else {
    await sendTx(pub, wallet, { to: token, data: encodeFunctionData({ abi: erc20PermitAbi, functionName: "approve", args: [spender, amountToken] }) });
  }
}

/**
 * Deposit what the trade still needs on Meridian: `needWad` (margin + fee) minus the free collateral read NOW (the
 * ticket's number may be a block old; a deposit that already landed before a retry is not repeated). Owed ⇒ rounded up.
 */
export async function ensureMeridianCollateral(o: { pub: PublicClient; wallet: SignerWallet; token: Address; clearingHouse: Address; needWad: bigint; freeNow: () => Promise<bigint> }): Promise<bigint> {
  const free = await o.freeNow();
  if (free >= o.needWad) return 0n;
  const amountToken = owedToken(o.needWad - free);
  await approveOrPermit(o.pub, o.wallet, o.token, o.clearingHouse, amountToken);
  await sendTx(o.pub, o.wallet, { to: o.clearingHouse, data: encodeFunctionData({ abi: clearingHouseAbi, functionName: "deposit", args: [amountToken] }) });
  return amountToken;
}
