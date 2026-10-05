"use client";
import { useMemo, useState } from "react";
import { useDepth, useTrades } from "@/data/hooks";
import { Card, EmptyState, PillTabs, Skeleton } from "@/components/ds";
import { GROUPINGS, aggregateLevels, ladder, spread, totalSize, type LadderRow } from "@/lib/book";
import { formatAusdWad, formatBaseWad, formatFixed, formatPriceWad } from "@/lib/format";
import { PERP_TICK_SIZE_WAD, WAD } from "@/lib/units";
import { setDraft } from "./draft";
import { FundingCard } from "./FundingCard";
import { depthPaths } from "@/lib/depth";

const LEVELS = 12; // per side on screen (§6.2)
// fetched so coarser groupings still fill rows; getDepth reverts BatchTooLarge above PulseConstants.MAX_BATCH (32)
const RAW_LEVELS = 32;
type View = "both" | "bids" | "asks";
type Unit = "MON" | "AUSD";

const sizeText = (r: { sizeWad: bigint; priceWad: bigint }, unit: Unit) => (unit === "MON" ? formatBaseWad(r.sizeWad, 0) : formatAusdWad((r.sizeWad * r.priceWad) / WAD));
const cumText = (r: LadderRow, unit: Unit) => (unit === "MON" ? formatBaseWad(r.cumSizeWad, 0) : formatAusdWad(r.cumNotionalWad));

function Level({ r, side, unit }: { r: LadderRow; side: "bid" | "ask"; unit: Unit }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => setDraft({ kind: "limit", limitPx: formatPriceWad(r.priceWad).replace(/,/g, "") })}
        title={`Sweep to here: ${formatBaseWad(r.cumSizeWad, 0)} MON at avg ${formatPriceWad(r.avgPriceWad)}. Click to use this price.`}
        aria-label={`${side === "bid" ? "Bid" : "Ask"} ${formatPriceWad(r.priceWad)}, ${sizeText(r, unit)} ${unit}. Use as limit price.`}
        className="num relative grid h-6 w-full grid-cols-3 items-center rounded-[6px] px-2 text-[11px] hover:bg-card-2 pointer-coarse:h-11"
      >
        <span className={`absolute inset-y-0 right-0 rounded-[6px] ${side === "bid" ? "bg-long/12" : "bg-short/12"}`} style={{ width: `${r.depthBps / 100}%` }} aria-hidden />
        <span className={`relative text-left ${side === "bid" ? "text-long" : "text-short"}`}>{formatPriceWad(r.priceWad)}</span>
        <span className="relative text-right">{sizeText(r, unit)}</span>
        <span className="relative text-right text-muted">{cumText(r, unit)}</span>
      </button>
    </li>
  );
}

