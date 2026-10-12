"use client";
import { Private } from "@/components/Private";
import { useState } from "react";
import { useChainId } from "wagmi";
import { useAccountAddress, useAccountHistory, useAccountView, useDepth, useFundingSettlements, useMarket, useOpenOrders, INDEXER_URL } from "@/data/hooks";
import { useDataSource } from "@/data/context";
import { Button, Card, DataTable, EmptyState, Notice, NumberCell, PillTabs, Popover, type Column } from "@/components/ds";
import { useTx } from "@/components/Wallet";
import { contractAddress } from "@/config/deployments";
import type { AccountSummary } from "@/data/types";
import type { FundingSettlement, OpenOrder } from "@/data/chain/source";
import type { HistLiquidation, HistOrder, HistTrade } from "@/data/indexer/account";
import { orderBookAbi } from "@/lib/abi";
import { sendTx } from "@/lib/tx";
import { priceToTick } from "@/lib/orders";
import { formatAusdWad, formatBaseWad, formatFixed, formatPriceWad, parseFixed, shortAddress } from "@/lib/format";
import { abs } from "@/lib/math";
import { FLAG_REDUCE_ONLY, chunk, closeLots, decodeFlags, referencePrice, slippageLimitTick } from "@/lib/ticket";
import { TriggersTable } from "@/features/triggers/TriggersTable";
import { useTriggers } from "@/features/triggers/useTriggers";
import { MAX_BATCH } from "@/lib/units";
import { usePerpMarket } from "@/data/market";

/** K7: the selected market's lot / tick and formatters (ETH-PERP: lot 0.001 ETH, tick 0.10). */
function useUnits() {
  const pm = usePerpMarket();
  return { pm, LOT: pm.lotSizeWad, TICK: pm.tickSizeWad, fp: (v: bigint) => formatPriceWad(v, pm.tickSizeWad), fb: (v: bigint) => formatBaseWad(v, pm.sizeDp) };
}

type Tab = "positions" | "orders" | "triggers" | "trades" | "history" | "funding" | "liquidations";
const CLOSE_SLIPPAGE_BPS = 100n; // 1 % bound on market closes
const inputCls = "num h-9 w-full rounded-control border border-line bg-card-2 px-2 text-xs pointer-coarse:h-11";

const flagText = (f: number) => {
  const d = decodeFlags(f);
  return [d.postOnly && "post-only", d.ioc && "IOC", d.reduceOnly && "reduce-only"].filter(Boolean).join(" · ") || "—";
};
const time = (ts: bigint) => (ts > 0n ? new Date(Number(ts) * 1_000).toISOString().replace("T", " ").slice(5, 19) : "—");

function NeedsIndexer() {
  return <EmptyState compact title="Needs the indexer" body="History comes from the Meridian indexer, which isn't connected here. Live positions and orders above are read from the chain." />;
}

