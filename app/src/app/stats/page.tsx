"use client";
import { useMarket, useProtocolStats } from "@/data/hooks";
import { Card, Stat } from "@/components/ui";
import { formatAusdToken, formatAusdWad } from "@/lib/format";

export default function StatsPage() {
  const { data: s } = useProtocolStats();
  const { data: m } = useMarket();
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Stats</h1>
      <Card>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Users" value={s ? s.users : "—"} />
          <Stat label="TVL" value={s ? `${formatAusdToken(s.tvlToken)}` : "—"} sub="AUSD" />
          <Stat label="Perp volume" value={s ? formatAusdWad(s.perpVolumeQuoteWad) : "—"} sub="AUSD" />
          <Stat label="Fees" value={s ? formatAusdWad(s.feesWad) : "—"} sub="AUSD" />
          <Stat label="Trades" value={s ? s.trades.toLocaleString() : "—"} />
          <Stat label="Liquidations" value={s ? s.liquidations : "—"} />
          <Stat label="Funding updates" value={s ? s.fundingTicks.toLocaleString() : "—"} sub="one per block" />
          <Stat label="Last funding block" value={m ? `#${m.lastFundingBlock.toString()}` : "—"} />
        </div>
      </Card>
      <Card title="Why Monad">
        <p className="text-sm text-muted">
          Funding settles every block (~300 ms) instead of every 8 hours. Benchmarks and the √τ margin chart are linked from the write-up.
        </p>
      </Card>
    </div>
  );
}
