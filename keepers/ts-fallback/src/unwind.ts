// H-1 (audit): the liquidator takes the whole position (IClearingHouse.liquidate moves it to msg.sender at the mark),
// so the keeper must (1) size every liquidation to what it can absorb (ClearingHouse.liquidate reverts
// PositionCapExceeded / InsufficientMargin otherwise) and (2) close what it inherited with a reduce-only IOC market
// order. Pure decisions, bigint only; unit-tested in test/unwind.test.ts. RPC wiring lives in main.ts.
import { WAD, BPS } from "./decide.js";

// ───────────────────────────── sizing (before liquidate) ─────────────────────────────

export interface HeadroomInput {
  /** Keeper's signed position in this market (getAccount.size). */
  keeperSize: bigint;
  /** Keeper's equity at the mark, funding settled (getAccount.equity). */
  keeperEquity: bigint;
  /** Keeper's reserved order margin (getAccount.reservedOrderMargin). */
  keeperReserved: bigint;
  /** Liquidatee's signed size: the keeper takes this direction. */
  targetSize: bigint;
  markWad: bigint;
  /** riskParams().imr */
  imr: bigint;
  /** riskParams().maxPositionSize */
  maxPositionSize: bigint;
  /** OrderBook.lotSize(): the take is floored to whole lots so the keeper can unwind all of it. */
  lotSize: bigint;
  /** Safety margin on the IM capacity (mark drift between read and inclusion, IM rounding), e.g. 200 = 2%. */
  bufferBps: bigint;
}

export type HeadroomResult =
  | { size: bigint; limitedBy: "position" | "cap" | "margin" }
  | { size: 0n; limitedBy: "no-headroom"; reason: string };

/**
 * Largest lot-aligned x ≤ |targetSize| such that ClearingHouse.liquidate does not revert for the keeper's own limits:
 *   s' = keeperSize + sign(target)·x;  if s' increases |keeper|: |s'| ≤ maxPositionSize;  equity ≥ |s'|·mark·imr + reserved.
 * Equity is unchanged by a take at the mark (the keeper reward only adds), so the IM bound is |s'| ≤ A with
 * A = (equity − reserved)·(1 − buffer) / (mark·imr), rounded down. With q = keeper size in the take direction:
 *   q ≥ 0 (flat or same side): x ≤ min(cap, A) − q
 *   q < 0 (opposite side):     |q| − A ≤ x ≤ |q| + min(cap, A)   (reducing helps; flipping is capped)
 */
export function liquidationHeadroom(i: HeadroomInput): HeadroomResult {
  const want = abs(i.targetSize);
  if (want === 0n || i.lotSize <= 0n) return { size: 0n, limitedBy: "no-headroom", reason: "nothing to take" };
  if (i.markWad <= 0n || i.imr <= 0n) return { size: 0n, limitedBy: "no-headroom", reason: "no mark / imr" };
  const free = i.keeperEquity - i.keeperReserved;
  // A = ⌊free·(1 − buffer) / (mark·imr)⌋ in base WAD (mark·imr rounded up ⇒ A rounds down: against the keeper)
  const perUnitIm = ceilDiv(i.markWad * i.imr, WAD); // WAD per 1e18 base
  const a = free <= 0n ? 0n : (free * (BPS - i.bufferBps) * WAD) / (BPS * perUnitIm);
  const dir = i.targetSize > 0n ? 1n : -1n;
  const q = i.keeperSize * dir;
  const capOrIm = min(i.maxPositionSize, a);
  let hi: bigint;
  let lo = 0n;
  if (q >= 0n) {
    hi = capOrIm > q ? capOrIm - q : 0n;
  } else {
    hi = -q + capOrIm;
    lo = -q > a ? -q - a : 0n;
  }
  let x = floorTo(min(hi, want), i.lotSize);
  if (x < lo) x = 0n;
  if (x === 0n) {
    const why = q >= 0n && i.maxPositionSize <= q ? "position cap" : "margin";
    return { size: 0n, limitedBy: "no-headroom", reason: `keeper ${why}: |q| ${abs(q)}, cap ${i.maxPositionSize}, IM capacity ${a}` };
  }
  if (x === floorTo(want, i.lotSize)) return { size: x, limitedBy: "position" };
  return { size: x, limitedBy: i.maxPositionSize <= a ? "cap" : "margin" };
}

/**
 * Funding-swap liquidation: the position-cap part of the same rule (FundingSwapMarket.liquidate reverts
 * PositionCapExceeded past maxPositionSize). Swap IM is not linear in one price (MATH_SPEC §6), so the IM part stays with
 * the estimate: a take the keeper can't margin reverts in eth_estimateGas and nothing is sent.
 */
export function capHeadroom(keeperSize: bigint, targetSize: bigint, maxPositionSize: bigint, lotSize: bigint, maxSize: bigint): bigint {
  const want = min(abs(targetSize), maxSize);
  const q = keeperSize * (targetSize > 0n ? 1n : -1n);
  const hi = q >= 0n ? (maxPositionSize > q ? maxPositionSize - q : 0n) : -q + maxPositionSize;
  return floorTo(min(hi, want), lotSize);
}

