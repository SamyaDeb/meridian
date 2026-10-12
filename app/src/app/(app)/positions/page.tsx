"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { INDEXER_URL, useAccountAddress, useAccountView, useFundingSettlements, usePortfolio, useRiskParams, useSwap } from "@/data/hooks";
import { sumTotals } from "@/data/indexer/portfolio";
import { usePerpMarket } from "@/data/market";
import { Row, Sparkline, toneOf } from "@/components/ui";
import { Button, Card, EmptyState, NumberCell, PageHeader, PillTabs, StatCard, Tooltip } from "@/components/ds";
import { Private } from "@/components/Private";
import { PositionsCard } from "@/features/trade/PositionsCard";
import { FundsDialog } from "@/features/trade/FundsDialog";
import { freeCollateralWad, marginRatioWad } from "@/lib/account";
import { formatAprWad, formatAusdWad, formatBaseWad, formatFixed, formatSignedAusdWad } from "@/lib/format";

/** A label with an explanation (Hyperliquid's dotted-underline terms). */
const Term = ({ children, tip }: { children: ReactNode; tip: ReactNode }) => (
  <Tooltip content={tip}>
    <span className="dotted">{children}</span>
  </Tooltip>
);

const pctOfWad = (w: bigint) => `${formatFixed(w * 100n, 18, 3)}%`;

/**
 * Portfolio, Hyperliquid layout: title + account actions; stacked stat cards · account summary list · chart card;
 * the same positions / orders / history tables as Trade, full width; funding swaps.
 */
