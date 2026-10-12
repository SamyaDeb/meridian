"use client";
import { GetStarted } from "@/components/GetStarted";
import { MarketStrip } from "@/components/market/MarketStrip";
import { ChartCard } from "@/features/trade/ChartCard";
import { OrderBookCard } from "@/features/trade/OrderBookCard";
import { OrderTicket } from "@/features/trade/OrderTicket";
import { AccountStrip } from "@/features/trade/AccountStrip";
import { PositionsCard } from "@/features/trade/PositionsCard";
import { TradeHotkeys } from "@/features/trade/TradeHotkeys";
import { Splitter } from "@/features/trade/Splitter";
import { LAYOUT_BOUNDS, setLayout, useLayout } from "@/lib/layout";
import type { CSSProperties } from "react";

/** Trade terminal (FRONTEND_TRADE_PLAN §6): every panel a separate rounded card; grid in globals.css `.terminal`. */
export default function TradePage() {
  const layout = useLayout();
  const vars = { "--book-w": `${layout.bookW}px`, "--pos-h": `${layout.posH}px` } as CSSProperties;
  return (
    <div className="terminal" data-testid="terminal" style={vars}>
      {/* Hyperliquid: the gutters between terminal panels are darker than the panels (covers the page backdrop) */}
      <div className="fixed inset-0 -z-[1] hidden bg-bg-deep xl:block" aria-hidden />
      <TradeHotkeys />
      <div data-area="strip">
        <MarketStrip />
      </div>
      <div data-area="chart">
        <ChartCard />
      </div>
      <div data-area="book" className="relative">
        <Splitter orientation="vertical" label="Resize order book" value={layout.bookW} min={LAYOUT_BOUNDS.bookW[0]} max={LAYOUT_BOUNDS.bookW[1]} grow={-1} onChange={(v) => setLayout({ bookW: v })} />
        <OrderBookCard />
      </div>
      <div data-area="ticket">
        <OrderTicket />
      </div>
      <div data-area="pos" className="relative">
        <Splitter orientation="horizontal" label="Resize positions panel" value={layout.posH} min={LAYOUT_BOUNDS.posH[0]} max={LAYOUT_BOUNDS.posH[1]} grow={-1} onChange={(v) => setLayout({ posH: v })} />
        <PositionsCard />
      </div>
      <div data-area="account">
        <AccountStrip />
      </div>
      <div data-area="extra">
        <GetStarted />
      </div>
    </div>
  );
}
