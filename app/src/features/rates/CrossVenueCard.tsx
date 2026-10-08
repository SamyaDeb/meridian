"use client";
import { Card, EmptyState, Notice, Skeleton } from "@/components/ds";
import { MfiChart } from "@/components/charts/MfiChart";
import { SERIES, aprPct, fmtPct } from "@/components/charts/model";
import { INDEXER_URL, useCrossVenueFunding } from "@/data/hooks";
import type { CrossVenueHour } from "@/data/indexer/funding";
import type { MfiPoint } from "@/data/mfi";

const VENUES = SERIES.filter((s) => s.key !== "mfi");

/** Pure: indexer hours → chart points (no MFI line; an hour without a venue's value is a gap, never 0). */
export const crossVenuePoints = (hours: readonly CrossVenueHour[]): MfiPoint[] =>
  hours.map((h) => ({ t: h.hour * 1000, mfi: null, meridian: h.meridianAprWad ?? null, perpl: h.perplAprWad ?? null, stale: false }));

/**
 * Meridian vs Perpl funding, hourly, from the indexer (CrossVenueFunding, K2.2): Meridian's realized 1 h APR next to
 * Perpl's MON rate annualized. The data layer for K5's Rates & Risk; one line chart here proves the wiring.
 */
export function CrossVenueCard() {
  const q = useCrossVenueFunding(72);
  const last = q.data?.at(-1);
  return (
    <Card title="Meridian vs Perpl funding (hourly)">
      {INDEXER_URL === undefined ? (
        <EmptyState title="Needs the indexer" body="The hourly comparison is computed by the Meridian indexer, which isn't connected here." />
      ) : q.isError ? (
        <Notice tone="warn" title="Indexer unavailable">Retrying.</Notice>
      ) : !q.data ? (
        <Skeleton className="h-48 w-full" label="Loading funding history" />
      ) : q.data.length === 0 ? (
        <EmptyState title="No hours yet" body="Rows appear once both venues have a funding update indexed." />
      ) : (
        <div className="space-y-2">
          <p className="num text-xs text-muted">
            Last hour: Meridian {last?.meridianAprWad !== undefined ? fmtPct(aprPct(last.meridianAprWad)) : "—"} · Perpl {last?.perplAprWad !== undefined ? fmtPct(aprPct(last.perplAprWad)) : "—"}
            {last?.spreadAprWad !== undefined ? ` · spread ${fmtPct(aprPct(last.spreadAprWad))}` : ""}
          </p>
          <MfiChart points={crossVenuePoints(q.data)} series={VENUES} />
          <p className="text-[10px] text-muted">APR. Meridian: realized over the trailing hour (funding-rate oracle, every block). Perpl: the MON rate in force, per 43-minute interval, annualized. Source: Envio indexer.</p>
        </div>
      )}
    </Card>
  );
}
