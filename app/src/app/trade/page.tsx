"use client";
import { useMemo, useState } from "react";
import { useDepth, useMarket, useTrades } from "@/data/hooks";
import { FundingTicker } from "@/components/FundingTicker";
import { GetStarted } from "@/components/GetStarted";
import { Card, Row } from "@/components/ui";
import { formatAusdWad, formatBaseWad, formatLeverageWad, formatPriceWad } from "@/lib/format";
import { initialMarginWad, liquidationPriceWad } from "@/lib/math";
import { DEFAULT_IMR_WAD, DEFAULT_MMR_WAD, MAX_LEVERAGE, PERP_LOT_SIZE_WAD, PERP_TICK_SIZE_WAD, WAD } from "@/lib/units";
import { useTx } from "@/components/Wallet";
import { orderBookAbi } from "@/lib/abi";
import { deposit, sendTx } from "@/lib/tx";
import { marketLimitTick, priceToTick } from "@/lib/orders";
import { contractAddress } from "@/config/deployments";
import { useAccount, useChainId } from "wagmi";

const LOT_STEPS = [1, 5, 10, 50, 100, 250, 500, 1_000]; // lots of 100 MON

export default function TradePage() {
  const { data: m } = useMarket();
  const { data: book } = useDepth(6);
  const { data: trades } = useTrades(8);
  const [side, setSide] = useState<"long" | "short">("long");
  const [lotIdx, setLotIdx] = useState(3);
  const [lev, setLev] = useState(3);
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [limitPx, setLimitPx] = useState("");
  const [depositAmt, setDepositAmt] = useState("100");
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const tx = useTx();
  const ob = contractAddress(chainId, "OrderBook");
  const ch = contractAddress(chainId, "ClearingHouse");
  const ausd = contractAddress(chainId, "AUSD");

  const size = BigInt(LOT_STEPS[lotIdx] ?? 1) * PERP_LOT_SIZE_WAD;
  const signed = side === "long" ? size : -size;
  const price = m?.lastMarkPrice ?? 0n;
  const preview = useMemo(() => {
    if (price === 0n) return undefined;
    const notional = (size * price) / WAD;
    const collateral = (notional * WAD) / (BigInt(lev) * WAD); // user-chosen leverage
    const minIm = initialMarginWad(size, price, DEFAULT_IMR_WAD); // 5x cap
    const margin = collateral > minIm ? collateral : minIm;
    return { notional, margin, liq: liquidationPriceWad(price, margin, signed, DEFAULT_MMR_WAD), lev: (notional * WAD) / margin };
  }, [price, size, signed, lev]);

  const lots = BigInt(LOT_STEPS[lotIdx] ?? 1);
  const isBid = side === "long";
  const submit = () =>
    tx.run(`${kind} ${side} ${lots} lots`, (p, w) => {
      if (!ob) throw new Error("no OrderBook for this chain");
      if (kind === "market") {
        return sendTx(p, w, { address: ob, abi: orderBookAbi, functionName: "placeMarketOrder", args: [isBid, lots, marketLimitTick(price, PERP_TICK_SIZE_WAD, isBid, 50), 1n, false] });
      }
      const px = BigInt(Math.round(Number(limitPx) * 1e9)) * 10n ** 9n; // display → WAD (9 dp input precision)
      return sendTx(p, w, { address: ob, abi: orderBookAbi, functionName: "placeLimitOrder", args: [isBid, priceToTick(px, PERP_TICK_SIZE_WAD, isBid ? "bid" : "ask"), lots, 0] });
    });
  const doDeposit = () =>
    tx.run(`deposit ${depositAmt} AUSD`, (p, w) => {
      if (!ausd || !ch) throw new Error("no AUSD/ClearingHouse for this chain");
      return deposit(p, w, ausd, ch, BigInt(Math.round(Number(depositAmt) * 1e6)));
    });

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>{m?.symbol ?? "MON-PERP"} · AUSD</span>
            {m?.testMarket && (
              <span className="rounded bg-warn/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">test market</span>
            )}
          </div>
          {/* text placeholder with the same metrics as the price (no layout shift; paints with the first frame) */}
          <div className="num text-3xl font-semibold">{m ? formatPriceWad(m.lastMarkPrice) : <span className="text-muted">—.——————</span>}</div>
        </div>
        <div className="text-right text-[11px] text-muted">
          <div className="num">Index {m ? formatPriceWad(m.lastIndexPrice) : "—"}</div>
          <div className="num">OI {m ? formatBaseWad(m.openInterestLongWad, 0) : "—"} MON</div>
        </div>
      </div>

      <FundingTicker />

      <Card>
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-1">
          {(["long", "short"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`h-11 rounded-lg text-sm font-semibold capitalize ${side === s ? (s === "long" ? "bg-long text-bg" : "bg-short text-bg") : "text-muted"}`}
            >
              {s}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-xs text-muted" htmlFor="size">
          Size <span className="num float-right text-text">{formatBaseWad(size, 0)} MON</span>
        </label>
        <input id="size" type="range" min={0} max={LOT_STEPS.length - 1} value={lotIdx} onChange={(e) => setLotIdx(Number(e.target.value))} className="mt-2 w-full" />

        <label className="mt-3 block text-xs text-muted" htmlFor="lev">
          Leverage <span className="num float-right text-text">{lev}x</span>
        </label>
        <input id="lev" type="range" min={1} max={MAX_LEVERAGE} value={lev} onChange={(e) => setLev(Number(e.target.value))} className="mt-2 w-full" />

        <div className="mt-3 border-t border-border pt-2">
          <Row label="Notional" value={preview ? `${formatAusdWad(preview.notional)} AUSD` : "—"} />
          <Row label="Margin" value={preview ? `${formatAusdWad(preview.margin)} AUSD · ${formatLeverageWad(preview.lev)}` : "—"} />
          <Row label="Liq. price (est.)" value={preview?.liq ? formatPriceWad(preview.liq) : "—"} tone="warn" />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-1">
          {(["market", "limit"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`h-11 rounded-lg text-xs capitalize ${kind === k ? "bg-surface text-text" : "text-muted"}`}>
              {k}
            </button>
          ))}
        </div>
        {kind === "limit" && (
          <input aria-label="Limit price" inputMode="decimal" placeholder="Limit price (AUSD)" value={limitPx} onChange={(e) => setLimitPx(e.target.value)} className="num mt-2 h-11 w-full rounded-lg bg-surface-2 px-3 text-sm" />
        )}
        <button
          type="button"
          disabled={!isConnected || tx.busy || price === 0n}
          onClick={submit}
          className={`mt-3 h-12 w-full rounded-xl font-semibold text-bg disabled:opacity-60 ${side === "long" ? "bg-long" : "bg-short"}`}
        >
          {isConnected ? `${kind === "market" ? "Market" : "Limit"} ${side}` : `Log in to ${side}`}
        </button>
        <div className="mt-3 flex gap-2">
          <input aria-label="Deposit amount" inputMode="decimal" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} className="num h-11 flex-1 rounded-lg bg-surface-2 px-3 text-sm" />
          <button type="button" disabled={!isConnected || tx.busy} onClick={doDeposit} className="h-11 whitespace-nowrap rounded-lg bg-surface-2 px-4 text-sm disabled:opacity-60">
            Deposit AUSD
          </button>
        </div>
        {tx.status && <p className="num mt-2 break-all text-[11px] text-muted" data-testid="tx-status">{tx.status}</p>}
      </Card>

      <Card title="Order book">
        <div className="grid grid-cols-2 gap-3 text-xs">
          {(["bids", "asks"] as const).map((k) => (
            <ul key={k} className="space-y-1">
              {(book?.[k] ?? []).map((l) => (
                <li key={l.priceWad.toString()} className="num flex justify-between">
                  <span className={k === "bids" ? "text-long" : "text-short"}>{formatPriceWad(l.priceWad)}</span>
                  <span className="text-muted">{formatBaseWad(l.sizeWad, 0)}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </Card>

      <Card title="Recent trades">
        <ul className="space-y-1 text-xs">
          {(trades ?? []).map((t) => (
            <li key={t.id} className="num flex justify-between">
              <span className={t.takerIsBid ? "text-long" : "text-short"}>{formatPriceWad(t.priceWad)}</span>
              <span>{formatBaseWad(t.sizeWad, 0)}</span>
              <span className="text-muted">#{t.block.toString()}</span>
            </li>
          ))}
        </ul>
      </Card>
      <GetStarted />
    </div>
  );
}
