// Liquidation-distance view (Rates & Risk, WIN_PLAN T8): how far the mark must move before each open position hits
// its (isolated, funding-free) liquidation price, bucketed. bigint until the bucket index.
import { liquidationPriceWad } from "./math";

export type OpenPos = { size: bigint; entryPrice: bigint; collateralWad: bigint };

/** Distance in bps of the mark to the liquidation price, in the adverse direction (≥ 0); undefined if never liquidatable. */
export function liqDistanceBps(p: OpenPos, markWad: bigint, mmrWad: bigint): bigint | undefined {
  if (p.size === 0n || markWad <= 0n) return undefined;
  const liq = liquidationPriceWad(p.entryPrice, p.collateralWad, p.size, mmrWad);
  if (liq === undefined) return undefined;
  const d = p.size > 0n ? markWad - liq : liq - markWad; // long: falls to liq; short: rises to liq
  return d <= 0n ? 0n : (d * 10_000n) / markWad;
}

/** Buckets (upper bounds in bps): ≤ 2 %, 5 %, 10 %, 20 %, 50 %, > 50 %, plus "never". Counts and base size per bucket. */
export const BUCKETS = [200n, 500n, 1_000n, 2_000n, 5_000n] as const;
export function histogram(ps: readonly OpenPos[], markWad: bigint, mmrWad: bigint) {
  const rows = [...BUCKETS.map((b) => ({ label: `≤ ${Number(b) / 100}%`, count: 0, sizeWad: 0n })), { label: "> 50%", count: 0, sizeWad: 0n }, { label: "never (over-collateralized)", count: 0, sizeWad: 0n }];
  for (const p of ps) {
    if (p.size === 0n) continue;
    const d = liqDistanceBps(p, markWad, mmrWad);
    const i = d === undefined ? rows.length - 1 : BUCKETS.findIndex((b) => d <= b);
    const row = rows[i === -1 ? BUCKETS.length : i]!;
    row.count += 1;
    row.sizeWad += p.size < 0n ? -p.size : p.size;
  }
  return rows;
}
