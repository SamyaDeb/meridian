// Earn's collateral step (core exec/basis COLLATERAL): before the first leg, each venue must hold its leg's margin + fee.
// Free collateral is re-read NOW on both venues (a quote can be a block old; a top-up that already landed before a retry
// is never repeated). Nothing short ⇒ no prompt. Otherwise ONE fresh passkey prompt (deposits move value, N3) covers
// both top-ups: Meridian = permit/approve + ClearingHouse.deposit (N5 collateral.ts); Perpl = approve exactly +
// depositCollateral on the exchange (core perpl/onboarding tx builders; the account exists: Perpl is READY). Owed
// amounts round UP to whole token units; the venues use different tokens on testnet (each venue's own token).
import { approveCollateralTx, depositCollateralTx } from "@meridian/core/perpl";
import { divCeil } from "@meridian/core/util";
import { erc20Abi, type Address, type LocalAccount, type PublicClient } from "viem";
import { needsApprove } from "../../venues/perpl/amounts";

export type EarnCollateralDeps = {
  freeMeridian: () => Promise<bigint>;
  freePerpl: () => Promise<bigint>;
  withFreshSession: <T>(fn: (account: LocalAccount) => Promise<T>) => Promise<T>;
  /** deposit what Meridian still needs (`needWad`, re-checked inside); returns token units moved */
  depositMeridian: (account: LocalAccount, needWad: bigint) => Promise<unknown>;
  /** top up Perpl by `amountCns` (collateral token units) */
  depositPerpl: (account: LocalAccount, amountCns: bigint) => Promise<void>;
  perplCollateralDecimals: number;
};

export type CollateralTopUp = { meridian: boolean; perplCns: bigint };

/** What each venue still needs; no prompt when both already cover their leg. */
export async function ensureEarnCollateral(d: EarnCollateralDeps, perplWad: bigint, meridianWad: bigint): Promise<CollateralTopUp> {
  const [fm, fp] = await Promise.all([d.freeMeridian(), d.freePerpl()]);
  const meridianShort = meridianWad > fm;
  const perplCns = perplWad > fp ? divCeil(perplWad - fp, 10n ** BigInt(18 - d.perplCollateralDecimals)) : 0n; // owed ⇒ up
  if (!meridianShort && perplCns === 0n) return { meridian: false, perplCns: 0n };
  await d.withFreshSession(async (account) => {
    if (meridianShort) await d.depositMeridian(account, meridianWad);
    if (perplCns > 0n) await d.depositPerpl(account, perplCns);
  });
  return { meridian: meridianShort, perplCns };
}

/** Perpl top-up for an existing exchange account: approve EXACTLY the amount (skipped when allowance covers it), then depositCollateral. */
export async function perplTopUp(o: { pub: Pick<PublicClient, "readContract">; send: (req: { to: Address; data: `0x${string}`; value: bigint }) => Promise<unknown>; token: Address; exchange: Address; owner: Address; amountCns: bigint }): Promise<void> {
  const allowance = (await o.pub.readContract({ address: o.token, abi: erc20Abi, functionName: "allowance", args: [o.owner, o.exchange] })) as bigint;
  if (needsApprove(allowance, o.amountCns)) await o.send(approveCollateralTx(o.token, o.exchange, o.amountCns));
  await o.send(depositCollateralTx(o.exchange, o.amountCns));
}
