// Order-entry helpers (bigint only). Price = tick · tickSize (WAD), size = lots · lotSize (base WAD).

/** tick → price (WAD). */
export const tickToPrice = (tick: number, tickSize: bigint): bigint => BigInt(tick) * tickSize;

/** price → tick: a bid rounds down, an ask rounds up, so the order is never worse than the price asked. */
export function priceToTick(priceWad: bigint, tickSize: bigint, side: "bid" | "ask"): number {
  const t = side === "bid" ? priceWad / tickSize : (priceWad + tickSize - 1n) / tickSize;
  if (t < 1n || t > 16_777_215n) throw new RangeError("price outside the tick range");
  return Number(t);
}

/** size (base WAD) → whole lots, rounding down. */
export const lotsForSize = (sizeWad: bigint, lotSize: bigint): bigint => sizeWad / lotSize;

/** Worst acceptable tick for a market order: mark ± slippageBps (buy ↑, sell ↓). */
export function marketLimitTick(markWad: bigint, tickSize: bigint, isBid: boolean, slippageBps: number): number {
  const bps = BigInt(slippageBps);
  const limit = isBid ? (markWad * (10_000n + bps)) / 10_000n : (markWad * (10_000n - bps)) / 10_000n;
  return priceToTick(limit, tickSize, isBid ? "ask" : "bid");
}

/** Closing = reduce-only market order on the opposite side for the whole position. */
export function closeOrder(sizeWad: bigint, lotSize: bigint): { isBid: boolean; lots: bigint; reduceOnly: true } | undefined {
  if (sizeWad === 0n) return undefined;
  const abs = sizeWad < 0n ? -sizeWad : sizeWad;
  return { isBid: sizeWad < 0n, lots: abs / lotSize, reduceOnly: true };
}
