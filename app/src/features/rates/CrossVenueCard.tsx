"use client";
import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { netCarry, perplAprFromPct100k, perplCountdown, perplFeeWad, spreadAprWad } from "@meridian/risk";
import { Card, EmptyState, Notice, PillTabs, Skeleton } from "@/components/ds";
import { SERIES, SPREAD_SERIES, aprPct, fmtPct } from "@/components/charts/model";
import { INDEXER_URL, useCrossVenueFunding, useMarket, usePerpl, usePerplMarket, useRiskParams } from "@/data/hooks";
import type { CrossVenueHour } from "@/data/indexer/funding";
import { MFI_URL, fetchMfiCurrent, fetchMfiHistory, type MfiPoint } from "@/data/mfi";
import { formatAusdWad, formatDuration, formatFixed, parseFixed } from "@/lib/format";
import { WINDOWS, meridianWindows, perplRatePoints, perplWindows, spreadHistory, withMfi } from "./crossVenue";
import { PERPL_CHAIN_LABEL, type PerplChainId } from "./perplChain";

// charts load on demand (the page's first paint carries no chart code)
const MfiChart = dynamic(() => import("@/components/charts/MfiChart").then((m) => m.MfiChart), { ssr: false, loading: () => <Skeleton className="h-[244px] w-full" label="Loading chart" /> });

/** Pure: indexer hours → chart points (no MFI line; an hour without a venue's value is a gap, never 0). */
export const crossVenuePoints = (hours: readonly CrossVenueHour[]): MfiPoint[] =>
  hours.map((h) => ({ t: h.hour * 1000, mfi: null, meridian: h.meridianAprWad ?? null, perpl: h.perplAprWad ?? null, stale: false }));

const pct = (w: bigint | undefined | null) => (w === undefined || w === null ? "—" : fmtPct(aprPct(w)));

