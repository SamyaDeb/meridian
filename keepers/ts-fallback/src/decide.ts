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

// ───────────────────────────── (c') incremental liquidation scan (Phase 4 step 1) ─────────────────────────────

/** What the keeper remembers from an account's last getAccount read. */
export interface CheckedAccount {
  /** equity − maintenance margin at the read (quote WAD; ≤ 0 ⇒ candidate). */
  headroom: bigint;
  /** |size| at the read (base WAD). */
  absSize: bigint;
  /** CH mark at the read (WAD). */
  markAtRead: bigint;
}

export function checkedFrom(s: AccountSnapshot, markWad: bigint): CheckedAccount {
  return { headroom: s.equity - s.maintenanceMargin, absSize: abs(s.size), markAtRead: markWad };
}

/**
 * Re-read an account only when the mark has moved enough to possibly cross its maintenance line. equity and MM both
 * move with the mark: Δ(equity − MM) ≤ |size|·|Δmark|·(1 + mmr) ≤ 2·|size|·|Δmark| (mmr ≤ 100%); a further ×2 covers
 * funding accrued and rounding between full sweeps. So: re-read iff 4·|size|·|Δmark|/1e18 ≥ headroom.
 */
export function needsRecheck(c: CheckedAccount, markWad: bigint): boolean {
  if (c.headroom <= 0n) return true;
  const move = (c.absSize * absDiff(markWad, c.markAtRead)) / WAD;
  return 4n * move >= c.headroom;
}

export interface AccountsToCheckInput {
  block: bigint;
  /** accounts with a position (from PositionChanged logs) */
  open: ReadonlySet<Address>;
  /** accounts with a PositionChanged since the last check */
  changed: ReadonlySet<Address>;
  /** last read per account (absent ⇒ never read) */
  checked: ReadonlyMap<Address, CheckedAccount>;
  /** current CH mark (WAD) */
  markWad: bigint;
  /** block of the last full sweep, or −1 before the first */
  lastFullSweepBlock: bigint;
  /** full sweep every N blocks (funding accrual moves equity slowly between mark moves) */
  fullSweepEvery: bigint;
  /** an oracle push landed recently: the index moved, the mark follows within blocks ⇒ sweep everything */
  forceFull: boolean;
}

/**
 * Which accounts to read this block. Full sweep: first run, every `fullSweepEvery` blocks, or after an oracle push.
 * Otherwise only open accounts that changed, were never read, or whose mark move could have crossed MM
 * (`needsRecheck`). Replaces "read every open account every block" (Phase 3: the testnet RPC throttled it).
 */
export function accountsToCheck(i: AccountsToCheckInput): { accounts: Address[]; full: boolean } {
  const full = i.forceFull || i.lastFullSweepBlock < 0n || i.block - i.lastFullSweepBlock >= i.fullSweepEvery;
  const accounts = [...i.open].filter((a) => {
    if (full || i.changed.has(a)) return true;
    const c = i.checked.get(a);
    return c === undefined || needsRecheck(c, i.markWad);
  });
  return { accounts, full };
}

/** Sweep everything for `blocks` blocks after an oracle push (the mark follows the index once the MM re-quotes). */
export function forceSweepAfterPush(block: bigint, lastPushBlock: bigint, blocks: bigint): boolean {
  return lastPushBlock >= 0n && block >= lastPushBlock && block - lastPushBlock <= blocks;
}

// ───────────────────────────── (a') funding gap bookkeeping ─────────────────────────────

/**
 * Default `INCLUSION_LAG_BLOCKS` per chain: 6 on Monad testnet (a poke landed 3–4 blocks after the keeper decided on
 * 30 Sep, lag 5 still left one 21-block gap), 2 elsewhere (local 1 s blocks: Phase 3 rehearsal, 0 gaps > 20).
 */
export function defaultInclusionLag(chainId: number): bigint {
  return chainId === 10143 ? 6n : 2n;
}

/**
 * Observed FundingUpdated gaps: `prev` = the last update block known before these logs (−1 = none yet), `blocks` =
 * FundingUpdated block numbers in chain order. Returns the largest gap and the new last block.
 */
export function fundingGaps(prev: bigint, blocks: readonly bigint[]): { maxGap: bigint; last: bigint } {
  let maxGap = 0n;
  let last = prev;
  for (const b of blocks) {
    if (last >= 0n && b > last && b - last > maxGap) maxGap = b - last;
    if (b > last) last = b;
  }
  return { maxGap, last };
}

/**
 * The keeper's own observed max gap in a batch of FundingUpdated blocks: only gaps whose BOTH ends are at/after the
 * keeper's first tick (30 Sep rehearsal: counting history from the initial scan reported 27 while the chain's gaps
 * since start were ≤ 19).
 */
export function observedMaxGap(lastUpdateBlock: bigint, firstTickBlock: bigint, blocks: readonly bigint[]): bigint {
  if (firstTickBlock < 0n) return 0n;
  const prev = lastUpdateBlock >= firstTickBlock ? lastUpdateBlock : -1n;
  return fundingGaps(prev, blocks.filter((b) => b >= firstTickBlock)).maxGap;
}

// ───────────────────────────── (b') keeper-fed source polling ─────────────────────────────

/** Read the external price source at most every `everyMs` (it publishes every 10–30 s; blocks are 0.3–0.4 s). */
export function shouldReadSource(nowMs: number, lastReadMs: number, everyMs: number): boolean {
  return lastReadMs < 0 || nowMs - lastReadMs >= everyMs;
}

// ───────────────────────────── (d) vault ─────────────────────────────

/** IMeridianVault.RebalanceReason names (enum order in the frozen interface). */
export const REBALANCE_REASONS = ["None", "Deploy", "DeltaDrift", "MarginLow", "ExitHedge", "EnterHedge", "Withdraw", "SkewCap"] as const;

/**
 * Check the vault every `everyBlocks` blocks (reads are cheap, but each rebalance moves ≤ one slice, so a tighter
 * cadence only matters for MarginLow, which is checked every block).
 */
export function shouldCheckVault(block: bigint, everyBlocks: bigint, indexMoved = false): boolean {
  // MarginLow can only appear after a price move, so an oracle push also triggers a read (Phase 4: the vault is no
  // longer read every block).
  return indexMoved || everyBlocks <= 1n || block % everyBlocks === 0n;
}

/** Act on any reason but None; MarginLow first-class (perp margin at risk). */
export function vaultAction(reason: number): { act: boolean; name: string; urgent: boolean } {
  const name = REBALANCE_REASONS[reason] ?? `Unknown(${reason})`;
  return { act: reason !== 0, name, urgent: name === "MarginLow" };
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
