"use client";
import { useAccountAddress, useMarket, useOpenOrders, usePositions, useSwap } from "@/data/hooks";
import { useTx } from "@/components/Wallet";
import { orderBookAbi } from "@/lib/abi";
import { sendTx } from "@/lib/tx";
import { closeOrder, marketLimitTick } from "@/lib/orders";
import { contractAddress } from "@/config/deployments";
import { useChainId } from "wagmi";
import { PERP_LOT_SIZE_WAD, PERP_TICK_SIZE_WAD } from "@/lib/units";
import { Card, Row, Skeleton, toneOf } from "@/components/ui";
import { formatAprWad, formatAusdWad, formatBaseWad, formatPriceWad, formatSignedAusdWad } from "@/lib/format";
import { liquidationPriceWad, pendingFundingWad } from "@/lib/math";
import { DEFAULT_MMR_WAD, WAD } from "@/lib/units";

export default function PositionsPage() {
  const me = useAccountAddress();
  const { data: m } = useMarket();
  const { data: perps } = usePositions(me);
  const { data: swap } = useSwap(me);
  const { data: orders } = useOpenOrders(me);
  const chainId = useChainId();
  const ob = contractAddress(chainId, "OrderBook");
  const tx = useTx();

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Positions</h1>
      {tx.status && <p className="num break-all text-[11px] text-muted" data-testid="tx-status">{tx.status}</p>}
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
            const p0 = p;
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
                  <button
                    type="button"
                    disabled={!tx.ready || tx.busy}
                    onClick={() =>
                      tx.run("close", (p, w) => {
                        const c = closeOrder(p0.size, PERP_LOT_SIZE_WAD);
                        if (!c || !ob) throw new Error("nothing to close");
                        return sendTx(p, w, { address: ob, abi: orderBookAbi, functionName: "placeMarketOrder", args: [c.isBid, c.lots, marketLimitTick(m.lastMarkPrice, PERP_TICK_SIZE_WAD, c.isBid, 100), 1n, true] });
                      })
                    }
                    className="h-10 rounded-xl bg-surface-2 text-sm disabled:text-muted"
                  >
                    Close
                  </button>
                </div>
              </Card>
            );
          })
      )}

      {(orders ?? []).length > 0 && (
        <Card title="Open orders">
          <ul className="space-y-2 text-xs">
            {(orders ?? []).map((o) => (
              <li key={o.id.toString()} className="num flex items-center justify-between">
                <span className={o.isBid ? "text-long" : "text-short"}>{o.isBid ? "Bid" : "Ask"} {formatPriceWad(o.priceWad)}</span>
                <span>{o.lots.toString()} lots</span>
                <button
                  type="button"
                  disabled={!tx.ready || tx.busy}
                  onClick={() => tx.run("cancel", (p, w) => sendTx(p, w, { address: ob!, abi: orderBookAbi, functionName: "cancelOrder", args: [o.id] }))}
                  className="rounded-md bg-surface-2 px-2 py-1"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </Card>
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
