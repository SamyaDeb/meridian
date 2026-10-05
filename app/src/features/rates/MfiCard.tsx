"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, EmptyState, Notice, Skeleton } from "@/components/ds";
import { MfiChart } from "@/components/charts/MfiChart";
import { aprPct, fmtPct } from "@/components/charts/model";
import { MFI_URL, type MfiVenue, fetchMfiCurrent, fetchMfiHistory } from "@/data/mfi";

const VENUE_LABEL: Record<MfiVenue["id"], string> = { meridian: "Meridian", perpl: "Perpl" };

/** Per-venue line: APR and weight when included, else the service's status and reason (never an estimate). */
function Venue({ v }: { v: MfiVenue }) {
  return (
    <div className="rounded-control bg-card-2 p-2.5">
      <div className="text-xs text-muted">{VENUE_LABEL[v.id]}</div>
      <div className="num mt-0.5 text-base font-semibold">{v.included && v.aprWad !== undefined ? fmtPct(aprPct(v.aprWad)) : "excluded"}</div>
      <div className="mt-0.5 text-[11px] text-muted">
        {v.included ? `${((v.weightBps ?? 0) / 100).toFixed(1)}% weight` : `${v.status}${v.reason ? `: ${v.reason}` : ""}`}
      </div>
    </div>
  );
}

/**
 * Meridian Funding Index (MFI, docs/MFI.md §7): the index, each venue's rate and status, and MFI vs Meridian vs Perpl
 * over time. Source: the MFI service (`NEXT_PUBLIC_MFI_URL`). Unset or failing ⇒ an explicit empty state, never fake data.
 */
export function MfiCard() {
  const cur = useQuery({
    queryKey: ["mfi", MFI_URL],
    queryFn: ({ signal }) => fetchMfiCurrent(MFI_URL!, signal),
    enabled: MFI_URL !== undefined,
    refetchInterval: 30_000,
    retry: 1,
  });
  const hist = useQuery({
    queryKey: ["mfiHistory", MFI_URL],
    queryFn: ({ signal }) => fetchMfiHistory(MFI_URL!, 720, signal),
    enabled: MFI_URL !== undefined,
    refetchInterval: 60_000,
    retry: 1,
  });
  const c = cur.data;
  const right = c && (
    <span className={`num text-[11px] ${c.stale ? "text-warn" : "text-muted"}`}>{c.stale ? "stale" : `block ${c.updatedBlock ?? "—"}`}</span>
  );
  return (
    <Card title="Meridian Funding Index (Meridian vs Perpl)" right={right}>
      {/* static explanation first: it paints in the first frame at a fixed spot (it was the late LCP element below the data) */}
      <p className="mb-3 text-[11px] text-muted">
        Offchain v0: computed from Meridian&apos;s onchain funding oracle and Perpl&apos;s public API. A venue that is stale or unreachable is excluded and labelled, never estimated.
      </p>
      {MFI_URL === undefined ? (
        <EmptyState title="MFI service not connected" body="The index is computed by the MFI service (NEXT_PUBLIC_MFI_URL), which isn't configured here. No index is shown rather than a simulated one." />
      ) : cur.isError ? (
        <Notice tone="warn" title="MFI service unavailable">
          {(cur.error as Error).message}. Retrying.
        </Notice>
      ) : !c ? (
        <Skeleton className="h-[344px] w-full" label="Loading the index" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-control bg-card-2 p-2.5">
              <div className="text-xs text-muted">MFI (APR)</div>
              <div className={`num mt-0.5 text-base font-semibold ${c.stale ? "text-warn" : ""}`}>{c.aprWad === null ? "—" : fmtPct(aprPct(c.aprWad))}</div>
              <div className="mt-0.5 text-[11px] text-muted">{c.weighting === "oi" ? "OI-weighted" : c.weighting}</div>
            </div>
            {c.venues.map((v) => (
              <Venue key={v.id} v={v} />
            ))}
          </div>
          {c.warmup && <p className="mt-2 text-[11px] text-muted">Warming up: weights use less than 1 h of open-interest samples.</p>}
          {/* height reserved so the card doesn't grow when history arrives (CLS) */}
          <div className="mt-3 min-h-[244px]">
            {hist.data && hist.data.length > 0 ? (
              <MfiChart points={hist.data} />
            ) : hist.isError ? (
              <Notice tone="warn" title="History unavailable">Retrying.</Notice>
            ) : hist.isPending ? (
              <Skeleton className="h-[200px] w-full" label="Loading history" />
            ) : (
              <EmptyState title="No history yet" />
            )}
          </div>
        </>
      )}
    </Card>
  );
}
