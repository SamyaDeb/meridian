// Earn's collateral step (core exec/basis COLLATERAL): before the first leg, each venue must hold its leg's margin + fee.
// Free collateral is re-read NOW on both venues (a quote can be a block old; a top-up that already landed before a retry
// is never repeated). Nothing short ⇒ no prompt. Otherwise ONE fresh passkey prompt (deposits move value, N3) covers
// both top-ups: Meridian = permit/approve + ClearingHouse.deposit (N5 collateral.ts); Perpl = approve exactly +
// depositCollateral on the exchange (core perpl/onboarding tx builders; the account exists: Perpl is READY); with a
// Lock, the funding-swap market's deposit rides the same prompt (swapDeposit). Owed
// amounts round UP to whole token units; the venues use different tokens on testnet (each venue's own token).
import { approveCollateralTx, depositCollateralTx } from "@meridian/core/perpl";
import { divCeil } from "@meridian/core/util";
import { swapAbi } from "@meridian/core/meridian";
import { encodeFunctionData, erc20Abi, type Address, type LocalAccount, type PublicClient } from "viem";
import { needsApprove } from "../../venues/perpl/amounts";
import { sendTx, type SignerWallet } from "../../wallet/sendTx";
import { approveOrPermit, owedToken } from "../trade/exec/collateral";

export type EarnCollateralDeps = {
  freeMeridian: () => Promise<bigint>;
  freePerpl: () => Promise<bigint>;
  withFreshSession: <T>(fn: (account: LocalAccount) => Promise<T>) => Promise<T>;
  /** deposit what Meridian still needs (`needWad`, re-checked inside); returns token units moved */
  depositMeridian: (account: LocalAccount, needWad: bigint) => Promise<unknown>;
  /** top up Perpl by `amountCns` (collateral token units) */
  depositPerpl: (account: LocalAccount, amountCns: bigint) => Promise<void>;
  perplCollateralDecimals: number;
  /** Lock: add `amountWad` (whole AUSD units) on the funding-swap market; required when lockWad > 0 */
  depositLock?: (account: LocalAccount, amountWad: bigint) => Promise<void>;
};

export type CollateralTopUp = { meridian: boolean; perplCns: bigint; lockWad: bigint };

/**
 * What each venue still needs; no prompt when both already cover their leg and there is no Lock deposit. The Lock's
 * amount was computed by the quote against the swap account's collateral then (core swapLockNeedWad), so it is added
 * as quoted (never more than what the user saw).
 */
export async function ensureEarnCollateral(d: EarnCollateralDeps, perplWad: bigint, meridianWad: bigint, lockWad = 0n): Promise<CollateralTopUp> {
  const [fm, fp] = await Promise.all([d.freeMeridian(), d.freePerpl()]);
  const meridianShort = meridianWad > fm;
  const perplCns = perplWad > fp ? divCeil(perplWad - fp, 10n ** BigInt(18 - d.perplCollateralDecimals)) : 0n; // owed ⇒ up
  if (lockWad > 0n && !d.depositLock) throw new Error("The fixed-rate market isn't configured on this chain");
  if (!meridianShort && perplCns === 0n && lockWad === 0n) return { meridian: false, perplCns: 0n, lockWad: 0n };
  await d.withFreshSession(async (account) => {
    if (meridianShort) await d.depositMeridian(account, meridianWad);
    if (perplCns > 0n) await d.depositPerpl(account, perplCns);
    if (lockWad > 0n) await d.depositLock!(account, lockWad);
  });
  return { meridian: meridianShort, perplCns, lockWad };
}

/** Funding-swap collateral (app/src/lib/tx.ts swapDeposit, main @ 0ba1664): permit/approve exactly, then deposit(amountToken ↑). */
export async function swapDeposit(o: { pub: PublicClient; wallet: SignerWallet; token: Address; market: Address; amountWad: bigint }): Promise<void> {
  const amountToken = owedToken(o.amountWad);
  await approveOrPermit(o.pub, o.wallet, o.token, o.market, amountToken);
  await sendTx(o.pub, o.wallet, { to: o.market, data: encodeFunctionData({ abi: swapAbi, functionName: "deposit", args: [amountToken] }) });
}

/** Perpl top-up for an existing exchange account: approve EXACTLY the amount (skipped when allowance covers it), then depositCollateral. */
export async function perplTopUp(o: { pub: Pick<PublicClient, "readContract">; send: (req: { to: Address; data: `0x${string}`; value: bigint }) => Promise<unknown>; token: Address; exchange: Address; owner: Address; amountCns: bigint }): Promise<void> {
  const allowance = (await o.pub.readContract({ address: o.token, abi: erc20Abi, functionName: "allowance", args: [o.owner, o.exchange] })) as bigint;
  if (needsApprove(allowance, o.amountCns)) await o.send(approveCollateralTx(o.token, o.exchange, o.amountCns));
  await o.send(depositCollateralTx(o.exchange, o.amountCns));
}
