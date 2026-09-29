"use client";
import { useAccountAddress, useVault, useVaultSnapshots, useVaultUser } from "@/data/hooks";
import { Card, Row, Skeleton, Sparkline } from "@/components/ui";
import { formatAprWad, formatAusdToken, formatAusdWad, formatFixed } from "@/lib/format";
import { WAD } from "@/lib/units";

export default function EarnPage() {
  const me = useAccountAddress();
  const { data: v } = useVault();
  const { data: snaps } = useVaultSnapshots(168);
  const { data: u } = useVaultUser(me);
  const myValueWad = v && u ? (u.shares * v.sharePriceWad) / WAD : undefined;

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Earn the basis</h1>
      <Card title="Pulse basis vault · AUSD" right={v && <span className={`text-xs ${v.hedged ? "text-long" : "text-warn"}`}>{v.hedged ? "● Hedged" : "● Idle"}</span>}>
        {!v ? (
          <Skeleton className="h-16 w-full" />
        ) : v.hedged && v.apy24hWad !== undefined ? (
          <div>
            <div className="num text-3xl font-semibold text-long">{formatAprWad(v.apy24hWad)}</div>
            <div className="text-xs text-muted">APY, last 24 h{v.apy7dWad !== undefined && ` · 7 d ${formatAprWad(v.apy7dWad)}`}</div>
          </div>
        ) : (
          // Never show a fake APY (lane brief §3).
          <p className="text-sm text-warn">Waiting for funding. The vault earns when funding is above ~15.6% APR.</p>
        )}
        <Sparkline className="mt-3 h-16 w-full" values={(snaps ?? []).slice().reverse().map((s) => Number(s.sharePriceWad) / 1e18)} />
        <div className="mt-2 border-t border-border pt-2">
          <Row label="TVL" value={v ? `${formatAusdToken(v.navToken)} AUSD` : "—"} />
          <Row label="Share price" value={v ? formatFixed(v.sharePriceWad, 18, 6) : "—"} />
          <Row label="Funding earned" value={v ? `${formatAusdWad(v.fundingAccruedWad)} AUSD` : "—"} />
          <Row label="Depositors" value={v ? v.userCount : "—"} />
        </div>
      </Card>

      <Card title="Your deposit">
        <div className="num text-2xl font-semibold">{myValueWad !== undefined ? `${formatAusdWad(myValueWad)} AUSD` : "—"}</div>
        <div className="text-xs text-muted">Deposited {u ? formatAusdToken(u.depositedToken) : "—"} AUSD</div>
        {/* One-signature deposit: AUSD EIP-2612 permit + deposit (WS-07 task 4). */}
        <button type="button" disabled className="mt-3 h-12 w-full rounded-xl bg-accent font-semibold text-bg opacity-60">
          Log in to deposit
        </button>
        <p className="mt-2 text-[11px] text-muted">
          Deposits stay idle until the next rebalance. The vault holds spot MON and a short MON-PERP, and only takes the short when other traders are net long.
        </p>
      </Card>
    </div>
  );
}
