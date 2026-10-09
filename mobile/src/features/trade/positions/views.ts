// Position cards' data (pure): one view per open position from the account reader + the venue's market state.
import { dpOfTick } from "../../../ui/format";
import type { MeridianMarketState } from "../../../live/meridianMarket";
import type { PerplMarketState } from "../../../live/perplMarket";
import type { AccountsState } from "../data/accounts";

export type PositionView = {
  venue: "meridian" | "perpl";
  label: string;
  sizeWad: bigint;
  entryWad: bigint;
  markWad: bigint | undefined;
  pnlWad: bigint;
  /** funding on this position, as PnL (+ = received): Meridian −pendingFunding (accrued, not yet settled), Perpl premiumPnl */
  fundingWad: bigint;
  liqWad: bigint | undefined;
  /** adverse distance to liq, bps of the mark (floored) */
  distanceBps: bigint | undefined;
  priceDp: number;
  stepWad: bigint;
};

/** distance from the mark to the liq price in the adverse direction, bps, floored; 0 at or past it */
export function liqDistance(sizeWad: bigint, markWad: bigint | undefined, liqWad: bigint | undefined): bigint | undefined {
  if (markWad === undefined || markWad <= 0n || liqWad === undefined || liqWad <= 0n) return undefined;
  const d = sizeWad > 0n ? markWad - liqWad : liqWad - markWad;
  return d <= 0n ? 0n : (d * 10_000n) / markWad;
}

export function positionViews(acc: AccountsState | undefined, m: MeridianMarketState | undefined, p: PerplMarketState | undefined): PositionView[] {
  const out: PositionView[] = [];
  const ma = acc?.meridian;
  if (ma && ma.sizeWad !== 0n && m?.lotSizeWad) {
    const liq = ma.liqWad > 0n ? ma.liqWad : undefined;
    out.push({ venue: "meridian", label: "Meridian", sizeWad: ma.sizeWad, entryWad: ma.entryWad, markWad: m.markWad, pnlWad: ma.upnlWad - ma.pendingFundingWad, fundingWad: -ma.pendingFundingWad, liqWad: liq, distanceBps: liqDistance(ma.sizeWad, m.markWad, liq), priceDp: dpOfTick(m.tickSizeWad), stepWad: m.lotSizeWad });
  }
  const pp = acc?.perpl?.position;
  if (pp && p) {
    const signed = pp.side === "Long" ? pp.sizeWad : -pp.sizeWad;
    out.push({ venue: "perpl", label: "Perpl", sizeWad: signed, entryWad: pp.entryWad, markWad: pp.markWad, pnlWad: pp.unrealizedPnlWad, fundingWad: pp.premiumPnlWad, liqWad: pp.liqPriceWad > 0n ? pp.liqPriceWad : undefined, distanceBps: pp.liqDistanceBps, priceDp: p.priceDecimals, stepWad: 10n ** BigInt(18 - p.sizeDecimals) });
  }
  return out;
}

/** Fallback basis grouping: one Meridian and one Perpl position, opposite sides, the same MON size. */
export function isBasisPair(views: readonly PositionView[]): boolean {
  const m = views.find((v) => v.venue === "meridian");
  const p = views.find((v) => v.venue === "perpl");
  return views.length === 2 && m !== undefined && p !== undefined && m.sizeWad === -p.sizeWad;
}
