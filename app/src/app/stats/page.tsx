"use client";
import { INDEXER_URL, useIndexerStats, useMarket, useProtocolStats } from "@/data/hooks";
import { useDataSource } from "@/data/context";
import { Card, Stat } from "@/components/ui";
import { formatAprWad, formatAusdToken, formatAusdWad, formatBaseWad } from "@/lib/format";
import { mmShareBps } from "@/data/indexer/stats";

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const apr = (v: bigint | undefined) => (v === undefined ? "—" : formatAprWad(v));

/** Metrics from the indexer only (PRD §6, DEMO_SCRIPT 2:50): product markets, MM share disclosed, block heights. */
function IndexerMetrics() {
  const { data: s, error, isLoading } = useIndexerStats();
  if (isLoading) return <p className="text-sm text-muted">Loading metrics from the indexer…</p>;
  if (error || !s) return <p className="text-sm text-warn">Indexer unavailable ({error instanceof Error ? error.message : "no data"}). Metrics are shown only from the indexer.</p>;
  const mm = mmShareBps(s.perpVolumeQuoteWad, s.perpVolumeMmQuoteWad);
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Wallets" value={s.externalUsers.toLocaleString()} sub="traded or deposited · not ours" />
        <Stat label="TVL" value={formatAusdToken(s.tvlToken)} sub="AUSD" />
        <Stat label="Perp volume" value={formatAusdWad(s.perpVolumeQuoteWad)} sub={`AUSD · our MM in ${pct(mm)}`} />
        <Stat label="Fees onchain" value={formatAusdWad(s.feesWad)} sub="AUSD" />
        <Stat label="Swap notional" value={formatBaseWad(s.swapVolumeWad, 0)} sub="MON" />
        <Stat label="Trades · liquidations" value={`${s.trades.toLocaleString()} · ${s.liquidations}`} />
      </div>
      {s.funding && (
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
          <Stat label="Funding APR 1h" value={apr(s.funding.apr1hWad)} />
          <Stat label="8h" value={apr(s.funding.apr8hWad)} />
          <Stat label="24h" value={apr(s.funding.apr24hWad)} />
        </div>
      )}
      <p className="num mt-3 text-[11px] text-muted" data-testid="stats-blocks">
        Indexer · product markets only (test markets excluded) · stats at block #{s.statsBlock.toString()}
        {s.funding && ` · ${s.funding.symbol} funding at block #${s.funding.block.toString()}`}
      </p>
    </>
  );
}

/** Mock data layer only (local dev without an indexer); the top bar labels it "mock data". */
function MockMetrics() {
  const { data: s } = useProtocolStats();
  const { data: m } = useMarket();
  return (
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
  );
}

export default function StatsPage() {
  const ds = useDataSource();
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Stats</h1>
      <Card>
        {INDEXER_URL ? (
          <IndexerMetrics />
        ) : ds.kind === "mock" ? (
          <MockMetrics />
        ) : (
          <p className="text-sm text-muted">Protocol metrics come from the indexer, which isn&apos;t connected to this build.</p>
        )}
      </Card>
      <Card title="Why Monad">
        <p className="text-sm text-muted">
          Funding settles every block (~300 ms) instead of every 8 hours. Benchmarks and the √τ margin chart are linked from the write-up.
        </p>
      </Card>
    </div>
  );
}
