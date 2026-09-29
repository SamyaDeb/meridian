"use client";
import { useMemo, useState } from "react";
import { useDepth, useMarket, useTrades } from "@/data/hooks";
import { FundingTicker } from "@/components/FundingTicker";
import { Card, Row, Skeleton } from "@/components/ui";
import { formatAusdWad, formatBaseWad, formatLeverageWad, formatPriceWad } from "@/lib/format";
import { initialMarginWad, liquidationPriceWad } from "@/lib/math";
import { DEFAULT_IMR_WAD, DEFAULT_MMR_WAD, MAX_LEVERAGE, PERP_LOT_SIZE_WAD, WAD } from "@/lib/units";

const LOT_STEPS = [1, 5, 10, 50, 100, 250, 500, 1_000]; // lots of 100 MON

export default function TradePage() {
  const { data: m } = useMarket();
  const { data: book } = useDepth(6);
  const { data: trades } = useTrades(8);
  const [side, setSide] = useState<"long" | "short">("long");
  const [lotIdx, setLotIdx] = useState(3);
  const [lev, setLev] = useState(3);

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

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-xs text-muted">MON-PERP · AUSD</div>
          <div className="num text-3xl font-semibold">{m ? formatPriceWad(m.lastMarkPrice) : <Skeleton className="h-9 w-32" />}</div>
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
              className={`h-10 rounded-lg text-sm font-semibold capitalize ${side === s ? (s === "long" ? "bg-long text-bg" : "bg-short text-bg") : "text-muted"}`}
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
        <button type="button" disabled className={`mt-3 h-12 w-full rounded-xl font-semibold text-bg opacity-60 ${side === "long" ? "bg-long" : "bg-short"}`}>
          Log in to {side}
        </button>
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
    </div>
  );
}
