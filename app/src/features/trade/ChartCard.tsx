"use client";
import { ChartCard as PriceChart } from "@/features/chart/ChartCard";
import { setDraft } from "./draft";
import { formatPriceWad } from "@/lib/format";
import { FundingTicker } from "@/components/FundingTicker";
import { useAccountAddress, useAccountView, useOpenOrders } from "@/data/hooks";
import { accountLines, triggerLines } from "./chartLines";
import { useTriggers } from "@/features/triggers/useTriggers";
import { usePrefs } from "@/lib/prefs";

/** Chart slot of the terminal: the price chart; a click on the price pane loads that price into the ticket (limit). */
export function ChartCard() {
  const me = useAccountAddress();
  const { data: a } = useAccountView(me);
  const { data: orders } = useOpenOrders(me);
  const prefs = usePrefs();
  const { triggers } = useTriggers();
  return (
    <div className="flex h-full flex-col gap-2" data-testid="chart-card">
      {/* phones: the per-block funding ticker stays the first thing under the strip (desktop shows it in the strip) */}
      <div className="lg:hidden" data-testid="funding-ticker">
        <FundingTicker />
      </div>
      <PriceChart priceLines={[...accountLines(a, orders).filter((l) => !(prefs.hideLiq && l.id === "liq")), ...triggerLines(triggers)]} onPriceClick={(px) => setDraft({ kind: "limit", limitPx: formatPriceWad(px).replace(/,/g, "") })} />
    </div>
  );
}
