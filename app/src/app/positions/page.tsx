"use client";
import { useAccountAddress, useMarket, usePositions, useSwap } from "@/data/hooks";
import { Card, Row, Skeleton, toneOf } from "@/components/ui";
import { formatAprWad, formatAusdWad, formatBaseWad, formatPriceWad, formatSignedAusdWad } from "@/lib/format";
import { liquidationPriceWad, pendingFundingWad } from "@/lib/math";
import { DEFAULT_MMR_WAD, WAD } from "@/lib/units";

export default function PositionsPage() {
  const me = useAccountAddress();
  const { data: m } = useMarket();
  const { data: perps } = usePositions(me);
  const { data: swap } = useSwap(me);

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Positions</h1>
      {!perps || !m ? (
        <Skeleton className="h-40 w-full" />
      ) : perps.filter((p) => p.size !== 0n).length === 0 ? (
        <Card>
          <p className="text-sm text-muted">No open perp positions.</p>
        </Card>
      ) : (
        perps
          .filter((p) => p.size !== 0n)
          .map((p) => {
            const upnl = (p.size * m.lastMarkPrice) / WAD - p.openNotional; // MATH_SPEC §3.2 (display)
            const pending = pendingFundingWad(p.size, m.lastCumFunding, p.lastCumFunding); // + = you pay
            const equity = p.collateralWad + upnl - pending;
            const liq = liquidationPriceWad(p.entryPrice, p.collateralWad, p.size, DEFAULT_MMR_WAD);
            return (
              <Card
                key={p.id}
                title={
                  <span>
                    MON-PERP <span className={p.size > 0n ? "text-long" : "text-short"}>{p.size > 0n ? "Long" : "Short"}</span>
                  </span>
                }
                right={<span className="num text-sm">{formatBaseWad(p.size < 0n ? -p.size : p.size, 0)} MON</span>}
              >
                <div className="grid grid-cols-2 gap-x-4">
                  <Row label="Entry" value={formatPriceWad(p.entryPrice)} />
                  <Row label="Mark" value={formatPriceWad(m.lastMarkPrice)} />
                  <Row label="Unrealized" value={formatSignedAusdWad(upnl)} tone={toneOf(upnl)} />
                  <Row label="Equity" value={formatAusdWad(equity)} />
                  <Row label="Funding (live)" value={formatSignedAusdWad(-pending)} tone={toneOf(-pending)} />
                  <Row label="Funding paid" value={formatSignedAusdWad(-p.fundingPaid)} tone={toneOf(-p.fundingPaid)} />
                  <Row label="Liq. price" value={liq ? formatPriceWad(liq) : "—"} tone="warn" />
                  <Row label="Collateral" value={formatAusdWad(p.collateralWad)} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" disabled className="h-10 rounded-xl bg-surface-2 text-sm text-muted">Add margin</button>
                  <button type="button" disabled className="h-10 rounded-xl bg-surface-2 text-sm text-muted">Close</button>
                </div>
              </Card>
            );
          })
      )}

      <h2 className="pt-2 text-sm font-medium text-muted">Funding swaps</h2>
      {(swap?.positions ?? []).map((s) => (
        <Card key={s.id} title={s.lockedSpread ? "Locked spread" : s.size > 0n ? "Receive floating, pay fixed" : "Pay floating, receive fixed"}>
          <Row label="Notional" value={`${formatBaseWad(s.size < 0n ? -s.size : s.size, 0)} MON`} />
          <Row label="Fixed APR" value={s.avgFixedAprWad === undefined ? "—" : formatAprWad(s.avgFixedAprWad)} />
          <Row label="Net accrued" value={formatSignedAusdWad(s.netAccrued)} tone={toneOf(s.netAccrued)} />
        </Card>
      ))}
    </div>
  );
}
