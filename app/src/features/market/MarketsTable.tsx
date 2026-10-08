"use client";
// K7: one row per perp market (MON-PERP, ETH-PERP): mark, index, funding now and realized, open interest. Each market
// is read from its own data source (data/market.tsx); funding is computed per market, every block, independently.
import { useQueries } from "@tanstack/react-query";
import { Card, Chip, EmptyState } from "@/components/ds";
import { usePerpMarkets, useMarketSources } from "@/data/market";
import { formatAprWad, formatBaseWad, formatPriceWad, formatSignedAprWad } from "@/lib/format";

export function MarketsTable({ title = "Markets" }: { title?: string }) {
  const { markets, market: selected, setMarket } = usePerpMarkets();
  const sources = useMarketSources();
  const qs = useQueries({
    queries: markets.map((pm) => ({
      queryKey: ["marketRow", sources.get(pm.key)?.kind, pm.key],
      queryFn: () => sources.get(pm.key)!.market(),
      enabled: sources.has(pm.key),
      refetchInterval: 3_000,
    })),
  });
  if (markets.length === 0) return null;
  return (
    <div data-testid="markets-table">
    <Card title={title}>
      {sources.size === 0 ? (
        <EmptyState title="No market data" />
      ) : (
        <div className="overflow-x-auto">
          <table className="num w-full min-w-[560px] text-xs">
            <thead className="text-left text-[11px] text-muted">
              <tr>
                <th className="py-1 pr-2 font-normal">Market</th>
                <th className="py-1 pr-2 text-right font-normal">Mark</th>
                <th className="py-1 pr-2 text-right font-normal">Index</th>
                <th className="py-1 pr-2 text-right font-normal">Funding now</th>
                <th className="py-1 pr-2 text-right font-normal">Realized 1h</th>
                <th className="py-1 pr-2 text-right font-normal">Realized 8h</th>
                <th className="py-1 text-right font-normal">OI long / short</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((pm, i) => {
                const m = qs[i]?.data;
                const px = (v: bigint) => formatPriceWad(v, pm.tickSizeWad);
                return (
                  <tr key={pm.key} className="border-t border-border" data-testid={`market-row-${pm.key}`}>
                    <td className="py-1.5 pr-2">
                      <button type="button" onClick={() => setMarket(pm.key)} className={`font-semibold ${pm.key === selected.key ? "text-text" : "text-muted hover:text-text"}`}>
                        {pm.symbol}
                      </button>{" "}
                      {!pm.primary && pm.keeperFed && <Chip tone="warn">testnet · keeper-fed</Chip>}
                    </td>
                    <td className="py-1.5 pr-2 text-right">{m ? px(m.lastMarkPrice) : "—"}</td>
                    <td className="py-1.5 pr-2 text-right">{m ? px(m.lastIndexPrice) : "—"}</td>
                    <td className={`py-1.5 pr-2 text-right ${m && m.lastRateAprWad < 0n ? "text-short" : m && m.lastRateAprWad > 0n ? "text-long" : ""}`}>{m ? formatSignedAprWad(m.lastRateAprWad, 3) : "—"}</td>
                    <td className="py-1.5 pr-2 text-right">{m?.realizedApr1hWad !== undefined ? formatAprWad(m.realizedApr1hWad) : "—"}</td>
                    <td className="py-1.5 pr-2 text-right">{m?.realizedApr8hWad !== undefined ? formatAprWad(m.realizedApr8hWad) : "—"}</td>
                    <td className="py-1.5 text-right">
                      {m ? `${formatBaseWad(m.openInterestLongWad, pm.sizeDp)} / ${formatBaseWad(m.openInterestShortWad, pm.sizeDp)} ${pm.base}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-muted">
            Each market has its own order book, clearinghouse and funding index, updated every block; they share the insurance fund. The Meridian Funding Index, the basis vault and funding swaps are MON-PERP only.
          </p>
        </div>
      )}
    </Card>
    </div>
  );
}
