"use client";
import { INDEXER_URL, useIndexerStats, useMarket, useMetrics, useProtocolStats } from "@/data/hooks";
import { useDataSource } from "@/data/context";
import type { ReactNode } from "react";
import { Card, Notice, Skeleton } from "@/components/ds";
import { formatAprWad, formatAusdToken, formatAusdWad, formatBaseWad } from "@/lib/format";
import { mmShareBps } from "@/data/indexer/stats";

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const apr = (v: bigint | undefined) => (v === undefined ? "—" : formatAprWad(v));

/** One KPI = one rounded card (FRONTEND_TRADE_PLAN §7 Stats). */
function Kpi({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card as="div" className="p-3! sm:p-4!">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 truncate text-lg font-semibold sm:text-xl">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </Card>
  );
}
const GRID = "grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4";

/** Metrics from the indexer only (PRD §6, DEMO_SCRIPT 2:50): product markets, MM share disclosed, block heights. */
function IndexerMetrics() {
  const { data: s, error, isLoading } = useIndexerStats();
  if (isLoading) return <Skeleton className="h-40 w-full" label="Loading metrics from the indexer" />;
  if (error || !s)
    return (
      <Notice tone="warn" title="Indexer unavailable">
        {error instanceof Error ? error.message : "no data"}. Metrics are shown only from the indexer.
      </Notice>
    );
  const mm = mmShareBps(s.perpVolumeQuoteWad, s.perpVolumeMmQuoteWad);
  return (
    <>
      <div className={GRID}>
        <Kpi label="Wallets" value={s.externalUsers.toLocaleString()} sub="traded or deposited · not ours" />
        <Kpi label="TVL" value={formatAusdToken(s.tvlToken)} sub="AUSD" />
        <Kpi label="Perp volume" value={formatAusdWad(s.perpVolumeQuoteWad)} sub={`AUSD · our MM in ${pct(mm)}`} />
        <Kpi label="Fees onchain" value={formatAusdWad(s.feesWad)} sub="AUSD" />
        <Kpi label="Swap notional" value={formatBaseWad(s.swapVolumeWad, 0)} sub="MON" />
        <Kpi label="Trades · liquidations" value={`${s.trades.toLocaleString()} · ${s.liquidations}`} />
        {s.funding && (
          <>
            <Kpi label="Funding APR 1h" value={apr(s.funding.apr1hWad)} sub={s.funding.symbol} />
            <Kpi label="Funding APR 8h" value={apr(s.funding.apr8hWad)} sub={s.funding.symbol} />
            <Kpi label="Funding APR 24h" value={apr(s.funding.apr24hWad)} sub={s.funding.symbol} />
          </>
        )}
      </div>
      <p className="num mt-2 px-1 text-[11px] text-muted" data-testid="stats-blocks">
        Indexer · product markets only (test markets excluded) · stats at block #{s.statsBlock.toString()}
        {s.funding && ` · ${s.funding.symbol} funding at block #${s.funding.block.toString()}`}
      </p>
    </>
  );
}

/**
 * K6 B3 (DEMO_SCRIPT 2:50): who uses it and what they use. External = not ours: deployments' operators are excluded by
 * the indexer, our labelled test wallets (Privy test account, demo victim, CRE) here. The demo market's liquidations
 * are counted apart from the product market's.
 */
function UserMetrics() {
  const { data: m, error, isLoading } = useMetrics();
  if (isLoading) return <Skeleton className="h-32 w-full" label="Loading user metrics from the indexer" />;
  if (error || !m)
    return (
      <Notice tone="warn" title="User metrics unavailable">
        {error instanceof Error ? error.message : "no data"}.
      </Notice>
    );
  const ge = (n: number, capped: boolean) => (capped ? `≥ ${n.toLocaleString()}` : n.toLocaleString());
  const r = m.redeems;
  return (
    <section aria-label="Users and products">
      <h2 className="px-1 pb-1 text-sm font-semibold">Users and products</h2>
      <div className={GRID} data-testid="user-metrics">
        <Kpi label="External users" value={ge(m.externalUsers, m.externalUsersCapped)} sub={`${m.externalTraders} traded the perp · ours excluded`} />
        <Kpi label="Perp trades" value={m.trades.toLocaleString()} sub={`our MM in ${pct(m.mmShareBps)} of volume`} />
        <Kpi label="Funding swaps opened" value={m.swapsOpenedExternal.toLocaleString()} sub={`by external users · ${m.swapsOpenedAll} incl. ours`} />
        <Kpi label="Vault depositors" value={m.vaultDepositorsExternal.toLocaleString()} sub={`${formatAusdToken(m.vaultDepositedTokenExternal)} AUSD deposited`} />
        <Kpi label="Withdrawal queue" value={`${r.requested} queued`} sub={`${r.claimable} to claim · ${r.claimed} claimed · ${r.cancelled} cancelled`} />
        <Kpi label="Liquidations" value={ge(m.liquidationsProduct, m.liquidationsCapped)} sub={`product market · ${m.liquidationsTestMarket} on the labelled demo market`} />
      </div>
      <p className="num mt-2 px-1 text-[11px] text-muted" data-testid="metrics-block">
        As of block #{m.asOfBlock.toString()} (indexer head) · {m.testWalletsExcluded} labelled test wallet(s) of ours excluded
      </p>
    </section>
  );
}

/** Mock data layer only (local dev without an indexer); the top bar labels it "mock data". */
function MockMetrics() {
  const { data: s } = useProtocolStats();
  const { data: m } = useMarket();
  return (
    <div className={GRID}>
      <Kpi label="Users" value={s ? s.users : "—"} />
      <Kpi label="TVL" value={s ? `${formatAusdToken(s.tvlToken)}` : "—"} sub="AUSD" />
      <Kpi label="Perp volume" value={s ? formatAusdWad(s.perpVolumeQuoteWad) : "—"} sub="AUSD" />
      <Kpi label="Fees" value={s ? formatAusdWad(s.feesWad) : "—"} sub="AUSD" />
      <Kpi label="Trades" value={s ? s.trades.toLocaleString() : "—"} />
      <Kpi label="Liquidations" value={s ? s.liquidations : "—"} />
      <Kpi label="Funding updates" value={s ? s.fundingTicks.toLocaleString() : "—"} sub="one per block" />
      <Kpi label="Last funding block" value={m ? `#${m.lastFundingBlock.toString()}` : "—"} />
    </div>
  );
}

export default function StatsPage() {
  const ds = useDataSource();
  return (
    <div className="space-y-2">
      <header className="px-1 pt-1">
        <h1 className="text-xl font-semibold">Stats</h1>
        <p className="text-xs text-muted">Product markets only. Our market maker&apos;s share of volume is disclosed.</p>
      </header>
      {INDEXER_URL ? (
        <>
          <IndexerMetrics />
          <UserMetrics />
        </>
      ) : ds.kind === "mock" ? (
        <MockMetrics />
      ) : (
        <Notice tone="info" title="Indexer not connected">
          Protocol metrics come from the indexer, which isn&apos;t connected to this build. No numbers are shown rather than made-up ones.
        </Notice>
      )}
      <Card title="Why Monad">
        <p className="text-sm text-muted">
          Funding settles every block (~300 ms) instead of every 8 hours. Benchmarks and the √τ margin chart are linked from the write-up.
        </p>
      </Card>
    </div>
  );
}
