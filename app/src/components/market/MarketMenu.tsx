"use client";
// Market dropdown on the trade strip's market name (Hyperliquid: "MON-USDC ▾"). Lists Meridian's perp markets (K7: MON-PERP /
// ETH-PERP) and, behind NEXT_PUBLIC_PERPL_REFERENCE=1, Perpl's MON perp as a view-only outside venue. Without a choice
// to make (one market, no Perpl) it is the plain symbol.
import { Popover } from "@/components/ds";
import { usePerpMarkets } from "@/data/market";
import { PERPL_ENABLED, PERPL_VENUE } from "@/features/chart/datafeed/perpl";
import { setVenue, useVenue } from "@/features/trade/venue";

const item = (on: boolean) =>
  `flex w-full items-center justify-between gap-3 rounded-control px-2 py-1.5 text-left text-[13px] min-h-9 pointer-coarse:min-h-11 ${on ? "bg-brand-tint text-brand-soft" : "text-text hover:bg-card-2"}`;

export function MarketMenu({ symbol }: { symbol: string }) {
  const { market, markets, setMarket } = usePerpMarkets();
  const venue = useVenue();
  const name = (
    <span className="whitespace-nowrap text-xl tracking-tight" data-testid="market-symbol">
      {symbol}
    </span>
  );
  if (markets.length < 2 && !PERPL_ENABLED) return name;
  return (
    <div data-testid="market-menu">
      <Popover
        label="Market"
        align="start"
        triggerClassName="inline-flex items-center gap-1.5 rounded-control px-1 py-0.5 hover:bg-card-2 pointer-coarse:min-h-11"
        panelClassName="!w-80"
        trigger={
          <>
            {name}
            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} className="text-muted" aria-hidden>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </>
        }
      >
        {(close) => (
          <div role="menu" aria-label="Markets" className="space-y-0.5">
            <p className="px-2 pb-1 text-[11px] text-muted">Meridian · trade</p>
            {markets.map((m) => {
              const on = venue === "meridian" && m.key === market.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  data-testid={`menu-market-${m.key}`}
                  className={item(on)}
                  onClick={() => {
                    setVenue("meridian");
                    setMarket(m.key);
                    close();
                  }}
                >
                  <span className="font-semibold">{m.symbol}</span>
                  <span className="text-[11px] text-muted">Meridian</span>
                </button>
              );
            })}
            {PERPL_ENABLED && (
              <>
                <p className="px-2 pb-1 pt-2 text-[11px] text-muted">Other venues · view only</p>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={venue === "perpl"}
                  data-testid="menu-market-perpl"
                  className={item(venue === "perpl")}
                  onClick={() => {
                    setVenue("perpl");
                    close();
                  }}
                >
                  <span className="font-semibold">MON-PERP</span>
                  <span className="text-right text-[11px] text-muted">{PERPL_VENUE}</span>
                </button>
              </>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}
