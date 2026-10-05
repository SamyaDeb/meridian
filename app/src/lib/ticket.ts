// Order-ticket math (FRONTEND_TRADE_PLAN §6.3). bigint only. Rounding follows CLAUDE.md §2: amounts the user owes
// (margin, fees, funding they pay) round up; amounts they receive round down; protective bounds round in the user's
// favour. Each formula names its MATH_SPEC section.
import type { AccountSummary, DepthLevel } from "@/data/types";
import { divCeil, divFloor, abs, liquidationPriceWad } from "./math";
import { WAD } from "./units";

// ─── flags (IOrderBook: FLAG_POST_ONLY = 1, FLAG_IOC = 2, FLAG_REDUCE_ONLY = 4) ───
export const FLAG_POST_ONLY = 1;
export const FLAG_IOC = 2;
export const FLAG_REDUCE_ONLY = 4;

export type FlagOpts = { postOnly?: boolean; ioc?: boolean; reduceOnly?: boolean };

/** Bitmask for placeLimitOrder / replaceOrder. Post-only + IOC is contradictory (would never rest nor take): throws. */
export function orderFlags(o: FlagOpts): number {
  if (o.postOnly && o.ioc) throw new RangeError("Post-only and IOC can't be combined");
  return (o.postOnly ? FLAG_POST_ONLY : 0) | (o.ioc ? FLAG_IOC : 0) | (o.reduceOnly ? FLAG_REDUCE_ONLY : 0);
}
export const decodeFlags = (f: number): Required<FlagOpts> => ({
  postOnly: (f & FLAG_POST_ONLY) !== 0,
  ioc: (f & FLAG_IOC) !== 0,
  reduceOnly: (f & FLAG_REDUCE_ONLY) !== 0,
});

// ─── size ───
/** Size input → whole lots, rounding down (never trades more than typed). AUSD input divides by the price. */
export function lotsFromInput(amount: bigint, unit: "MON" | "AUSD", priceWad: bigint, lotSize: bigint): bigint {
  if (amount <= 0n || lotSize <= 0n) return 0n;
  const base = unit === "MON" ? amount : priceWad > 0n ? (amount * WAD) / priceWad : 0n;
  return base / lotSize;
}

/** IM the contract charges for `lots` at `priceWad`: ceil(ceil(size·P)·imr) (MATH_SPEC §3.2 reserve ↑). */
export const imForLots = (lots: bigint, lotSize: bigint, priceWad: bigint, imrWad: bigint): bigint =>
  divCeil(divCeil(lots * lotSize * priceWad, WAD) * imrWad, WAD);

/**
 * Lots for "pct % of available": the largest whole lot count whose IM (↑) fits pct % of free collateral and whose
 * notional fits pct % of free · leverage. Floor everywhere, then a bounded correction for the IM round-up.
 */
export function lotsForPercent(freeCollateralWad: bigint, leverage: bigint, imrWad: bigint, priceWad: bigint, pct: bigint, lotSize: bigint): bigint {
  if (freeCollateralWad <= 0n || priceWad <= 0n || pct <= 0n || lotSize <= 0n || imrWad <= 0n || leverage <= 0n) return 0n;
  const budget = (freeCollateralWad * (pct > 100n ? 100n : pct)) / 100n;
  const byLeverage = (budget * leverage * WAD) / priceWad / lotSize;
  const byMargin = (budget * WAD * WAD) / imrWad / priceWad / lotSize;
  let lots = byLeverage < byMargin ? byLeverage : byMargin;
  for (let i = 0; i < 3 && lots > 0n && imForLots(lots, lotSize, priceWad, imrWad) > budget; i++) lots -= 1n;
  return lots;
}

// ─── price / slippage ───
/** Reference for a market order: buys sweep asks, sells sweep bids; mark when that side is empty. */
export const referencePrice = (isBid: boolean, bestBid: bigint | undefined, bestAsk: bigint | undefined, markWad: bigint): bigint =>
  (isBid ? bestAsk : bestBid) ?? markWad;