/** Bottom card of the terminal (FRONTEND_TRADE_PLAN §6.5): positions, open orders and history, each action a real call. */
export function PositionsCard() {
  const { pm, LOT, TICK, fp, fb } = useUnits();
  const ds = useDataSource();
  const me = useAccountAddress();
  const chainId = useChainId();
  const ob = contractAddress(chainId, "OrderBook") ? pm.orderBook : undefined;
  const tx = useTx();
  const { data: m } = useMarket();
  const { data: book } = useDepth(32);
  const { data: a, fetchStatus, isPending } = useAccountView(me);
  const { data: orders } = useOpenOrders(me);
  const hist = useAccountHistory(me);
  const fund = useFundingSettlements(me);
  const [tab, setTab] = useState<Tab>("positions");
  const trig = useTriggers();
  const disconnected = isPending && fetchStatus === "idle";
  // undefined only while loading: a funded account with size 0 is "no open position", not "loading"
  const positions = a ? (a.size !== 0n ? [a] : []) : a === null || disconnected ? [] : undefined;
  const ready = tx.ready && !tx.busy && Boolean(ob);

  const closeMarket = (p: AccountSummary, pct: bigint) =>
    tx.run(`close ${pct}%`, (pc, w) => {
      const lots = closeLots(p.size, LOT, pct);
      if (!ob || lots === 0n || !m) throw new Error("nothing to close");
      const isBid = p.size < 0n;
      const ref = referencePrice(isBid, book?.bids[0]?.priceWad, book?.asks[0]?.priceWad, m.lastMarkPrice);
      return sendTx(pc, w, { address: ob, abi: orderBookAbi, functionName: "placeMarketOrder", args: [isBid, lots, slippageLimitTick(ref, TICK, isBid, CLOSE_SLIPPAGE_BPS), 1n, true] });
    });
  const closeLimit = (p: AccountSummary, px: string) =>
    tx.run("close at limit", (pc, w) => {
      const price = parseFixed(px, 18);
      const lots = closeLots(p.size, LOT, 100n);
      if (!ob || !price || lots === 0n) throw new Error("enter a price");
      const isBid = p.size < 0n;
      return sendTx(pc, w, { address: ob, abi: orderBookAbi, functionName: "placeLimitOrder", args: [isBid, priceToTick(price, TICK, isBid ? "bid" : "ask"), lots, FLAG_REDUCE_ONLY] });
    });
  const cancel = (o: OpenOrder) => tx.run(`cancel #${o.id}`, (pc, w) => sendTx(pc, w, { address: ob!, abi: orderBookAbi, functionName: "cancelOrder", args: [o.id] }));
  const cancelAll = () =>
    tx.run(`cancel all (${orders?.length ?? 0})`, async (pc, w) => {
      const batches = chunk((orders ?? []).map((o) => o.id), MAX_BATCH);
      let last: Awaited<ReturnType<typeof sendTx>> | undefined;
      for (const ids of batches) last = await sendTx(pc, w, { address: ob!, abi: orderBookAbi, functionName: "cancelOrders", args: [ids] });
      if (!last) throw new Error("no open orders");
      return last;
    });
  const replace = (o: OpenOrder, px: string, lotsIn: string) =>
    tx.run(`edit #${o.id}`, (pc, w) => {
      const price = parseFixed(px, 18);
      const lots = lotsIn.trim() === "" ? o.lots : BigInt(lotsIn.replace(/\D/g, "") || "0");
      if (!price || lots === 0n) throw new Error("enter price and lots");
      return sendTx(pc, w, { address: ob!, abi: orderBookAbi, functionName: "replaceOrder", args: [o.id, priceToTick(price, TICK, o.isBid ? "bid" : "ask"), lots, o.flags] });
    });

  const posCols: Column<AccountSummary>[] = [
    { key: "mkt", header: "Market", width: "minmax(120px,1.2fr)", cell: (p) => <span className={p.size > 0n ? "text-long" : "text-short"}>{`${m?.symbol ?? pm.symbol} ${p.size > 0n ? "▲ Long" : "▼ Short"}`}</span> },
    { key: "size", header: `Size (${pm.base})`, align: "right", cell: (p) => <span className="num">{fb(abs(p.size))}</span> },
    { key: "entry", header: "Entry", align: "right", cell: (p) => <span className="num">{fp(p.entryPrice)}</span> },
    { key: "mark", header: "Mark", align: "right", cell: () => <span className="num">{m ? fp(m.lastMarkPrice) : "—"}</span> },
    { key: "liq", header: "Liq.", align: "right", cell: (p) => <Private kind="liq"><span className="num text-warn">{p.liquidationPrice ? fp(p.liquidationPrice) : "—"}</span></Private> },
    { key: "margin", header: "Margin", align: "right", cell: (p) => <Private kind="balance"><span className="num">{formatAusdWad(p.maintenanceMargin)}</span></Private> },
    { key: "pnl", header: "uPnL", align: "right", cell: (p) => <Private kind="pnl"><NumberCell value={p.unrealizedPnl} format={formatAusdWad} signed flash={false} /></Private> },
    { key: "fund", header: "Funding", align: "right", cell: (p) => <Private kind="pnl"><NumberCell value={-p.pendingFunding} format={formatAusdWad} signed flash={false} /></Private> },
    {
      key: "close",
      header: "",
      align: "right",
      width: "88px",
      cell: (p) => (
        <Popover fixed label="Close position" triggerClassName="h-7 rounded-control border border-line bg-card-2 px-3 text-[11px] hover:bg-border pointer-coarse:h-11" trigger="Close">
          {(close) => <ClosePanel p={p} ready={ready} onMarket={(pct) => (close(), closeMarket(p, pct))} onLimit={(px) => (close(), closeLimit(p, px))} />}
        </Popover>
      ),
    },
  ];
  const orderCols: Column<OpenOrder>[] = [
    { key: "side", header: "Side", cell: (o) => <span className={o.isBid ? "text-long" : "text-short"}>{o.isBid ? "▲ Bid" : "▼ Ask"}</span> },
    { key: "px", header: "Price", align: "right", cell: (o) => <span className="num">{fp(o.priceWad)}</span> },
    { key: "lots", header: "Remaining", align: "right", cell: (o) => <span className="num">{fb(o.lots * LOT)} {pm.base}</span> },
    { key: "flags", header: "Flags", cell: (o) => <span className="text-muted">{flagText(o.flags)}</span> },
    { key: "blk", header: "Placed", align: "right", cell: (o) => <span className="num text-muted">#{o.placedBlock.toString()}</span> },
    {
      key: "act",
      header: "",
      align: "right",
      width: "132px",
      cell: (o) => (
        <span className="flex gap-1">
          <Popover fixed label={`Edit order ${o.id}`} triggerClassName="h-7 rounded-control border border-line bg-card-2 px-3 text-[11px] hover:bg-border pointer-coarse:h-11" trigger="Edit">
            {(close) => <EditPanel o={o} ready={ready} onSave={(px, lots) => (close(), replace(o, px, lots))} />}
          </Popover>
          <button type="button" disabled={!ready} onClick={() => cancel(o)} className="h-7 rounded-control border border-short/45 px-3 text-[11px] text-short hover:bg-short/10 disabled:opacity-40 pointer-coarse:h-11">
            Cancel
          </button>
        </span>
      ),
    },
  ];
  const tradeCols: Column<HistTrade>[] = [
    { key: "t", header: "Time (UTC)", cell: (t) => <span className="num text-muted">{time(t.timestamp)}</span> },
    { key: "side", header: "Side", cell: (t) => <span className={t.isBuy ? "text-long" : "text-short"}>{t.isBuy ? "▲ Buy" : "▼ Sell"}</span> },
    { key: "role", header: "Role", cell: (t) => <span className="text-muted">{t.isMaker ? "maker" : "taker"}</span> },
    { key: "px", header: "Price", align: "right", cell: (t) => <span className="num">{fp(t.priceWad)}</span> },
    { key: "sz", header: `Size (${pm.base})`, align: "right", cell: (t) => <span className="num">{fb(t.sizeWad)}</span> },
    { key: "n", header: "Notional", align: "right", cell: (t) => <span className="num">{formatAusdWad(t.notionalWad)}</span> },
    { key: "tx", header: "Tx", align: "right", cell: (t) => <span className="num text-muted">{shortAddress(t.txHash)}</span> },
  ];
  const histCols: Column<HistOrder>[] = [
    { key: "b", header: "Block", cell: (o) => <span className="num text-muted">#{o.updatedBlock.toString()}</span> },
    { key: "side", header: "Side", cell: (o) => <span className={o.isBid ? "text-long" : "text-short"}>{o.isBid ? "▲ Bid" : "▼ Ask"}</span> },
    { key: "px", header: "Price", align: "right", cell: (o) => <span className="num">{fp(o.tick * TICK)}</span> },
    { key: "f", header: "Filled / lots", align: "right", cell: (o) => <span className="num">{`${o.filledLots} / ${o.lots}`}</span> },
    { key: "fl", header: "Flags", cell: (o) => <span className="text-muted">{flagText(o.flags)}</span> },
    { key: "s", header: "Status", align: "right", cell: (o) => <span className={o.status === "Evicted" ? "text-warn" : "text-muted"}>{o.status}</span> },
  ];
  const fundCols: Column<FundingSettlement>[] = [
    { key: "b", header: "Block", cell: (f) => <span className="num text-muted">#{f.block.toString()}</span> },
    { key: "p", header: "Funding (you)", align: "right", cell: (f) => <NumberCell value={-f.payment} format={(v) => formatFixed(v, 18, 6)} signed flash={false} suffix="AUSD" /> },
  ];
  const liqCols: Column<HistLiquidation>[] = [
    { key: "t", header: "Time (UTC)", cell: (l) => <span className="num text-muted">{time(l.timestamp)}</span> },
    { key: "sz", header: "Size moved", align: "right", cell: (l) => <span className="num">{fb(abs(l.sizeTransferred))} {pm.base}</span> },
    { key: "mk", header: "Mark", align: "right", cell: (l) => <span className="num">{l.markPriceWad ? fp(l.markPriceWad) : "—"}</span> },
    { key: "pen", header: "Penalty", align: "right", cell: (l) => <span className="num text-short">{formatAusdWad(l.penalty)}</span> },
    { key: "bd", header: "Bad debt", align: "right", cell: (l) => <span className="num">{formatAusdWad(l.badDebt)}</span> },
  ];

  const history = (() => {
    if (disconnected) return <EmptyState compact title="Not connected" body="Connect a wallet to see your history." />;
    if (INDEXER_URL === undefined) return <NeedsIndexer />;
    if (hist.isError) return <EmptyState compact title="Indexer unavailable" body="Retrying." />;
    return undefined;
  })();

  return (
    <Card
      className="h-full"
      scroll
      header={
        <PillTabs
          size="sm"
          ariaLabel="Account tables"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "positions", label: "Positions", count: positions?.length },
            { id: "orders", label: "Open orders", count: orders?.length },
            ...(trig.client && pm.primary ? [{ id: "triggers" as const, label: "Triggers", count: trig.triggers?.length }] : []),
            { id: "trades", label: "Trade history" },
            { id: "history", label: "Order history" },
            { id: "funding", label: "Funding" },
            { id: "liquidations", label: "Liquidations" },
          ]}
        />
      }
      right={
        tab === "orders" && (orders?.length ?? 0) > 0 ? (
          <Button size="sm" variant="danger" disabled={!ready} onClick={cancelAll}>
            Cancel all
          </Button>
        ) : undefined
      }
    >
      {tx.status && (
        <Notice tone={tx.status.includes("failed") ? "danger" : "info"} className="mb-2">
          <span className="num break-all" data-testid="positions-tx-status">
            {tx.status}
          </span>
        </Notice>
      )}
      {tab === "positions" && (
        <DataTable caption="Positions" columns={posCols} rows={positions} rowKey={() => "perp"} minWidth={760} empty={<EmptyState compact title={disconnected ? "Not connected" : "No open position"} body={disconnected ? "Connect a wallet to see your position." : "Place an order from the ticket."} />} />
      )}
      {tab === "orders" && (
        <DataTable caption="Open orders" columns={orderCols} rows={disconnected && ds.kind === "chain" ? [] : orders} rowKey={(o) => o.id.toString()} minWidth={620} empty={<EmptyState compact title={disconnected ? "Not connected" : "No open orders"} />} />
      )}
      {tab === "triggers" && <TriggersTable />}
      {tab === "trades" && (history ?? <DataTable caption="Trade history" columns={tradeCols} rows={hist.data?.trades} rowKey={(t) => t.id} minWidth={640} empty={<EmptyState compact title="No trades yet" />} />)}
      {tab === "history" && (history ?? <DataTable caption="Order history" columns={histCols} rows={hist.data?.orders} rowKey={(o) => o.id} minWidth={560} empty={<EmptyState compact title="No orders yet" />} />)}
      {tab === "liquidations" && (history ?? <DataTable caption="Liquidations" columns={liqCols} rows={hist.data?.liquidations} rowKey={(l) => l.id} minWidth={520} empty={<EmptyState compact title="No liquidations" body="None on this account." />} />)}
      {tab === "funding" &&
        (disconnected ? (
          <EmptyState compact title="Not connected" body="Connect a wallet to see funding payments." />
        ) : ds.kind !== "chain" && INDEXER_URL === undefined ? (
          <EmptyState compact title="Chain data only" body="Per-block funding payments are read from FundingSettled events on the chain; the sample data layer has none." />
        ) : (
          <>
            {fund.data &&
              (fund.data.source === "indexer" ? (
                <p className="mb-1 text-[11px] text-muted">Every FundingSettled since launch, from the indexer (latest 500).</p>
              ) : (
                <p className="mb-1 text-[11px] text-muted">FundingSettled events since block #{fund.data.fromBlock.toString()} (the app&apos;s log window). Older payments are in your cumulative funding.</p>
              ))}
            <DataTable caption="Funding payments" columns={fundCols} rows={fund.data?.items} rowKey={(f) => `${f.block}-${f.payment}`} empty={<EmptyState compact title="No funding settled in the window" body="Funding settles when your account is touched (trade, deposit, withdraw)." />} />
          </>
        ))}
    </Card>
  );
}

