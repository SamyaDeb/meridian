"use client";
// K7: switch the terminal between perp markets (MON-PERP / ETH-PERP). Hidden when the deployment has one market.
import { usePerpMarkets } from "@/data/market";

export function MarketSwitcher() {
  const { market, markets, setMarket } = usePerpMarkets();
  if (markets.length < 2) return null;
  return (
    <div role="tablist" aria-label="Market" className="inline-flex shrink-0 rounded-[8px] border border-border p-0.5 text-xs" data-testid="market-switcher">
      {markets.map((m) => (
        <button
          key={m.key}
          type="button"
          role="tab"
          aria-selected={m.key === market.key}
          onClick={() => setMarket(m.key)}
          className={`whitespace-nowrap rounded-[6px] px-2 py-1 font-semibold transition-colors ${m.key === market.key ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
          data-testid={`market-${m.key}`}
        >
          {m.symbol}
        </button>
      ))}
    </div>
  );
}