function Book() {
  const { data, isError } = useDepth(RAW_LEVELS);
  const [group, setGroup] = useState<bigint>(1n);
  const [view, setView] = useState<View>("both");
  const [unit, setUnit] = useState<Unit>("MON");
  const book = useMemo(() => {
    if (!data) return undefined;
    const bids = aggregateLevels(data.bids, PERP_TICK_SIZE_WAD, group, "bid").slice(0, LEVELS);
    const asks = aggregateLevels(data.asks, PERP_TICK_SIZE_WAD, group, "ask").slice(0, LEVELS);
    const scale = totalSize(bids) > totalSize(asks) ? totalSize(bids) : totalSize(asks);
    return { bids: ladder(bids, scale), asks: ladder(asks, scale), spread: spread(data.bids[0]?.priceWad, data.asks[0]?.priceWad) };
  }, [data, group]);
  const ctl = "h-7 rounded-full bg-card-2 px-2 text-[11px] text-muted pointer-coarse:h-11";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <select aria-label="Price grouping" value={group.toString()} onChange={(e) => setGroup(BigInt(e.target.value))} className={ctl}>
          {GROUPINGS.map((g) => (
            <option key={g.toString()} value={g.toString()}>
              {formatFixed(g * PERP_TICK_SIZE_WAD, 18, 6)}
            </option>
          ))}
        </select>
        <select aria-label="Size unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={ctl}>
          <option value="MON">MON</option>
          <option value="AUSD">AUSD</option>
        </select>
        <select aria-label="Book view" value={view} onChange={(e) => setView(e.target.value as View)} className={ctl}>
          <option value="both">Both</option>
          <option value="bids">Bids</option>
          <option value="asks">Asks</option>
        </select>
      </div>
      <div className="grid grid-cols-3 px-2 pb-1 text-[10px] text-muted">
        <span>Price</span>
        <span className="text-right">Size ({unit})</span>
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
          <div className="num my-1 flex items-center justify-between rounded-control bg-card-2 px-2 py-1 text-[11px]" data-testid="spread">
            <span className="text-muted">Spread</span>
            <span>{book.spread ? `${formatPriceWad(book.spread.absWad)} · ${formatFixed(book.spread.bps * 10n ** 16n, 18, 2)}%` : "—"}</span>
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
  const { data, isError } = useTrades(40);
  if (isError) return <EmptyState title="Trades unavailable" body="Retrying." />;
  if (!data) return <Skeleton className="h-64 w-full" label="Loading trades" />;
  if (data.length === 0) return <EmptyState title="No trades yet" body="Trades in the recent window appear here." />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="grid grid-cols-4 px-2 pb-1 text-[10px] text-muted">
        <span>Price</span>
        <span className="text-right">Size (MON)</span>
        <span className="text-right">Time</span>
        <span className="text-right">Block</span>
      </div>
      <ul aria-label="Recent trades">
        {data.map((t) => (
          <li key={t.id} className="num grid h-6 grid-cols-4 items-center px-2 text-[11px]">
            <span className={t.takerIsBid ? "text-long" : "text-short"}>
              {t.takerIsBid ? "▲" : "▼"} {formatPriceWad(t.priceWad)}
            </span>
            <span className="text-right">{formatBaseWad(t.sizeWad, 0)}</span>
            <span className="text-right text-muted">{t.timestamp > 0n ? new Date(Number(t.timestamp) * 1_000).toISOString().slice(11, 19) : "—"}</span>
            <span className="text-right text-muted">#{t.block.toString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Order book / trades card (FRONTEND_TRADE_PLAN §6.2). Click a level to load it as the ticket's limit price. */
export function OrderBookCard() {
  const [tab, setTab] = useState<"book" | "trades" | "depth" | "funding">("book");
  return (
    <Card
      className="h-full"
      scroll
      bodyClassName="flex flex-col"
      header={<PillTabs size="sm" ariaLabel="Book view" value={tab} onChange={setTab} tabs={[{ id: "book", label: "Book" }, { id: "trades", label: "Trades" }, { id: "depth", label: "Depth" }, { id: "funding", label: "Funding" }]} />}
    >
      {tab === "book" ? <Book /> : tab === "trades" ? <Trades /> : tab === "depth" ? <Depth /> : <FundingCardBody />}
    </Card>
  );
}

/** The Meridian funding card inside the book column (FRONTEND_TRADE_PLAN §6.6, chart-side tab). */
function FundingCardBody() {
  return (
    <div className="-mx-4 -mb-4 min-h-0 flex-1 overflow-auto [&>section]:border-0 [&>section]:bg-transparent [&>section]:shadow-none">
      <FundingCard />
    </div>
  );
}

/** Cumulative depth chart of the visible book (getDepth, up to 32 levels per side). */
function Depth() {
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
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full min-h-40 w-full" role="img" aria-label={`Depth: ${formatBaseWad(totalSize(data.bids), 0)} MON bid, ${formatBaseWad(totalSize(data.asks), 0)} MON ask`}>
        <path d={area(g.bid)} className="fill-long/15" />
        <path d={path(g.bid)} className="fill-none stroke-long" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={area(g.ask)} className="fill-short/15" />
        <path d={path(g.ask)} className="fill-none stroke-short" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="num mt-1 flex justify-between text-[10px] text-muted">
        <span>{lo !== undefined ? formatPriceWad(lo) : ""}</span>
        <span>max Σ {formatBaseWad(g.maxCum, 0)} MON</span>
        <span>{hi !== undefined ? formatPriceWad(hi) : ""}</span>
      </figcaption>
    </figure>
  );
}
