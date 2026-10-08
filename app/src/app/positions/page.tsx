"use client";
import { useAccount } from "wagmi";
import { INDEXER_URL, useAccountAddress, useAccountView, usePortfolio, useSwap } from "@/data/hooks";
import { sumTotals } from "@/data/indexer/portfolio";
import { Row, toneOf } from "@/components/ui";
import { Card, EmptyState, NumberCell } from "@/components/ds";
import { Private } from "@/components/Private";
import { PositionsCard } from "@/features/trade/PositionsCard";
import { freeCollateralWad, marginRatioWad } from "@/lib/account";
import { formatAprWad, formatAusdWad, formatBaseWad, formatFixed, formatSignedAusdWad } from "@/lib/format";
import type { ReactNode } from "react";
import { usePerpMarket } from "@/data/market";

function Kpi({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <Card as="div" className="p-3! sm:p-4!">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 truncate text-lg font-semibold">{children}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </Card>
  );
}

/** Portfolio (FRONTEND_TRADE_PLAN §7): summary cards, the same positions / orders / history card as Trade, swaps. */
export default function PositionsPage() {
  const pm = usePerpMarket();
  const me = useAccountAddress();
  const { isConnected } = useAccount();
  const { data: a } = useAccountView(me);
  const { data: swap } = useSwap(me);
  const { data: pf } = usePortfolio(me);
  const all = pf ? sumTotals(pf.markets) : undefined;
  const ratio = a ? marginRatioWad(a) : undefined;
  return (
    <div className="space-y-2">
      <header className="px-1 pt-1">
        <h1 className="text-xl font-semibold">Positions</h1>
        <p className="text-xs text-muted">Your perp account (cross margin, AUSD) and funding swaps.</p>
      </header>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Equity">{a ? <Private kind="balance">{formatAusdWad(a.equity)}</Private> : "—"}</Kpi>
        <Kpi label="Unrealized PnL">{a ? <Private kind="pnl"><NumberCell value={a.unrealizedPnl} format={formatAusdWad} signed flash={false} /></Private> : "—"}</Kpi>
        <Kpi label="Funding (pending)" sub="settles on your next touch">{a ? <Private kind="pnl"><NumberCell value={-a.pendingFunding} format={formatAusdWad} signed flash={false} /></Private> : "—"}</Kpi>
        <Kpi label="Free collateral" sub={ratio !== undefined && a?.maintenanceMargin ? `margin ratio ${formatFixed(ratio * 100n, 18, 1)}%` : undefined}>{a ? <Private kind="balance">{formatAusdWad(freeCollateralWad(a))}</Private> : "—"}</Kpi>
      </div>
      {!isConnected && a === undefined && <p className="px-1 text-[11px] text-muted">Connect a wallet to see your account.</p>}
      {INDEXER_URL !== undefined && isConnected && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="all-time">
          <Kpi label="Realized PnL" sub="all time · indexer">{all ? <Private kind="pnl"><NumberCell value={all.realizedPnlWad} format={formatAusdWad} signed flash={false} /></Private> : "—"}</Kpi>
          <Kpi label="Funding (settled)" sub="all time · + received">{all ? <Private kind="pnl"><NumberCell value={-all.fundingPaidWad} format={formatAusdWad} signed flash={false} /></Private> : "—"}</Kpi>
          <Kpi label="Fees paid" sub="all time · rebates net">{all ? <Private kind="pnl">{formatAusdWad(all.feesPaidWad)}</Private> : "—"}</Kpi>
          <Kpi label="Liquidations" sub="all time">{all ? all.liquidations : "—"}</Kpi>
        </div>
      )}
      <div className="h-[420px] lg:h-[460px]">
        <PositionsCard />
      </div>
      <Card title="Equity over time">
        <EmptyState title="No equity history source yet" body="The indexer keeps per-account totals but no equity snapshots over time, so no chart is drawn rather than a reconstructed one." />
      </Card>
      <Card title="Funding swaps">
        {(swap?.positions ?? []).length === 0 ? (
          <EmptyState title="No swaps" body="Fix your funding rate on the Fix page." action={<a href="/fix" className="text-sm text-brand-soft underline">Go to Fix</a>} />
        ) : (
          (swap?.positions ?? []).map((s) => (
            <div key={s.id} className="rounded-inner bg-card-2 p-3">
              <p className="mb-1 text-sm font-medium">{s.lockedSpread ? "Locked spread" : s.size > 0n ? "Receive floating, pay fixed" : "Pay floating, receive fixed"}</p>
              <Row label="Notional" value={`${formatBaseWad(s.size < 0n ? -s.size : s.size, pm.sizeDp)} ${pm.base}`} />
              <Row label="Fixed APR" value={s.avgFixedAprWad === undefined ? "—" : formatAprWad(s.avgFixedAprWad)} />
              <Row label="Net accrued" value={formatSignedAusdWad(s.netAccrued)} tone={toneOf(s.netAccrued)} />
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
