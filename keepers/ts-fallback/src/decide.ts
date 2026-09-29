// Pure keeper decisions: no RPC, no clocks, bigint only. Everything here is unit-tested in test/decide.test.ts.
import type { Address } from "viem";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

// ───────────────────────────── (a) funding poke ─────────────────────────────

export interface FundingPokeInput {
  /** Latest block the keeper has seen. */
  currentBlock: bigint;
  /** `fundingState().lastUpdateBlock` (= blockNumber of the last FundingUpdated). */
  lastUpdateBlock: bigint;
  /** Acceptance: FundingUpdated gap ≤ 20 blocks with zero organic traffic (WS-03). */
  maxGapBlocks: bigint;
  /** Blocks between seeing `currentBlock` and our tx landing (1 on Monad: next block). */
  inclusionLagBlocks: bigint;
}

/**
 * Poke `updateFunding()` so the tx lands no later than `lastUpdateBlock + maxGapBlocks`.
 * The funding oracle's O(1) lookups rely on this gap bound (LANE_B §4).
 */
export function shouldPokeFunding(i: FundingPokeInput): boolean {
  if (i.currentBlock < i.lastUpdateBlock) return false; // stale read / reorg: wait for the next block
  return i.currentBlock + i.inclusionLagBlocks - i.lastUpdateBlock >= i.maxGapBlocks;
}

// ───────────────────────────── (b) Pyth push ─────────────────────────────

export interface PricePoint {
  /** Price in WAD (both sides normalised by `pythToWad`). */
  priceWad: bigint;
  /** Unix seconds. */
  publishTime: bigint;
}

export interface PythPushInput {
  nowSec: bigint;
  onchain: PricePoint;
  /** Latest Hermes update; null when Hermes is unavailable (no API key, R24). */
  offchain: PricePoint | null;
  /** Push when the onchain price is strictly older than this (3 s, LANE_B §4). */
  maxAgeSec: bigint;
  /** Push when |off − on| / on is strictly above this many bps (5 bps). */
  maxMoveBps: bigint;
}

export type PythPushReason = "stale" | "moved";

/** Returns why a push is needed, or null. Never pushes an update that is not newer than onchain. */
export function shouldPushPyth(i: PythPushInput): PythPushReason | null {
  if (i.offchain === null || i.offchain.publishTime <= i.onchain.publishTime) return null;
  const age = i.nowSec > i.onchain.publishTime ? i.nowSec - i.onchain.publishTime : 0n;
  if (age > i.maxAgeSec) return "stale";
  if (i.onchain.priceWad <= 0n) return "stale";
  // |off − on| / on > bps / 1e4  ⇔  |off − on| · 1e4 > bps · on  (exact, no division)
  if (absDiff(i.offchain.priceWad, i.onchain.priceWad) * BPS > i.maxMoveBps * i.onchain.priceWad) return "moved";
  return null;
}

/** Pyth (price, expo) → WAD, mirroring PythChainlinkOracleAdapter: expo ∈ [−18, 0], price > 0, else null. */
export function pythToWad(price: bigint, expo: number): bigint | null {
  if (price <= 0n || !Number.isInteger(expo) || expo < -18 || expo > 0) return null;
  return price * 10n ** BigInt(18 + expo);
}

// ───────────────────────────── (c) liquidations ─────────────────────────────

/** Subset of IClearingHouse.AccountView the keeper needs. */
export interface AccountSnapshot {
  account: Address;
  size: bigint;
  equity: bigint;
  maintenanceMargin: bigint;
  liquidatable: boolean;
}

/** Eligibility as the ClearingHouse reports it; a flat account is never eligible. */
export function isLiquidationCandidate(a: AccountSnapshot): boolean {
  return a.size !== 0n && a.liquidatable;
}

/** Shortfall below maintenance margin (quote WAD, ≥ 0). Larger = more urgent. */
export function shortfall(a: AccountSnapshot): bigint {
  return a.equity >= a.maintenanceMargin ? 0n : a.maintenanceMargin - a.equity;
}

/**
 * Eligible accounts, most under water first (ties: larger |size|, then address), capped at `max` per block.
 * `self` (the keeper) is never selected: liquidate() moves the position to msg.sender, so a keeper that
 * inherited an under-margined position would otherwise liquidate itself in a loop.
 */
export function selectLiquidations(accounts: readonly AccountSnapshot[], max: number, self?: Address): AccountSnapshot[] {
  const me = self?.toLowerCase();
  return accounts
    .filter((a) => isLiquidationCandidate(a) && a.account.toLowerCase() !== me)
    .sort((x, y) => cmpDesc(shortfall(x), shortfall(y)) || cmpDesc(abs(x.size), abs(y.size)) || cmpAddr(x, y))
    .slice(0, Math.max(0, max));
}

/** Minimal PositionChanged payload used to track which accounts hold positions. */
export interface PositionChange {
  account: Address;
  newSize: bigint;
}

/**
 * Apply PositionChanged logs (in chain order) to the open-position set. Returns a new set;
 * accounts that went flat are dropped, so the scan stays proportional to open positions.
 */
export function applyPositionChanges(open: ReadonlySet<Address>, changes: readonly PositionChange[]): Set<Address> {
  const next = new Set(open);
  for (const c of changes) {
    const a = c.account.toLowerCase() as Address;
    if (c.newSize === 0n) next.delete(a);
    else next.add(a);
  }
  return next;
}

// ───────────────────────────── gas ─────────────────────────────

/** Monad bills the gas limit (ARCHITECTURE R6): limit = ceil(estimate × 1.2) (CLAUDE.md §7). */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n;
}

/** Split [from, to] into chunks of at most `maxSpan` blocks (public RPCs cap eth_getLogs at 100 blocks, R2). */
export function blockRanges(from: bigint, to: bigint, maxSpan: bigint): Array<[bigint, bigint]> {
  if (maxSpan <= 0n) throw new Error("maxSpan must be > 0");
  const out: Array<[bigint, bigint]> = [];
  for (let s = from; s <= to; s += maxSpan) out.push([s, min(s + maxSpan - 1n, to)]);
  return out;
}

// ───────────────────────────── helpers ─────────────────────────────

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}
function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}
function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function cmpDesc(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? -1 : 1;
}
function cmpAddr(x: AccountSnapshot, y: AccountSnapshot): number {
  const a = x.account.toLowerCase();
  const b = y.account.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}