export default function PortfolioPage() {
  const pm = usePerpMarket();
  const me = useAccountAddress();
  const { isConnected } = useAccount();
  const { data: a } = useAccountView(me);
  const { data: risk } = useRiskParams();
  const { data: swap } = useSwap(me);
  const { data: settle } = useFundingSettlements(me);
  const { data: pf } = usePortfolio(me);
  const all = pf ? sumTotals(pf.markets) : undefined;
  const [funds, setFunds] = useState<"deposit" | "withdraw" | null>(null);
  const [chart, setChart] = useState<"value" | "pnl" | "funding">("funding");
  const ratio = a ? marginRatioWad(a) : undefined;
  const free = a ? freeCollateralWad(a) : undefined;
  const money = (v: bigint | undefined) => (v === undefined ? "$0.00" : <Private kind="balance">${formatAusdWad(v)}</Private>);

  // cumulative funding received (+) / paid (−), oldest → newest, for the Funding chart
  const items = settle?.items ?? [];
  const cumulative = items
    .slice()
    .reverse()
    .reduce<number[]>((acc, f) => [...acc, (acc.at(-1) ?? 0) + Number(-f.payment / 10n ** 12n) / 1e6], []);

  return (
    <div className="space-y-3">
      <PageHeader
        title="Portfolio"
        actions={
          <>
            <Link href="/fix" className="inline-flex min-h-10 items-center rounded-control border border-brand-soft/45 px-4 text-sm font-medium text-brand-soft hover:border-brand-soft/80 hover:bg-brand-soft/10 pointer-coarse:min-h-11">
              Fix Funding
            </Link>
            <Link href="/earn" className="inline-flex min-h-10 items-center rounded-control border border-brand-soft/45 px-4 text-sm font-medium text-brand-soft hover:border-brand-soft/80 hover:bg-brand-soft/10 pointer-coarse:min-h-11">
              Basis Vault
            </Link>
            <Button variant="outline" disabled={!isConnected} onClick={() => setFunds("withdraw")}>
              Withdraw
            </Button>
            <Button variant="brand" className="min-w-28" disabled={!isConnected} onClick={() => setFunds("deposit")}>
              Deposit
            </Button>
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-4">
        {/* left column: two stacked stat cards */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <StatCard
            label="Equity"
            value={money(a?.equity)}
            sub={
              <Link href="/trade" className="text-brand-soft hover:underline">
                Trade MON-PERP
              </Link>
            }
          />
          <StatCard
            label="Fees (Taker / Maker)"
            right={<span className="text-sm text-text">Perps</span>}
            value={risk ? `${pctOfWad(risk.takerFee)} / ${pctOfWad(risk.makerFee)}` : "— / —"}
            sub={<span className="text-muted">{risk && risk.makerFee < 0n ? "Negative maker fee = rebate" : "Charged on fill notional"}</span>}
          />
        </div>

        {/* middle: account summary list */}
        <Card className="p-0!">
          <div className="flex h-12 items-center justify-between border-b border-border px-4 text-sm">
            <span>Perps · Cross margin</span>
            <span className="text-muted">AUSD</span>
          </div>
          <div className="px-4 pb-3 pt-2">
            <Row label="Equity" value={money(a?.equity)} />
            <Row label={<Term tip="Unrealized profit or loss of the open position at the mark price.">Unrealized PnL</Term>} value={a ? <Private kind="pnl"><NumberCell value={a.unrealizedPnl} format={formatAusdWad} signed flash={false} /></Private> : "$0.00"} />
            <Row label={<Term tip="Funding accrued every block and settled on your next account touch. + = you receive.">Pending Funding</Term>} value={a ? <Private kind="pnl"><NumberCell value={-a.pendingFunding} format={formatAusdWad} signed flash={false} /></Private> : "$0.00"} />
            <Row label="Free Collateral" value={money(free)} />
            <Row label={<Term tip="Maintenance margin ÷ equity. At 100% the account can be liquidated by anyone.">Margin Ratio</Term>} value={ratio === undefined ? (a ? "liq." : "0.00%") : `${formatFixed(ratio * 100n, 18, 2)}%`} />
            <Row label="Maintenance Margin" value={money(a?.maintenanceMargin)} />
          </div>
        </Card>

        {/* right: chart card with tabs */}
        <Card
          className="lg:col-span-2"
          header={
            <PillTabs
              ariaLabel="Portfolio chart"
              value={chart}
              onChange={setChart}
              tabs={[
                { id: "value", label: "Account Value" },
                { id: "pnl", label: "PnL" },
                { id: "funding", label: "Funding" },
              ]}
            />
          }
        >
          <div className="h-[220px]">
            {chart === "funding" ? (
              cumulative.length > 1 ? (
                <div className="flex h-full flex-col">
                  <div className="mb-2 text-xs text-muted">Cumulative funding over the last {items.length} settlements (AUSD, + = received)</div>
                  <Sparkline className="min-h-0 w-full flex-1" stroke="var(--brand-soft)" values={cumulative} />
                </div>
              ) : (
                <EmptyState title="No funding settlements yet" body={isConnected ? "Funding settles on each touch of your account; a chart appears after two settlements." : "Connect a wallet to chart your funding."} />
              )
            ) : (
              <EmptyState title="No history source yet" body="The indexer keeps per-account totals but no equity snapshots over time, so no chart is drawn rather than a reconstructed one." />
            )}
          </div>
        </Card>
      </div>

      {!isConnected && a === undefined && <p className="px-1 text-xs text-muted">Connect a wallet to see your account.</p>}
      {INDEXER_URL !== undefined && isConnected && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="all-time">
          <StatCard label="Realized PnL" value={all ? <Private kind="pnl"><NumberCell value={all.realizedPnlWad} format={formatAusdWad} signed flash={false} /></Private> : "—"} sub={<span className="text-muted">all time · indexer</span>} />
          <StatCard label="Funding (settled)" value={all ? <Private kind="pnl"><NumberCell value={-all.fundingPaidWad} format={formatAusdWad} signed flash={false} /></Private> : "—"} sub={<span className="text-muted">all time · + received</span>} />
          <StatCard label="Fees Paid" value={all ? <Private kind="pnl">{formatAusdWad(all.feesPaidWad)}</Private> : "—"} sub={<span className="text-muted">all time · rebates net</span>} />
          <StatCard label="Liquidations" value={all ? all.liquidations : "—"} sub={<span className="text-muted">all time</span>} />
        </div>
      )}

      <div className="h-[420px] lg:h-[460px]">
        <PositionsCard />
      </div>

      <Card title="Funding Swaps">
        {(swap?.positions ?? []).length === 0 ? (
          <EmptyState compact title="No swaps" body="Lock a fixed funding rate on the Fix page." action={<Link href="/fix" className="text-sm text-brand-soft hover:underline">Go to Fix</Link>} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(swap?.positions ?? []).map((s) => (
              <div key={s.id} className="rounded-inner border border-border bg-card-2/60 p-3">
                <p className="mb-1 text-sm font-medium">{s.lockedSpread ? "Locked spread" : s.size > 0n ? "Receive floating, pay fixed" : "Pay floating, receive fixed"}</p>
                <Row label="Notional" value={`${formatBaseWad(s.size < 0n ? -s.size : s.size, pm.sizeDp)} ${pm.base}`} />
                <Row label="Fixed APR" value={s.avgFixedAprWad === undefined ? "—" : formatAprWad(s.avgFixedAprWad)} />
                <Row label="Net accrued" value={formatSignedAusdWad(s.netAccrued)} tone={toneOf(s.netAccrued)} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <FundsDialog mode={funds ?? "deposit"} open={funds !== null} onClose={() => setFunds(null)} freeCollateralWad={free} />
    </div>
  );
}