function ClosePanel({ p, ready, onMarket, onLimit }: { p: AccountSummary; ready: boolean; onMarket: (pct: bigint) => void; onLimit: (px: string) => void }) {
  const { LOT } = useUnits();
  const [px, setPx] = useState("");
  return (
    <div className="space-y-2 p-1">
      <p className="text-[11px] text-muted">Reduce-only. Market closes accept up to 1% slippage.</p>
      <div className="grid grid-cols-3 gap-1">
        {[25n, 50n, 100n].map((pct) => (
          <Button key={pct.toString()} size="sm" disabled={!ready || closeLots(p.size, LOT, pct) === 0n} onClick={() => onMarket(pct)}>
            {pct.toString()}%
          </Button>
        ))}
      </div>
      <label className="block text-[11px] text-muted" htmlFor="close-px">
        Close all at limit price
      </label>
      <div className="flex gap-1">
        <input id="close-px" aria-label="Close limit price" inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} placeholder="0.000000" className={inputCls} />
        <Button size="sm" variant={p.size > 0n ? "short" : "long"} disabled={!ready || !parseFixed(px, 18)} onClick={() => onLimit(px)}>
          Place
        </Button>
      </div>
    </div>
  );
}

function EditPanel({ o, ready, onSave }: { o: OpenOrder; ready: boolean; onSave: (px: string, lots: string) => void }) {
  const { pm, LOT, fp, fb } = useUnits();
  const [px, setPx] = useState(fp(o.priceWad).replace(/,/g, ""));
  const [lots, setLots] = useState(o.lots.toString());
  return (
    <div className="space-y-2 p-1">
      <p className="text-[11px] text-muted">replaceOrder: cancel + place in one tx, same flags. Loses time priority.</p>
      <label className="block text-[11px] text-muted">
        Price
        <input aria-label="New price" inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} className={`${inputCls} mt-1`} />
      </label>
      <label className="block text-[11px] text-muted">
        Lots ({fb(LOT)} {pm.base} each)
        <input aria-label="New lots" inputMode="numeric" value={lots} onChange={(e) => setLots(e.target.value)} className={`${inputCls} mt-1`} />
      </label>
      <Button size="sm" variant="brand" block disabled={!ready || !parseFixed(px, 18) || !/^\d+$/.test(lots) || lots === "0"} onClick={() => onSave(px, lots)}>
        Replace order
      </Button>
    </div>
  );
}
