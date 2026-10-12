"use client";
import { useState } from "react";
import { ChartCard as PriceChart } from "@/features/chart/ChartCard";
import { setDraft } from "./draft";
import { formatPriceWad } from "@/lib/format";
import { FundingTicker } from "@/components/FundingTicker";
import { PillTabs } from "@/components/ds";
import { useAccountAddress, useAccountView, useOpenOrders } from "@/data/hooks";
import { accountLines, triggerLines } from "./chartLines";
import { useTriggers } from "@/features/triggers/useTriggers";
import { usePrefs } from "@/lib/prefs";
import { FundingCard } from "./FundingCard";
import { usePerpMarket } from "@/data/market";

/**
 * Chart slot of the terminal, Hyperliquid style: "Chart | Funding" tabs on top of one panel. The price chart stays
 * mounted while Funding is open (no re-initialisation); a click on the price pane loads that price into the ticket.
 */
export function ChartCard() {
  const me = useAccountAddress();
  const { data: a } = useAccountView(me);
  const { data: orders } = useOpenOrders(me);
  const prefs = usePrefs();
  const { triggers } = useTriggers();
  const pm = usePerpMarket(); // K7: triggers exist on MON-PERP only
  const trig = pm.primary ? triggerLines(triggers) : [];
  const [tab, setTab] = useState<"chart" | "funding">("chart");
  return (
    <div className="flex h-full flex-col gap-2 lg:gap-0" data-testid="chart-card">
      {/* phones: the per-block funding ticker stays the first thing under the strip (desktop shows it in the strip) */}
      <div className="lg:hidden" data-testid="funding-ticker">
        <FundingTicker />
      </div>
      <div className="hidden rounded-t-[6px] border-b border-border bg-card px-3 lg:block">
        <PillTabs size="sm" ariaLabel="Chart view" value={tab} onChange={setTab} tabs={[{ id: "chart", label: "Chart" }, { id: "funding", label: "Funding" }]} />
      </div>
      <div className={`min-h-0 flex-1 flex-col ${tab === "chart" ? "flex" : "hidden"}`}>
        <PriceChart priceLines={[...accountLines(a, orders, pm.lotSizeWad, pm.sizeDp).filter((l) => !(prefs.hideLiq && l.id === "liq")), ...trig]} onPriceClick={(px) => setDraft({ kind: "limit", limitPx: formatPriceWad(px, pm.tickSizeWad).replace(/,/g, "") })} />
      </div>
      {tab === "funding" && (
        <div className="min-h-0 flex-1 overflow-auto rounded-b-[6px] bg-card [&>section]:border-0 [&>section]:bg-transparent">
          <FundingCard />
        </div>
      )}
    </div>
  );
}