/**
 * Worst acceptable tick for placeMarketOrder: ref·(1 ± bps). The bound protects the user, so it rounds in their
 * favour: a buy's ceiling floors to a tick, a sell's floor ceils to a tick. Throws outside the uint24 tick range.
 */
export function slippageLimitTick(refPriceWad: bigint, tickSize: bigint, isBid: boolean, slippageBps: bigint): number {
  if (slippageBps < 0n || slippageBps >= 10_000n) throw new RangeError("slippage must be in [0, 100%)");
  const t = isBid
    ? (refPriceWad * (10_000n + slippageBps)) / (10_000n * tickSize) // buy ceiling, floored to a tick
    : divCeil(refPriceWad * (10_000n - slippageBps), 10_000n * tickSize); // sell floor, ceiled to a tick
  if (t < 1n || t > 16_777_215n) throw new RangeError("price outside the tick range");
  return Number(t);
}

/** minFilledLots: all-or-revert by default (SlippageExceeded if the book can't fill it inside the bound), 1 for partial. */
export const minFilledLotsFor = (lots: bigint, allowPartial: boolean): bigint => (allowPartial ? (lots > 0n ? 1n : 0n) : lots);

export type FillEstimate = { filledLots: bigint; avgPriceWad: bigint; worstPriceWad: bigint; notionalWad: bigint };
/**
 * Sweep of the visible book (best first) up to `lots` and `limitPriceWad`. Average price rounds against the user
 * (buy ↑, sell ↓). Visible depth only: the book can change before the tx lands.
 */
export function estimateFill(levels: readonly DepthLevel[], lots: bigint, lotSize: bigint, isBid: boolean, limitPriceWad: bigint): FillEstimate {
  let left = lots;
  let filled = 0n;
  let notional = 0n; // Σ lots·lot·price / 1e18, exact sum then one rounding below
  let worst = 0n;
  for (const l of levels) {
    if (left === 0n) break;
    if (isBid ? l.priceWad > limitPriceWad : l.priceWad < limitPriceWad) break;
    const avail = l.sizeWad / lotSize;
    const take = avail < left ? avail : left;
    if (take === 0n) continue;
    filled += take;
    left -= take;
    notional += take * lotSize * l.priceWad;
    worst = l.priceWad;
  }
  const sizeWad = filled * lotSize;
  return {
    filledLots: filled,
    avgPriceWad: sizeWad === 0n ? 0n : isBid ? divCeil(notional, sizeWad) : notional / sizeWad,
    worstPriceWad: worst,
    notionalWad: isBid ? divCeil(notional, WAD) : notional / WAD,
  };
}

/** Post-only pre-check (the contract reverts PostOnlyWouldCross): a bid at/above the best ask, an ask at/below the best bid. */
export const postOnlyWouldCross = (isBid: boolean, priceWad: bigint, bestBid: bigint | undefined, bestAsk: bigint | undefined): boolean =>
  isBid ? bestAsk !== undefined && priceWad >= bestAsk : bestBid !== undefined && priceWad <= bestBid;

/** Reduce-only must shrink: opposite side of an open position; size clamped to it (lots, floor). */
export function reduceOnlyLots(positionSizeWad: bigint, isBid: boolean, lots: bigint, lotSize: bigint): bigint {
  if (positionSizeWad === 0n || (positionSizeWad > 0n) === isBid) return 0n;
  const max = abs(positionSizeWad) / lotSize;
  return lots < max ? lots : max;
}

// ─── position after a fill (MATH_SPEC §3.1) ───
export type Pos = { size: bigint; openNotional: bigint; collateral: bigint };

/**
 * Applies a fill of Δq at P with fee rate f. Decrease: released = ON·c/|q| rounded toward +∞; realized = sign(q)·c·P − released
 * (↓). Fee = |Δq|·P·f ↑ for f ≥ 0; a rebate (f < 0) rounds toward zero (user receives less).
 */
