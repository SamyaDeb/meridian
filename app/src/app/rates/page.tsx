"use client";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { INDEXER_URL, useMarket, useRiskParams } from "@/data/hooks";
import { Card, EmptyState, Notice, Skeleton } from "@/components/ds";
import { formatAprWad, formatAusdToken, formatBaseWad, formatSignedAprWad } from "@/lib/format";
import { histogram } from "@/lib/liqDistance";
import { DEFAULT_MMR_WAD } from "@/lib/units";
import { MfiCard } from "@/features/rates/MfiCard";

function Kpi({ label, children, sub }: { label: string; children: ReactNode; sub?: string }) {
  return (
    <Card as="div" className="p-3! sm:p-4!">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 text-lg font-semibold">{children}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </Card>
  );
}

/**
 * Rates & Risk (WIN_PLAN T8, FRONTEND_TRADE_PLAN §7, decision D3). Real sources only: the funding-rate oracle (chain)
 * for the APR table, the MFI service for the Meridian Funding Index (MfiCard), the indexer for liquidation distance and
 * the insurance fund. A missing source is an empty state, never simulated.
 */
export default function RatesPage() {
  const { data: m } = useMarket();
  const { data: risk } = useRiskParams();
  const market = m?.clearingHouse;
  const q = useQuery({
    queryKey: ["risk", INDEXER_URL, market],
    queryFn: async ({ signal }) => (await import("@/data/indexer/risk")).fetchRisk(INDEXER_URL!, market!, signal),
    enabled: INDEXER_URL !== undefined && market !== undefined,
    refetchInterval: 15_000,
    retry: 1,
  });
  const rows = q.data && m ? histogram(q.data.positions, m.lastMarkPrice, risk?.mmr ?? DEFAULT_MMR_WAD) : undefined;
  const maxCount = rows ? Math.max(1, ...rows.map((r) => r.count)) : 1;
  return (
    <div className="space-y-2">
      <header className="px-1 pt-1">
        <h1 className="text-xl font-semibold">Rates &amp; risk</h1>
        <p className="text-xs text-muted">The MON-PERP funding rate, how it has paid, and how close open positions are to liquidation.</p>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Funding now (APR)" sub="per block">{m ? formatSignedAprWad(m.lastRateAprWad, 3) : "—"}</Kpi>
        <Kpi label="Realized 1h" sub="funding-rate oracle">{m?.realizedApr1hWad !== undefined ? formatAprWad(m.realizedApr1hWad) : "—"}</Kpi>
        <Kpi label="Realized 8h" sub="funding-rate oracle">{m?.realizedApr8hWad !== undefined ? formatAprWad(m.realizedApr8hWad) : "—"}</Kpi>
        <Kpi label="Realized 24h" sub="funding-rate oracle">{m?.realizedApr24hWad !== undefined ? formatAprWad(m.realizedApr24hWad) : "—"}</Kpi>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-2">
        <MfiCard />

        <Card title="Liquidation distance (open positions)">
          {INDEXER_URL === undefined ? (
            <EmptyState title="Needs the indexer" body="Open positions are read from the Meridian indexer, which isn't connected here." />
          ) : q.isError ? (
            <Notice tone="warn" title="Indexer unavailable">Retrying.</Notice>
          ) : !rows ? (
            <Skeleton className="h-40 w-full" label="Loading positions" />
          ) : rows.every((r) => r.count === 0) ? (
            <EmptyState title="No open positions" />
          ) : (
            <ul className="space-y-1.5" aria-label="Positions by distance to liquidation">
              {rows.map((r) => (
                <li key={r.label} className="grid grid-cols-[110px_minmax(0,1fr)_88px] items-center gap-2 text-xs">
                  <span className="text-muted">{r.label}</span>
                  <span className="h-3 overflow-hidden rounded-full bg-card-2">
                    <span className={`block h-full rounded-full ${r.label.startsWith("≤ 2") || r.label.startsWith("≤ 5") ? "bg-short" : r.label.startsWith("never") ? "bg-long" : "bg-warn"}`} style={{ width: `${(r.count / maxCount) * 100}%` }} />
                  </span>
                  <span className="num text-right">
                    {r.count} · {formatBaseWad(r.sizeWad, 0)}
                  </span>
                </li>
              ))}
              <li className="pt-1 text-[10px] text-muted">Mark move to the isolated liquidation price (funding ignored), count · MON. Test markets excluded.</li>
            </ul>
          )}
        </Card>

        <Card title="Insurance fund">
          {INDEXER_URL === undefined ? (
            <EmptyState title="Needs the indexer" />
          ) : !q.data ? (
            <Skeleton className="h-16 w-full" />
          ) : !q.data.insurance ? (
            <EmptyState title="Not funded yet" />
          ) : (
            <dl className="num grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted">Funded</dt>
                <dd>{formatAusdToken(q.data.insurance.fundedToken)} AUSD</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Bad debt covered</dt>
                <dd>{formatAusdToken(q.data.insurance.coveredToken)} AUSD</dd>
              </div>
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
