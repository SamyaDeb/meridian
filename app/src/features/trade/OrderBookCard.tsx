"use client";
import { useMemo, useState } from "react";
import { useDepth, useTrades } from "@/data/hooks";
import { Card, EmptyState, PillTabs, Skeleton } from "@/components/ds";
import { GROUPINGS, aggregateLevels, ladder, spread, totalSize, type LadderRow } from "@/lib/book";
import { formatAusdWad, formatBaseWad, formatFixed, formatPriceWad } from "@/lib/format";
import { WAD } from "@/lib/units";
import { usePerpMarket } from "@/data/market";
import { setDraft } from "./draft";
import { depthPaths } from "@/lib/depth";
import { PERPL_ENABLED } from "@/features/chart/datafeed/perpl";
import { PerplBook } from "./PerplBook";

const LEVELS = 12; // per side on screen (§6.2)
// fetched so coarser groupings still fill rows; getDepth reverts BatchTooLarge above MeridianConstants.MAX_BATCH (32)
const RAW_LEVELS = 32;
type View = "both" | "bids" | "asks";
type Unit = "BASE" | "AUSD";

const sizeText = (r: { sizeWad: bigint; priceWad: bigint }, unit: Unit, dp: number) => (unit === "BASE" ? formatBaseWad(r.sizeWad, dp) : formatAusdWad((r.sizeWad * r.priceWad) / WAD));
const cumText = (r: LadderRow, unit: Unit, dp: number) => (unit === "BASE" ? formatBaseWad(r.cumSizeWad, dp) : formatAusdWad(r.cumNotionalWad));
/** Market-aware formatters (K7): price at the market's tick, size at its lot precision. */
function useFmt() {
  const pm = usePerpMarket();
  return { pm, fp: (v: bigint) => formatPriceWad(v, pm.tickSizeWad), fb: (v: bigint) => formatBaseWad(v, pm.sizeDp) };
}

function Level({ r, side, unit }: { r: LadderRow; side: "bid" | "ask"; unit: Unit }) {
  const { pm, fp, fb } = useFmt();
  return (
    <li>
      <button
        type="button"
        onClick={() => setDraft({ kind: "limit", limitPx: fp(r.priceWad).replace(/,/g, "") })}
        title={`Sweep to here: ${fb(r.cumSizeWad)} ${pm.base} at avg ${fp(r.avgPriceWad)}. Click to use this price.`}
        aria-label={`${side === "bid" ? "Bid" : "Ask"} ${fp(r.priceWad)}, ${sizeText(r, unit, pm.sizeDp)} ${unit === "BASE" ? pm.base : unit}. Use as limit price.`}
        className="num relative grid h-[25px] w-full grid-cols-3 items-center px-3 text-xs hover:bg-card-2 pointer-coarse:h-11"
      >
        <span className={`absolute inset-y-0 left-0 ${side === "bid" ? "bg-long/15" : "bg-short/15"}`} style={{ width: `${r.depthBps / 100}%` }} aria-hidden />
        <span className={`relative text-left ${side === "bid" ? "text-long" : "text-short"}`}>{fp(r.priceWad)}</span>
        <span className="relative text-right">{sizeText(r, unit, pm.sizeDp)}</span>
        <span className="relative text-right text-muted">{cumText(r, unit, pm.sizeDp)}</span>
      </button>
    </li>
  );
}

