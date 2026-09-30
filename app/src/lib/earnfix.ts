// Pure helpers for the Earn (vault) and Fix (funding swap) screens. bigint only; unit-tested in earnfix.test.ts.
// Numbers mirror the contracts: PulseVault.previewRedeem (5 bps fee ↑, retained), _ensureIdle (idle first, else a
// pro-rata unwind), FundingSwapMarket prices (p = 1 + APR, tick 1e14 = 1 bp APR), MATH_SPEC §6.
import type { Address, RebalanceReason, SwapPosition, VaultSnapshot } from "@/data/types";
import { isLockedSpread } from "./math";

export const WAD = 10n ** 18n;
/** PulseVault.WITHDRAW_FEE (MATH_SPEC §5.3): 5 bps, stays in the vault for the remaining holders. */
export const VAULT_WITHDRAW_FEE_WAD = 500_000_000_000_000n;

export const REBALANCE_REASONS: readonly RebalanceReason[] = ["None", "Deploy", "DeltaDrift", "MarginLow", "ExitHedge", "EnterHedge", "Withdraw", "SkewCap"];

/** Fee on `assetsToken` (6 dp), rounded up like previewRedeem: ⌈assets · 5e14 / 1e18⌉. */
export function vaultWithdrawFeeToken(assetsToken: bigint): bigint {
  return (assetsToken * VAULT_WITHDRAW_FEE_WAD + WAD - 1n) / WAD;
}

/**
 * Which path a withdrawal of `assetsToken` takes: "idle" when the vault holds enough idle AUSD (no trade, fee only);
 * "unwind" otherwise: a bounded pro-rata unwind of both legs whose measured NAV cost the withdrawer pays on top.
 */
export function vaultWithdrawPath(idleToken: bigint, assetsToken: bigint): "idle" | "unwind" {
  return idleToken >= assetsToken ? "idle" : "unwind";
}

/**
 * Headline state for Earn (PRD US6): "hedged" (earning), "rebalancing" (the keeper has something to do), or
 * "waiting" (not hedged and nothing to do ⇒ the 8 h funding entry rule is off: "waiting for funding").
 */
export function vaultStatus(hedged: boolean, needsRebalance: number): "hedged" | "rebalancing" | "waiting" {
  if (hedged) return needsRebalance === 0 ? "hedged" : "rebalancing";
  return needsRebalance === 0 ? "waiting" : "rebalancing";
}

/** APR (WAD) → swap-book tick. A long (buy) never pays more than the typed APR ⇒ floor; a short (sell) ⇒ ceil. */
export function swapAprToTick(aprWad: bigint, tickSize: bigint, isBid: boolean): number {
  const price = WAD + aprWad;
  if (price <= 0n) throw new Error("APR must be above −100%");
  return Number(isBid ? price / tickSize : (price + tickSize - 1n) / tickSize);
}

export const swapTickToAprWad = (tick: number, tickSize: bigint): bigint => BigInt(tick) * tickSize - WAD;

/**
 * Limit tick for a market order: `slippageTicks` beyond the opposite best (a buy may lift up to bestAsk + slip). With
 * no opposite liquidity there is nothing to take ⇒ null (the UI disables the button).
 */
export function marketLimitTick(isBid: boolean, bestOpposite: number | undefined, slippageTicks: number): number | null {
  if (bestOpposite === undefined || bestOpposite <= 0) return null;
  return isBid ? bestOpposite + slippageTicks : Math.max(1, bestOpposite - slippageTicks);
}

/** Whole lots for a notional in MON (WAD), floored; 0 if below one lot. */
export function lotsFor(notionalWad: bigint, lotSize: bigint): bigint {
  return lotSize > 0n ? notionalWad / lotSize : 0n;
}

/** Close = a reduce-only market order on the opposite side for the whole size (MATH_SPEC §6.2: K stays as is). */
export function closeOrder(size: bigint, lotSize: bigint): { isBid: boolean; lots: bigint } | null {
  if (size === 0n || lotSize === 0n) return null;
  const abs = size < 0n ? -size : size;
  return { isBid: size < 0n, lots: (abs + lotSize - 1n) / lotSize };
}

/** NavSnapshot logs (chain order) → VaultSnapshot rows (the indexer's shape), newest first. */
export function snapshotsFromLogs(
  vault: Address,
  logs: ReadonlyArray<{ blockNumber: bigint; logIndex: number; args: { nav: bigint; totalShares: bigint; sharePriceWad: bigint; fundingAccruedWad: bigint } }>,
  timestampOf: (block: bigint) => bigint,
): VaultSnapshot[] {
  return logs
    .map((l) => ({
      id: `${vault}-${l.blockNumber}-${l.logIndex}`,
      vault_id: vault,
      navToken: l.args.nav,
      totalShares: l.args.totalShares,
      sharePriceWad: l.args.sharePriceWad,
      fundingAccruedWad: l.args.fundingAccruedWad,
      block: l.blockNumber,
      timestamp: timestampOf(l.blockNumber),
    }))
    .reverse();
}

/** getPosition + getAccount views → the SwapPosition row the Fix screen renders (indexer shape). */
export function swapPositionFromViews(
  market: Address,
  account: Address,
  p: { size: bigint; fixedAprNotional: bigint },
  v: { collateral: bigint; avgFixedApr: bigint; accruedNet: bigint },
  block: bigint,
): SwapPosition {
  return {
    id: `${market}-${account}`,
    swapMarket: market,
    account_id: account,
    size: p.size,
    fixedAprNotional: p.fixedAprNotional,
    ...(p.size !== 0n ? { avgFixedAprWad: v.avgFixedApr } : {}),
    lockedSpread: isLockedSpread(p.size, p.fixedAprNotional),
    collateralWad: v.collateral,
    floatingReceived: 0n,
    fixedPaid: 0n,
    netAccrued: v.accruedNet, // unsettled floating − fixed (the contract's one-division preview, MATH_SPEC §6.2)
    realizedPnl: 0n,
    feesPaid: 0n,
    liquidationCount: 0,
    updatedBlock: block,
  };
}
