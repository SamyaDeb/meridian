// Account overlay for the price chart: entry, liquidation (warn), resting orders. Pure, from the same live data the
// positions card shows, so the lines always match the table.
import type { AccountSummary } from "@/data/types";
import type { OpenOrder } from "@/data/chain/source";
import type { PriceLineSpec } from "@/features/chart/engine/types";
import { formatBaseWad } from "@/lib/format";
import type { TriggerView } from "@/features/triggers/abi";
import { PERP_LOT_SIZE_WAD as LOT } from "@/lib/units";

export function accountLines(a: AccountSummary | null | undefined, orders: readonly OpenOrder[] | undefined): PriceLineSpec[] {
  const out: PriceLineSpec[] = [];
  if (a && a.size !== 0n) {
    const long = a.size > 0n;
    out.push({ id: "entry", priceWad: a.entryPrice, tone: long ? "long" : "short", title: `${long ? "Long" : "Short"} ${formatBaseWad(long ? a.size : -a.size, 0)}` });
    if (a.liquidationPrice > 0n) out.push({ id: "liq", priceWad: a.liquidationPrice, tone: "warn", title: "Liq.", dashed: true });
  }
  for (const o of orders ?? []) out.push({ id: `o${o.id}`, priceWad: o.priceWad, tone: o.isBid ? "long" : "short", title: `${o.isBid ? "Bid" : "Ask"} ${formatBaseWad(o.lots * LOT, 0)}`, dashed: true });
  return out;
}

/** Trigger lines (CR-012): stop-loss in warn, take-profit in long; labels say they are triggers, not resting orders. */
export const triggerLines = (ts: readonly TriggerView[] | undefined): PriceLineSpec[] =>
  (ts ?? []).map((t) => ({ id: `t${t.id}`, priceWad: t.triggerPriceWad, tone: t.kind === "StopMarket" ? ("warn" as const) : ("long" as const), title: t.kind === "StopMarket" ? "SL trigger" : "TP trigger", dashed: true }));