function Book() {
  const { pm, fp } = useFmt();
  const { data, isError } = useDepth(RAW_LEVELS);
  const [group, setGroup] = useState<bigint>(1n);
  const [view, setView] = useState<View>("both");
  const [unit, setUnit] = useState<Unit>("BASE");
  const book = useMemo(() => {
    if (!data) return undefined;
    const bids = aggregateLevels(data.bids, pm.tickSizeWad, group, "bid").slice(0, LEVELS);
    const asks = aggregateLevels(data.asks, pm.tickSizeWad, group, "ask").slice(0, LEVELS);
    const scale = totalSize(bids) > totalSize(asks) ? totalSize(bids) : totalSize(asks);
    return { bids: ladder(bids, scale), asks: ladder(asks, scale), spread: spread(data.bids[0]?.priceWad, data.asks[0]?.priceWad) };
  }, [data, group, pm.tickSizeWad]);
  const ctl = "h-7 rounded-control bg-transparent pr-1 text-xs text-text hover:bg-card-2 pointer-coarse:h-11";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-1 px-2 py-1">
        <select aria-label="Price grouping" value={group.toString()} onChange={(e) => setGroup(BigInt(e.target.value))} className={ctl}>
          {GROUPINGS.map((g) => (
            <option key={g.toString()} value={g.toString()}>
              {formatFixed(g * pm.tickSizeWad, 18, pm.priceDp)}
            </option>
          ))}
        </select>
        <select aria-label="Size unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={ctl}>
          <option value="BASE">{pm.base}</option>
          <option value="AUSD">AUSD</option>
        </select>
        <select aria-label="Book view" value={view} onChange={(e) => setView(e.target.value as View)} className={ctl}>
          <option value="both">Both</option>
          <option value="bids">Bids</option>
          <option value="asks">Asks</option>
        </select>
      </div>
      <div className="grid grid-cols-3 px-3 pb-1 text-xs text-muted">
        <span>Price</span>
        <span className="text-right">Size ({unit === "BASE" ? pm.base : unit})</span>
        <span className="text-right">Total</span>
      </div>
      {isError ? (
        <EmptyState title="Book unavailable" body="The order book could not be read. Retrying." />
      ) : !book ? (
        <Skeleton className="h-64 w-full" label="Loading order book" />
      ) : book.bids.length === 0 && book.asks.length === 0 ? (
        <EmptyState title="Empty book" body="No resting orders yet." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="book-ladder">
          {view !== "bids" && (
            <ul aria-label="Asks" className="flex flex-col-reverse">
              {book.asks.map((r) => (
                <Level key={r.priceWad.toString()} r={r} side="ask" unit={unit} />
              ))}
            </ul>
          )}
          <div className="num flex h-[25px] items-center justify-center gap-6 bg-card-2 px-3 text-xs" data-testid="spread">
            <span>Spread</span>
            <span>{book.spread ? fp(book.spread.absWad) : "—"}</span>
            <span>{book.spread ? `${formatFixed(book.spread.bps * 10n ** 16n, 18, 3)}%` : "—"}</span>
          </div>
          {view !== "asks" && (
            <ul aria-label="Bids">
              {book.bids.map((r) => (
                <Level key={r.priceWad.toString()} r={r} side="bid" unit={unit} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Trades() {
  const { pm, fp, fb } = useFmt();
  const { data, isError } = useTrades(40);
  if (isError) return <EmptyState title="Trades unavailable" body="Retrying." />;
  if (!data) return <Skeleton className="h-64 w-full" label="Loading trades" />;
  if (data.length === 0) return <EmptyState title="No trades yet" body="Trades in the recent window appear here." />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="grid grid-cols-4 px-3 py-1 text-xs text-muted">
        <span>Price</span>
        <span className="text-right">Size ({pm.base})</span>
        <span className="text-right">Time</span>
        <span className="text-right">Block</span>
      </div>
      <ul aria-label="Recent trades">
        {data.map((t) => (
          <li key={t.id} className="num grid h-[25px] grid-cols-4 items-center px-3 text-xs">
            <span className={t.takerIsBid ? "text-long" : "text-short"}>
              {t.takerIsBid ? "▲" : "▼"} {fp(t.priceWad)}
            </span>
            <span className="text-right">{fb(t.sizeWad)}</span>
            <span className="text-right text-muted">{t.timestamp > 0n ? new Date(Number(t.timestamp) * 1_000).toISOString().slice(11, 19) : "—"}</span>
            <span className="text-right text-muted">#{t.block.toString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Order book / trades card (FRONTEND_TRADE_PLAN §6.2). Click a level to load it as the ticket's limit price. */
type Tab = "book" | "trades" | "depth" | "perpl";
/** Tabs of the book card (Hyperliquid: Order Book · Trades), then depth, then the read-only outside venue (Perpl) only
 *  with its flag, never first. Funding lives on the chart panel's "Chart | Funding" tabs. */
export const bookTabs = (perplEnabled = PERPL_ENABLED): { id: Tab; label: string }[] => [
  { id: "book", label: "Order Book" },
  { id: "trades", label: "Trades" },
  { id: "depth", label: "Depth" },
  ...(perplEnabled ? [{ id: "perpl" as const, label: "Perpl" }] : []),
];

export function OrderBookCard() {
  const [tab, setTab] = useState<Tab>("book");
  return (
    <Card className="h-full p-0!" scroll bodyClassName="flex flex-col" header={<PillTabs fill ariaLabel="Book view" value={tab} onChange={setTab} tabs={bookTabs()} />}>
      {tab === "book" ? <Book /> : tab === "trades" ? <Trades /> : tab === "perpl" ? <div className="min-h-0 flex-1 overflow-auto p-3"><PerplBook /></div> : <div className="flex min-h-0 flex-1 flex-col p-3"><Depth /></div>}
    </Card>
  );
}

/** Cumulative depth chart of the visible book (getDepth, up to 32 levels per side). */
function Depth() {
  const { pm, fp, fb } = useFmt();
  const { data } = useDepth(RAW_LEVELS);
  if (!data) return <Skeleton className="h-64 w-full" label="Loading depth" />;
  const W = 300;
  const H = 200;
  const g = depthPaths(data.bids, data.asks, W, H);
  if (!g) return <EmptyState title="Empty book" body="No resting orders yet." />;
  const path = (pts: { x: number; y: number }[]) => (pts.length ? `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")}` : "");
  const area = (pts: { x: number; y: number }[]) => (pts.length ? `${path(pts)}L${pts[pts.length - 1]!.x.toFixed(1)},${H}L${pts[0]!.x.toFixed(1)},${H}Z` : "");
  const lo = data.bids[data.bids.length - 1]?.priceWad ?? data.asks[0]?.priceWad;
  const hi = data.asks[data.asks.length - 1]?.priceWad ?? data.bids[0]?.priceWad;
  return (
    <figure className="flex min-h-0 flex-1 flex-col" data-testid="depth-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full min-h-40 w-full" role="img" aria-label={`Depth: ${fb(totalSize(data.bids))} ${pm.base} bid, ${fb(totalSize(data.asks))} ${pm.base} ask`}>
        <path d={area(g.bid)} className="fill-long/15" />
        <path d={path(g.bid)} className="fill-none stroke-long" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={area(g.ask)} className="fill-short/15" />
        <path d={path(g.ask)} className="fill-none stroke-short" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="num mt-1 flex justify-between text-[10px] text-muted">
        <span>{lo !== undefined ? fp(lo) : ""}</span>
        <span>max Σ {fb(g.maxCum)} {pm.base}</span>
        <span>{hi !== undefined ? fp(hi) : ""}</span>
      </figcaption>
    </figure>
  );
}
