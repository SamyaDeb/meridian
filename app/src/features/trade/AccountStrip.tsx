"use client";
import { useAccount } from "wagmi";
import { useAccountAddress, useAccountView } from "@/data/hooks";
import { useDataSource } from "@/data/context";
import { Card } from "@/components/ds";
import { Private } from "@/components/Private";
import { freeCollateralWad, health, marginRatioWad } from "@/lib/account";
import { formatAusdWad, formatFixed } from "@/lib/format";

const BAR = { safe: "bg-long", warn: "bg-warn", danger: "bg-short" } as const;
const TXT = { safe: "text-long", warn: "text-warn", danger: "text-short" } as const;

/**
 * What a trader needs at a glance while placing orders (beside the market strip): equity, free collateral (what the
 * ticket can still use) and the margin ratio with a health bar (distance to liquidation). Full breakdown: Positions.
 */
export function AccountStrip() {
  const ds = useDataSource();
  const { isConnected } = useAccount();
  const me = useAccountAddress();
  const { data: a, isPending, fetchStatus } = useAccountView(me);
  const disconnected = isPending && fetchStatus === "idle";
  const ratio = a ? marginRatioWad(a) : undefined;
  const h = a ? health(a) : "safe";
  const pct = a ? (ratio === undefined ? 100 : Math.min(100, Number((ratio * 10_000n) / 10n ** 18n) / 100)) : 0;
  const cell = "min-w-0";
  const label = "truncate text-[11px] text-muted";
  const value = "num truncate text-sm font-semibold";
  return (
    <Card as="section" aria-label="Account summary" className="h-full p-3!" bodyClassName="flex h-full flex-col justify-center gap-2">
      {disconnected && ds.kind === "chain" ? (
        <p className="text-xs text-muted">Connect a wallet to see equity, free collateral and your margin ratio.</p>
      ) : !a ? (
        <p className="text-xs text-muted">{isPending ? "Loading account…" : "No deposit yet: deposit AUSD from the ticket."}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className={cell}>
              <div className={label}>Equity{ds.kind === "mock" && !isConnected ? " (sample)" : ""}</div>
              <div className={value}>
                <Private kind="balance">{formatAusdWad(a.equity)}</Private>
              </div>
            </div>
            <div className={cell}>
              <div className={label}>Free collateral</div>
              <div className={value}>
                <Private kind="balance">{formatAusdWad(freeCollateralWad(a))}</Private>
              </div>
            </div>
            <div className={cell}>
              <div className={label}>Margin ratio</div>
              <div className={`${value} ${TXT[h]}`} data-testid="margin-ratio">
                {ratio === undefined ? "liq." : `${formatFixed(ratio * 100n, 18, 1)}%`}
              </div>
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-card-2" role="meter" aria-label="Margin ratio" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={`h-full rounded-full ${BAR[h]}`} style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
    </Card>
  );
}