export function applyFill(p: Pos, dq: bigint, priceWad: bigint, feeRateWad: bigint): Pos & { realizedPnl: bigint; fee: bigint } {
  const gross = abs(dq) * priceWad; // WAD²
  const fee = feeRateWad >= 0n ? divCeil(divCeil(gross, WAD) * feeRateWad, WAD) : -((gross / WAD) * -feeRateWad / WAD);
  let { size: q, openNotional: on } = p;
  let realized = 0n;
  if (q === 0n || (q > 0n) === (dq > 0n)) {
    on += divFloor(dq * priceWad, WAD); // ON += Δq·P (§3.1, neutral: lot·tick products are exact at WAD)
    q += dq;
  } else {
    const c = abs(dq) < abs(q) ? abs(dq) : abs(q);
    const released = divCeil(on * c, abs(q)); // toward +∞
    const sign = q > 0n ? 1n : -1n;
    realized = divFloor(sign * c * priceWad, WAD) - released;
    on -= released;
    q += -sign * c;
    const rest = abs(dq) - c;
    if (rest > 0n) {
      const d = dq > 0n ? rest : -rest;
      on += divFloor(d * priceWad, WAD);
      q += d;
    }
  }
  return { size: q, openNotional: on, collateral: p.collateral + realized - fee, realizedPnl: realized, fee };
}

// ─── preview ───
export type PreviewInput = {
  account: AccountSummary | undefined;
  isBid: boolean;
  lots: bigint;
  lotSize: bigint;
  /** expected fill price (market: sweep average; limit: the limit price) */
  priceWad: bigint;
  markWad: bigint;
  indexWad: bigint;
  /** current funding rate, per-second WAD (+ = longs pay) */
  ratePerSecondWad: bigint;
  blockTimeMs: bigint;
  imrWad: bigint;
  mmrWad: bigint;
  feeRateWad: bigint;
};
export type Preview = {
  sizeWad: bigint;
  notionalWad: bigint;
  /** initial margin this order adds, MATH_SPEC §3.2 reserve ↑ */
  marginWad: bigint;
  /** + = paid, − = rebate */
  feeWad: bigint;
  /** resulting position */
  newSizeWad: bigint;
  entryWad: bigint;
  /** isolated estimate ignoring funding; undefined if flat or never liquidatable */
  liqPriceWad: bigint | undefined;
  /** funding the resulting position pays (+) or earns (−) per block at the current rate, ↑ */
  fundingPerBlockWad: bigint;
};

/** Live ticket preview. Uses the account's current position (entry · size as open notional) and collateral. */
export function previewOrder(i: PreviewInput): Preview {
  const sizeWad = i.lots * i.lotSize;
  const dq = i.isBid ? sizeWad : -sizeWad;
  const cur: Pos = i.account
    ? { size: i.account.size, openNotional: divFloor(i.account.size * i.account.entryPrice, WAD), collateral: i.account.collateral }
    : { size: 0n, openNotional: 0n, collateral: 0n };
  const next = applyFill(cur, dq, i.priceWad, i.feeRateWad);
  const entry = next.size === 0n ? 0n : (abs(next.openNotional) * WAD) / abs(next.size); // display, rounds down
  // ΔF per block = r·I·dtMs / (1e18·1000) (MATH_SPEC §1.2); owed = ceil(q·ΔF/1e18) (§1.4)
  const dF = (i.ratePerSecondWad * i.indexWad * i.blockTimeMs) / (WAD * 1_000n);
  return {
    sizeWad,
    notionalWad: divCeil(sizeWad * i.priceWad, WAD),
    marginWad: divCeil(divCeil(sizeWad * i.priceWad, WAD) * i.imrWad, WAD),
    feeWad: next.fee,
    newSizeWad: next.size,
    entryWad: entry,
    liqPriceWad: next.size === 0n ? undefined : liquidationPriceWad(entry, next.collateral > 0n ? next.collateral : 0n, next.size, i.mmrWad),
    fundingPerBlockWad: divCeil(next.size * dF, WAD),
  };
}

/** Splits ids into batches of at most `size` (cancelOrders reverts BatchTooLarge above MAX_BATCH). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Lots to close for `pct` % of a position (floor; 100 % = the whole position). */
export const closeLots = (positionSizeWad: bigint, lotSize: bigint, pct: bigint): bigint => ((abs(positionSizeWad) / lotSize) * (pct > 100n ? 100n : pct)) / 100n;
