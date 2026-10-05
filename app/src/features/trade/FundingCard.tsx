"use client";
import { Private } from "@/components/Private";
import Link from "next/link";
import { useAccountAddress, useAccountView, useFundingTicks, useMarket } from "@/data/hooks";
import { Card, Chip, Tooltip } from "@/components/ds";
import { Sparkline } from "@/components/ui";
import { formatAprWad, formatAusdWad, formatFixed, formatSignedAprWad } from "@/lib/format";
import { SECONDS_PER_DAY, fundingOverWad } from "@/lib/fundingCard";

/**
 * Meridian funding card (FRONTEND_TRADE_PLAN §6.6): the whole rate, not one number. Live per-block rate and APR,
 * realized 1h / 8h / 24h, a mini history, what the viewer pays or earns per day at their size, and the two ways to
 * act on the rate: Earn (vault, floating) and Fix (swap, fixed).
 */
export function FundingCard() {
  const { data: m } = useMarket();
  const { data: ticks } = useFundingTicks(200);
  const me = useAccountAddress();
  const { data: a } = useAccountView(me);
  const perDay = m && a && a.size !== 0n ? fundingOverWad(a.size, m.lastRate, m.lastIndexPrice, SECONDS_PER_DAY) : undefined;
  const tone = m && m.lastRateAprWad < 0n ? "text-short" : "text-long";
  return (
    <Card title="Funding, every block" right={<Chip tone="brand">Meridian rate</Chip>} aria-label="Funding" bodyClassName="space-y-2">
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className={`num text-xl font-semibold ${m ? tone : "text-muted"}`} data-testid="funding-card-apr">
            {m ? formatSignedAprWad(m.lastRateAprWad, 3) : "—.———%"}
          </div>
          <div className="text-[11px] text-muted">APR now · positive: longs pay shorts</div>
        </div>
        <Sparkline className="h-9 w-28" values={(ticks ?? []).slice().reverse().map((t) => Number(t.rateAprWad / 10n ** 12n) / 1e6)} />
      </div>
      <div className="grid grid-cols-3 gap-1 text-center">
        {(
          [
            ["1h", m?.realizedApr1hWad],
            ["8h", m?.realizedApr8hWad],
            ["24h", m?.realizedApr24hWad],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded-control bg-card-2 py-1">
            <div className="text-[10px] text-muted">realized {k}</div>
            <div className="num text-xs">{v === undefined ? "—" : formatAprWad(v)}</div>
          </div>
        ))}
      </div>
      <div className="rounded-control bg-card-2 px-2 py-1.5 text-xs" data-testid="funding-per-day">
        {perDay === undefined ? (
          <span className="text-muted">Open a position to see what you pay or earn per day at the current rate.</span>
        ) : (
          <Tooltip content="At the current rate and index; funding settles every block and the rate moves.">
            <span>
              At your size you {perDay > 0n ? "pay" : "earn"} <Private kind="pnl"><span className={`num ${perDay > 0n ? "text-short" : "text-long"}`}>{formatAusdWad(perDay < 0n ? -perDay : perDay)} AUSD</span></Private> per day
            </span>
          </Tooltip>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Link href="/earn" className="inline-flex min-h-9 items-center justify-center rounded-control bg-brand-tint text-xs font-medium text-brand-soft hover:bg-brand hover:text-on-brand pointer-coarse:min-h-11">
          Earn the rate →
        </Link>
        <Link href="/fix" className="inline-flex min-h-9 items-center justify-center rounded-control bg-card-2 text-xs font-medium hover:bg-border pointer-coarse:min-h-11">
          Fix the rate →
        </Link>
      </div>
      {m && <p className="num text-[10px] text-muted">block #{formatFixed(m.lastFundingBlock, 0, 0)}</p>}
    </Card>
  );
}