function Stat({ label, children, sub, tone }: { label: string; children: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-control bg-card-2 p-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num mt-0.5 text-base font-semibold ${tone ?? ""}`}>{children}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

const CHAIN_TABS = [
  { id: "10143" as const, label: "Perpl testnet" },
  { id: "143" as const, label: "Perpl mainnet" },
];

/**
 * Meridian vs Perpl funding (K5 step 2). Meridian: per block, realized windows from the indexer's FundingWindow.
 * Perpl: per 8,571-block interval; the rate in force and the last funding block read onchain (/api/perpl/market),
 * realized windows from FundingEventCompleted rows (indexer PerplFunding). Spread, its hourly history, the MFI line,
 * the countdown to Perpl's next funding event (blocks), and net carry after both venues' taker fees.
 */
export function CrossVenueCard() {
  const [chain, setChain] = useState<PerplChainId>(10143);
  const { data: m } = useMarket();
  const { data: risk } = useRiskParams();
  const now = usePerplMarket(chain);
  const perplIdx = usePerpl(chain, 300);
  const hours = useCrossVenueFunding(168);
  const mfi = useQuery({ queryKey: ["mfi", MFI_URL], queryFn: ({ signal }) => fetchMfiCurrent(MFI_URL!, signal), enabled: MFI_URL !== undefined, refetchInterval: 30_000, retry: 1 });
  const mfiHist = useQuery({ queryKey: ["mfiHistory", MFI_URL], queryFn: ({ signal }) => fetchMfiHistory(MFI_URL!, 720, signal), enabled: MFI_URL !== undefined, refetchInterval: 60_000, retry: 1 });
  const [notional, setNotional] = useState("10000");
  const [days, setDays] = useState("7");

  const p = now.data;
  const perplApr = p ? perplAprFromPct100k(p.fundingRatePct100k, p.fundingIntervalSec) : undefined;
  const meridianApr = m?.lastRateAprWad;
  const spread = meridianApr !== undefined && perplApr !== undefined ? spreadAprWad(meridianApr, perplApr) : undefined;
  const cd = p ? perplCountdown(p.lastFundingEventBlock, p.block, p.fundingIntervalBlocks, p.fundingIntervalSec) : undefined;
  const mw = m ? meridianWindows(m) : {};
  const pw = p && perplIdx.data ? perplWindows(perplRatePoints(perplIdx.data.funding), p.block, p.fundingIntervalSec, p.fundingIntervalBlocks) : {};
  const series = hours.data && perplIdx.data ? withMfi(spreadHistory(hours.data, chain, perplIdx.data.funding), mfiHist.data ?? []) : undefined;

  const notionalWad = parseFixed(notional, 18);
  const daysN = /^\d{1,4}$/.test(days) ? BigInt(days) : undefined;
  const carry =
    spread !== undefined && notionalWad !== undefined && daysN !== undefined && p && risk
      ? netCarry({ spreadAprWad: spread, notionalWad, meridianFeeWad: risk.takerFee, perplFeeWad: perplFeeWad(p.takerFeeMicros), horizonDays: daysN })
      : undefined;

  return (
    <Card
      title="Meridian vs Perpl funding"
      right={<PillTabs size="sm" ariaLabel="Perpl network" tabs={CHAIN_TABS} value={String(chain) as "10143" | "143"} onChange={(v) => setChain(Number(v) as PerplChainId)} />}
      className="lg:col-span-2"
    >
      <p className="mb-3 text-[11px] text-muted">
        Meridian MON-PERP on Monad testnet (funding every block) vs Perpl MON on {PERPL_CHAIN_LABEL[chain]} (market {p?.perpId ?? "—"}, funding every{" "}
        {p ? `${formatFixed(p.fundingIntervalBlocks, 0, 0)} blocks` : "interval"}). APR; positive ⇒ longs pay shorts.
        {chain === 143 ? " Different chains: rate against rate, not a hedge on one chain." : ""}
      </p>
      {now.isError ? (
        <Notice tone="warn" title="Perpl read unavailable">
          {(now.error as Error).message}. Retrying.
        </Notice>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Meridian now" sub="per block">
            {pct(meridianApr)}
          </Stat>
          <Stat label="Perpl now" sub={p ? `${p.fundingRatePct100k} per 100k per interval` : "onchain"}>
            {now.isPending ? "…" : pct(perplApr)}
          </Stat>
          <Stat
            label="Spread (M − P)"
            tone={spread !== undefined && spread < 0n ? "text-short" : spread !== undefined && spread > 0n ? "text-long" : ""}
            sub={spread === undefined ? undefined : spread > 0n ? "Meridian longs pay more" : spread < 0n ? "Perpl longs pay more" : "even"}
          >
            {pct(spread)}
          </Stat>
          <Stat label="Next Perpl funding" sub={cd ? `block ${formatFixed(cd.nextBlock, 0, 0)}` : undefined}>
            {cd ? (cd.due ? "due now" : `${formatFixed(cd.blocksLeft, 0, 0)} blocks · ${formatDuration(Number(cd.secondsLeft))}`) : "—"}
          </Stat>
        </div>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="num w-full min-w-[320px] text-left text-xs">
          <caption className="sr-only">Realized funding APR per venue</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-1 font-normal">
                Realized
              </th>
              {WINDOWS.map((w) => (
                <th key={w.id} scope="col" className="py-1 text-right font-normal">
                  {w.id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Meridian", (id: (typeof WINDOWS)[number]["id"]) => pct(mw[id])],
                ["Perpl", (id: (typeof WINDOWS)[number]["id"]) => pct(pw[id])],
                ["Spread", (id: (typeof WINDOWS)[number]["id"]) => (mw[id] !== undefined && pw[id] !== undefined ? pct(spreadAprWad(mw[id]!, pw[id]!)) : "—")],
              ] as const
            ).map(([label, cell]) => (
              <tr key={label} className="border-t border-border">
                <th scope="row" className="py-1 font-normal text-muted">
                  {label}
                </th>
                {WINDOWS.map((w) => (
                  <td key={w.id} className="py-1 text-right">
                    {cell(w.id)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-muted">
          Meridian: ΔF/ΔG over the window from the indexer&apos;s mirror of the checkpoint ring (= averageFundingApr). Perpl: each FundingEventCompleted rate weighted by the blocks it was in force. &ldquo;—&rdquo; = not enough history indexed, never an estimate.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Hourly APR{MFI_URL ? " with the MFI" : ""}</h3>
          {INDEXER_URL === undefined ? (
            <EmptyState compact title="Needs the indexer" body="History is computed by the Meridian indexer, which isn't connected here." />
          ) : hours.isError || perplIdx.isError ? (
            <Notice tone="warn" title="Indexer unavailable">
              Retrying.
            </Notice>
          ) : !series ? (
            <Skeleton className="h-[244px] w-full" label="Loading funding history" />
          ) : series.length === 0 ? (
            <EmptyState compact title="No hours yet" body="Rows appear once both venues have a funding update indexed." />
          ) : (
            <MfiChart points={series} series={MFI_URL ? SERIES : SERIES.filter((s) => s.key !== "mfi")} />
          )}
        </div>
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Spread history (Meridian − Perpl)</h3>
          {series && series.some((s) => s.spread !== null && s.spread !== undefined) ? (
            <MfiChart points={series} series={[SPREAD_SERIES]} />
          ) : (
            <EmptyState compact title="No spread yet" body="Needs an hour where both venues have a rate." />
          )}
        </div>
      </div>

      <div className="mt-4 rounded-inner bg-card-2 p-3">
        <h3 className="text-xs font-medium text-muted">Net carry after fees (delta-neutral pair at the current spread)</h3>
        <div className="mt-2 flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted">Notional (AUSD)</span>
            <input inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} className="num h-9 w-32 rounded-control border border-border bg-card px-2 pointer-coarse:h-11" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Days held</span>
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="num h-9 w-20 rounded-control border border-border bg-card px-2 pointer-coarse:h-11" />
          </label>
        </div>
        {!carry ? (
          <p className="mt-2 text-[11px] text-muted">{spread === undefined ? "Needs both venues' current rate." : "Enter a notional and a number of days."}</p>
        ) : (
          <dl className="num mt-2 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <div>
              <dt className="text-muted">Pair</dt>
              <dd>
                {carry.meridianSide} Meridian · {carry.perplSide} Perpl
              </dd>
            </div>
            <div>
              <dt className="text-muted">Carry per day</dt>
              <dd>{formatAusdWad(carry.grossPerDayWad)} AUSD</dd>
            </div>
            <div>
              <dt className="text-muted">Round-trip taker fees</dt>
              <dd>{formatAusdWad(carry.roundTripFeesWad)} AUSD</dd>
            </div>
            <div>
              <dt className="text-muted">Net over {days} d</dt>
              <dd className={carry.netWad < 0n ? "text-short" : "text-long"}>
                {carry.netWad < 0n ? "−" : "+"}
                {formatAusdWad(carry.netWad < 0n ? -carry.netWad : carry.netWad)} AUSD{carry.breakEvenDays !== undefined ? ` · break-even ${carry.breakEvenDays} d` : ""}
              </dd>
            </div>
          </dl>
        )}
        <p className="mt-2 text-[10px] text-muted">
          Fees: Meridian taker {risk ? `${formatFixed(risk.takerFee * 10_000n, 18, 2)} bps` : "—"} (onchain risk params), Perpl taker {p ? `${formatFixed(p.takerFeeMicros, 2, 2)} bps` : "—"} (exchange getTakerFee, base tier), open + close on both. Assumes the spread holds; it moves every block on Meridian and every interval on Perpl.
          {mfi.data?.aprWad != null ? ` MFI now ${pct(mfi.data.aprWad)}.` : ""}
        </p>
      </div>
    </Card>
  );
}
