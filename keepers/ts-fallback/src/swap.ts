// Pure funding-swap keeper decisions (Phase 4 step 2). No RPC, bigint only; unit-tested in test/swap.test.ts.
import type { Address } from "viem";

/** Subset of IFundingSwapMarket.SwapAccountView the keeper needs. */
export interface SwapSnapshot {
  account: Address;
  size: bigint;
  /** V: value of the remaining stream at markApr (≠ 0 for a q = 0 locked-spread account while τ > 0) */
  unrealizedPnl: bigint;
  equity: bigint;
  maintenanceMargin: bigint;
  liquidatable: boolean;
}

/**
 * Eligible swap accounts, most under water first (ties: larger |size|, then address), at most `max`, never the keeper.
 * Unlike the perp, a flat account (size 0) can still be eligible: a locked-spread stream (K ≠ 0) with negative value
 * has a price-shock MM (MATH_SPEC §6.4), and `liquidate` then takes all of K.
 */
export function swapLiquidationCandidates(accounts: readonly SwapSnapshot[], max: number, self?: Address): SwapSnapshot[] {
  const me = self?.toLowerCase();
  const short = (a: SwapSnapshot) => (a.equity >= a.maintenanceMargin ? 0n : a.maintenanceMargin - a.equity);
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const desc = (x: bigint, y: bigint) => (x === y ? 0 : x > y ? -1 : 1);
  return accounts
    .filter((a) => a.liquidatable && a.account.toLowerCase() !== me)
    .sort((x, y) => desc(short(x), short(y)) || desc(abs(x.size), abs(y.size)) || (x.account.toLowerCase() < y.account.toLowerCase() ? -1 : 1))
    .slice(0, Math.max(0, max));
}

/**
 * An account stops being tracked only when it carries nothing: size 0 and no stream value (K = 0, or matured so V = 0).
 * `SwapPositionChanged.newSize == 0` alone is not enough (a closed long at a different APR keeps a K ≠ 0 stream).
 */
export function swapAccountIsInert(s: Pick<SwapSnapshot, "size" | "unrealizedPnl" | "maintenanceMargin">): boolean {
  return s.size === 0n && s.unrealizedPnl === 0n && s.maintenanceMargin === 0n;
}

export interface SettleMaturityInput {
  /** latest block timestamp (s) */
  nowSec: bigint;
  /** FundingSwapMarket.maturity() */
  maturity: bigint;
  /** FundingSwapMarket.maturitySnapshot().snapped — the snapshot may also be taken lazily by any touch at/after maturity */
  snapped: boolean;
  /** a settleMaturity tx of ours is in flight or landed and its effect not yet read */
  pending: boolean;
}

/**
 * Call `settleMaturity()` exactly once: at/after maturity, while no snapshot exists and none of ours is pending.
 * (`isMatured()` is `block.timestamp ≥ maturity`, true before any snapshot, so it can't be the "done" signal.)
 */
export function shouldSettleMaturity(i: SettleMaturityInput): boolean {
  return i.nowSec >= i.maturity && !i.snapped && !i.pending;
}

export interface SwapAccountsToCheckInput {
  block: bigint;
  /** accounts with any SwapPositionChanged not yet proven inert */
  tracked: ReadonlySet<Address>;
  /** accounts with a SwapPositionChanged since the last check */
  changed: ReadonlySet<Address>;
  /** accounts that were eligible (or under MM) at their last read: re-read every block until liquidated */
  hot: ReadonlySet<Address>;
  lastFullBlock: bigint;
  /** full read every N blocks: swap equity drifts with funding (per block, bounded by cap/δ) and markApr */
  fullEvery: bigint;
}

/**
 * Swap equity moves slowly and boundedly (|r| ≤ cap, Δr ≤ δ per block; MATH_SPEC §6.4 margins 24 h of worst case),
 * so a full read every N blocks plus every block for changed / hot accounts keeps latency ≤ 3 blocks for anything
 * the last read saw near its maintenance line.
 */
export function swapAccountsToCheck(i: SwapAccountsToCheckInput): { accounts: Address[]; full: boolean } {
  const full = i.lastFullBlock < 0n || i.block - i.lastFullBlock >= i.fullEvery;
  return { accounts: [...i.tracked].filter((a) => full || i.changed.has(a) || i.hot.has(a)), full };
}

/** "Hot" = eligible, or within 2× maintenance margin (re-read every block). */
export function swapIsHot(s: Pick<SwapSnapshot, "equity" | "maintenanceMargin" | "liquidatable">): boolean {
  return s.liquidatable || (s.maintenanceMargin > 0n && s.equity < 2n * s.maintenanceMargin);
}
