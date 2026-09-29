"use client";
import { useFundingTicks, useMarket } from "@/data/hooks";
import { formatAprWad, formatSignedAprWad } from "@/lib/format";
import { Skeleton, Sparkline } from "./ui";

/** Per-block funding: rate APR updates every block (~300 ms), with a short history sparkline. */
export function FundingTicker() {
  const { data: m } = useMarket();
  const { data: ticks } = useFundingTicks(200);
  const tone = m && m.lastRateAprWad < 0n ? "text-short" : "text-long";
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">Funding, every block</span>
        <span className="num text-[11px] text-muted">{m ? `block #${m.lastFundingBlock.toString()}` : <Skeleton className="h-3 w-20" />}</span>
      </div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <div>
          {m ? (
            <div key={m.lastFundingBlock.toString()} className={`num tick-flash text-2xl font-semibold ${tone}`}>
              {formatSignedAprWad(m.lastRateAprWad, 3)}
            </div>
          ) : (
            <Skeleton className="h-8 w-28" />
          )}
          <div className="text-[11px] text-muted">APR · longs pay shorts when positive</div>
        </div>
        <Sparkline className="h-10 w-32" values={(ticks ?? []).slice().reverse().map((t) => Number(t.rateAprWad) / 1e18)} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
        {(
          [
            ["1h", m?.realizedApr1hWad],
            ["8h", m?.realizedApr8hWad],
            ["24h", m?.realizedApr24hWad],
          ] as const
        ).map(([label, v]) => (
          <div key={label}>
            <div className="text-[11px] text-muted">Realized {label}</div>
            <div className="num text-sm">{m ? (v === undefined ? "—" : formatAprWad(v)) : <Skeleton className="h-4 w-12" />}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
