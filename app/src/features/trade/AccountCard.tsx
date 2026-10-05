"use client";
import { Private } from "@/components/Private";
import { useAccount } from "wagmi";
import { useAccountAddress, useAccountView } from "@/data/hooks";
import { Card, EmptyState, NumberCell, Skeleton } from "@/components/ds";
import { freeCollateralWad, health, marginRatioWad } from "@/lib/account";
import { formatAusdWad, formatFixed } from "@/lib/format";
import { useDataSource } from "@/data/context";

const HEALTH_BAR = { safe: "bg-long", warn: "bg-warn", danger: "bg-short" } as const;
const HEALTH_TEXT = { safe: "text-long", warn: "text-warn", danger: "text-short" } as const;

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className="num">{children}</span>
    </div>
  );
}

/** Account card (FRONTEND_TRADE_PLAN §6.4) from the live getAccount view. Cross margin, single collateral (AUSD). */
export function AccountCard({ actions }: { actions?: React.ReactNode }) {
  const ds = useDataSource();
  const { isConnected } = useAccount();
  const me = useAccountAddress();
  const { data: a, isPending, isError } = useAccountView(me);
  const viewingMock = ds.kind === "mock" && !isConnected;
  const ratio = a ? marginRatioWad(a) : undefined;
  const h = a ? health(a) : "safe";
  const pct = ratio === undefined ? 100 : Math.min(100, Number((ratio * 10_000n) / 10n ** 18n) / 100);
  return (
    <Card title="Account" right={viewingMock ? <span className="text-[11px] text-warn">sample account</span> : undefined} className="h-full" scroll>
      {!isConnected && ds.kind !== "mock" ? (
        <EmptyState title="Not connected" body="Connect a wallet to see equity, margin and free collateral." />
      ) : isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <EmptyState title="Account unavailable" body="The account view could not be read. Retrying." />
      ) : !a ? (
        <EmptyState title="No deposit yet" body="Deposit AUSD to start trading." action={actions} />
      ) : (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted">Equity</span>
            <span className="text-lg font-semibold">
              <Private kind="balance"><NumberCell value={a.equity} format={formatAusdWad} suffix="AUSD" /></Private>
            </span>
          </div>
          <div className="pt-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted">Margin ratio</span>
              <span className={`num ${HEALTH_TEXT[h]}`} data-testid="margin-ratio">
                {ratio === undefined ? "liquidatable" : `${formatFixed(ratio * 100n, 18, 1)}%`}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-card-2" role="meter" aria-label="Margin ratio" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div className={`h-full rounded-full ${HEALTH_BAR[h]}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="pt-1">
            <Line label="Collateral"><Private kind="balance">{formatAusdWad(a.collateral)}</Private></Line>
            <Line label="Unrealized PnL">
              <Private kind="pnl"><NumberCell value={a.unrealizedPnl} format={formatAusdWad} signed flash={false} /></Private>
            </Line>
            <Line label="Funding (pending)">
              {/* pendingFunding + = owed by the account; shown as the account's PnL sign */}
              <Private kind="pnl"><NumberCell value={-a.pendingFunding} format={formatAusdWad} signed flash={false} /></Private>
            </Line>
            <Line label="Margin used"><Private kind="balance">{formatAusdWad(a.initialMargin)}</Private></Line>
            <Line label="Maintenance"><Private kind="balance">{formatAusdWad(a.maintenanceMargin)}</Private></Line>
            <Line label="Free collateral"><Private kind="balance">{formatAusdWad(freeCollateralWad(a))}</Private></Line>
          </div>
          {actions && <div className="flex gap-2 pt-2">{actions}</div>}
        </div>
      )}
    </Card>
  );
}