/** Does the book hold the other side of an IOC? (OrderBook: bestBid 0 = no bid, bestAsk type(uint32).max = no ask.) */
export function bookHasCounterparty(isBid: boolean, bestBid: bigint, bestAsk: bigint): boolean {
  return isBid ? bestAsk !== 0xffff_ffffn : bestBid !== 0n;
}

/** The keeper's size after a take of `x` in the direction of `targetSize` (for several liquidations in one tick). */
export function sizeAfterTake(keeperSize: bigint, targetSize: bigint, x: bigint): bigint {
  return keeperSize + (targetSize > 0n ? x : -x);
}

// ───────────────────────────── unwind (after liquidate) ─────────────────────────────

export interface UnwindInput {
  keeperSize: bigint;
  lotSize: bigint;
  tickSize: bigint;
  /** IOracleAdapter.tryGetIndexPrice(): ok = fresh. */
  indexOk: boolean;
  indexWad: bigint;
  /** Worst price vs index, e.g. 100 = 1%. */
  maxSlippageBps: bigint;
}

export type UnwindPlan =
  | { kind: "none" }
  | { kind: "wait"; reason: "stale-oracle" | "dust" }
  | { kind: "order"; isBid: boolean; lots: bigint; limitTick: bigint };

/**
 * Reduce-only IOC that closes the keeper's position: buy back a short / sell a long, all whole lots, limit tick bounded at
 * index ± maxSlippage (price = tick · tickSize; a bid's worst price is floored, an ask's ceiled, so the bound is never
 * looser than asked). A stale oracle ⇒ wait: trading against it reverts, and pricing the bound off it is wrong.
 */
export function unwindPlan(i: UnwindInput): UnwindPlan {
  if (i.keeperSize === 0n) return { kind: "none" };
  const lots = abs(i.keeperSize) / i.lotSize;
  if (lots === 0n) return { kind: "wait", reason: "dust" }; // < 1 lot: can't be traded, nothing at risk worth a tx
  if (!i.indexOk || i.indexWad <= 0n) return { kind: "wait", reason: "stale-oracle" };
  const isBid = i.keeperSize < 0n;
  let limitTick: bigint;
  if (isBid) {
    const worst = (i.indexWad * (BPS + i.maxSlippageBps)) / BPS; // rounds down: tighter
    limitTick = worst / i.tickSize;
  } else {
    const worst = ceilDiv(i.indexWad * (BPS - i.maxSlippageBps), BPS); // rounds up: tighter
    limitTick = ceilDiv(worst, i.tickSize);
  }
  if (limitTick <= 0n || limitTick > 0xffff_ffffn) return { kind: "wait", reason: "stale-oracle" };
  return { kind: "order", isBid, lots, limitTick };
}

/** Unwind gas limit: estimate × 1.2 (rounded up) + TOUCH_ALLOWANCE_GAS (a `latest` estimate misses the block's first funding touch). */
export function unwindGasLimit(estimate: bigint, touchAllowanceGas: bigint): bigint {
  return (estimate * 12n + 9n) / 10n + touchAllowanceGas;
}

// ───────────────────────────── tracker (retries + paging) ─────────────────────────────

export interface UnwindPageRule {
  maxFailures: number; // 3
  maxHoldBlocks: bigint; // UNWIND_PAGE_AFTER_BLOCKS, 200
}

/**
 * Keeper position bookkeeping across ticks: since when it holds a position, consecutive failed unwinds, and whether to
 * page. A partial fill is progress (failures reset); a fill of 0 lots, an estimate revert or a reverted tx is a failure.
 * Waiting on a stale oracle is neither (the hold timer still runs, so a long stale period pages through it).
 */
export class UnwindTracker {
  holdingSince: bigint | null = null;
  consecutiveFailures = 0;
  totalFailures = 0;
  unwinds = 0;
  lastWait: string | null = null;

  constructor(private readonly rule: UnwindPageRule) {}

  observe(block: bigint, keeperSize: bigint, lotSize: bigint): void {
    const holding = abs(keeperSize) >= lotSize && keeperSize !== 0n;
    if (!holding) {
      this.holdingSince = null;
      this.consecutiveFailures = 0;
      this.lastWait = null;
    } else if (this.holdingSince === null) {
      this.holdingSince = block;
    }
  }

  filled(lots: bigint): void {
    if (lots > 0n) {
      this.unwinds++;
      this.consecutiveFailures = 0;
      this.lastWait = null;
    } else this.failed();
  }

  failed(): void {
    this.consecutiveFailures++;
    this.totalFailures++;
  }

  waiting(reason: string): void {
    this.lastWait = reason;
  }

  get pending(): boolean {
    return this.holdingSince !== null;
  }

  /** Why to page now, or null. */
  page(block: bigint): string | null {
    if (this.consecutiveFailures >= this.rule.maxFailures) return `${this.consecutiveFailures} consecutive failed unwinds`;
    if (this.holdingSince !== null && block - this.holdingSince > this.rule.maxHoldBlocks) {
      return `keeper has held a position for ${block - this.holdingSince} blocks (> ${this.rule.maxHoldBlocks})${this.lastWait ? `, waiting: ${this.lastWait}` : ""}`;
    }
    return null;
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}
function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
function floorTo(x: bigint, step: bigint): bigint {
  return (x / step) * step;
}
