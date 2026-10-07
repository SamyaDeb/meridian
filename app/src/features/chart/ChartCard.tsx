"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFundingTicks, useIndexerCandles, useMarket, useTrades, INDEXER_URL } from "@/data/hooks";
import { Chip, Notice } from "@/components/ds";
import { useNow } from "@/lib/useNow";
import { BLOCK_TIME_MS } from "@/lib/units";
import Image from "next/image";
import { aggregate, applyTrade, pointsToBars, toBar } from "./datafeed/candles";
import { recordSample, sessionSamples } from "./datafeed/session";
import { usePerpMarket } from "@/data/market";
import { REFERENCE_ENABLED, UPSTREAM_OF, geckoToBars } from "./datafeed/reference";
import { PERPL_ENABLED, PERPL_RES_OF, PERPL_VENUE, perplToBars, type PerplCandlesPayload } from "./datafeed/perpl";
import { SeriesNotes } from "./chrome/SeriesNotes";
import { ALIGN_OFFSET_SEC, SOURCE_OF, TIMEFRAME_SEC, isOutside, type Bar, type PriceSource, type Timeframe } from "./datafeed/types";
import { LightweightEngine } from "./engine/LightweightEngine";
import type { ChartCoords, LineOverlay, PaneSpec, PriceLineSpec } from "./engine/types";
import { estimateBlockTimeSec, wadToNum } from "./series";
import { DEFAULT_VIEW, setView, useChartView } from "./store";
import { DrawingLayer } from "./drawings/DrawingLayer";
import { ChartToolbar } from "./chrome/ChartToolbar";
import { ChartFooter, historyNote } from "./chrome/ChartFooter";
import { ToolRail } from "./chrome/ToolRail";
import { rangeWindow, type RangeId } from "./chrome/ranges";
import { useFullscreen } from "./chrome/useFullscreen";
import { useDrawings } from "./drawings/useDrawings";
import { buildIndicators } from "./indicators/build";

// Indexer rows fetched per timeframe (coarse frames aggregate many source candles; Hasura limit stays modest)
const LIMIT: Record<Timeframe, number> = { "1m": 500, "3m": 1_000, "5m": 1_500, "15m": 2_000, "30m": 2_000, "1h": 500, "2h": 1_000, "4h": 1_500, "6h": 2_000, "12h": 2_000, "1D": 2_000, "1W": 2_000 };
const MARK_ROWS = 2_000; // FundingTick is one row per block: the most recent 2,000 blocks (~10 min at 300 ms)
const INDEX_ROWS = 2_000; // OraclePrice is one row per oracle update
const SOURCE_NAME: Record<PriceSource, string> = { last: "Last", mark: "Mark", index: "Index", reference: "Reference", perpl: "Reference" };
/** Venue named in the legend for each source (outside venues by name, never "Meridian"). */
const VENUE: Record<PriceSource, string> = { last: "Meridian", mark: "Meridian", index: "Meridian", reference: "Uniswap v4 · GeckoTerminal", perpl: PERPL_VENUE };

/** Dedupes by second (several 300 ms blocks share a second; the chart needs strictly increasing times): keeps the last. */
function bySecond(points: { time: number; value: number }[]) {
  const m = new Map<number, number>();
  for (const p of points) m.set(p.time, p.value);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

export type ChartCardProps = {
  /** extra price lines (position entry / liquidation, resting orders, triggers) */
  priceLines?: PriceLineSpec[];
  overlays?: LineOverlay[];
  panes?: PaneSpec[];
  onPriceClick?: (priceWad: bigint) => void;
  toolbarExtra?: ReactNode;
};

type Hover = { time: number; open: number; high: number; low: number; close: number } | null;

/**
 * Meridian's price chart (top bar · tool rail · chart · bottom bar, Monad theme; bars per CHART_TOPBAR_SPEC.md) with Meridian's data and features:
 * candles of the MON-PERP book from the indexer (or the mark / oracle index series), live last-trade overlay, mark /
 * index / position / order / trigger lines, per-block funding and premium panes, indicators, drawings, click-to-limit.
 * Never backfilled: "history starts at …".
 */
export function ChartCard({ priceLines = [], overlays = [], panes = [], onPriceClick }: ChartCardProps) {
  const { data: m } = useMarket();
  const pm = usePerpMarket();
  const market = m?.clearingHouse ?? pm.clearingHouse;
  // the DEX reference is MON/USD: offered on MON-PERP only (K7)
  const refOk = REFERENCE_ENABLED && pm.primary;
  const storedView = useChartView(market);
  const view = !refOk && storedView.source === "reference" ? { ...storedView, source: "last" as const } : storedView;
  const tf = view.timeframe;
  const sec = TIMEFRAME_SEC[tf];
  const offset = ALIGN_OFFSET_SEC[tf] ?? 0;
  const candles = useIndexerCandles(SOURCE_OF[tf], LIMIT[tf]);
  const marks = useQuery({
    queryKey: ["markPoints", INDEXER_URL, market],
    queryFn: async ({ signal }) => (await import("@/data/indexer/prices")).fetchMarkPoints(INDEXER_URL!, market, MARK_ROWS, signal),
    enabled: view.source === "mark" && INDEXER_URL !== undefined && m !== undefined,
    refetchInterval: 3_000,
    retry: 1,
  });
  const oracle = m?.oracle;
  const index = useQuery({
    queryKey: ["indexPoints", INDEXER_URL, oracle],
    queryFn: async ({ signal }) => (await import("@/data/indexer/prices")).fetchIndexPoints(INDEXER_URL!, oracle!, INDEX_ROWS, signal),
    enabled: view.source === "index" && INDEXER_URL !== undefined && oracle !== undefined,
    refetchInterval: 15_000,
    retry: 1,
  });
  // labelled outside reference (flag only): GeckoTerminal MON/USDC candles through our server route, which caches them
  // 60 s for every viewer (keyless limit); never fetched from the browser directly, never faster than once a minute
  const reference = useQuery({
    queryKey: ["referenceCandles", tf],
    queryFn: async ({ signal }) => {
      const u = UPSTREAM_OF[tf];
      const r = await fetch(`/api/reference-candles?timeframe=${u.timeframe}&aggregate=${u.aggregate}`, { signal });
      const body: unknown = await r.json().catch(() => null);
      if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      return geckoToBars(body, tf);
    },
    enabled: view.source === "reference" && refOk,
    refetchInterval: 60_000,
    retry: 1,
  });
  // labelled outside venue (flag only): Perpl's MON perp candles (Monad mainnet) through our server route, cached there
  const perpl = useQuery({
    queryKey: ["perplCandles", tf],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/perpl/candles?res=${PERPL_RES_OF[tf]}`, { signal });
      const body: unknown = await r.json().catch(() => null);
      if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      return perplToBars(body as PerplCandlesPayload, tf);
    },
    enabled: view.source === "perpl" && PERPL_ENABLED,
    refetchInterval: 30_000,
    retry: 1,
  });
  const { data: trades } = useTrades(40);
  const { data: ticks } = useFundingTicks(200); // same query as the funding ticker (one RPC scan, shared cache)
  const now = useNow(1_000);
  const [resetKey, setResetKey] = useState(0);
  const [coords, setCoords] = useState<ChartCoords | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const [range, setRange] = useState<RangeId | null>(null);
  const pendingRange = useRef<{ from?: number; to?: number } | null>(null);
  const shell = useRef<HTMLElement>(null);
  const draw = useDrawings(market);

  const { full: fs, toggle: toggleFullscreen } = useFullscreen(shell);

  // record the mark and index the app reads every block (session history when the indexer is not connected)
  useEffect(() => {
    if (m) recordSample(market, { time: Math.floor(Date.now() / 1_000), mark: m.lastMarkPrice, index: m.lastIndexPrice });
  }, [m, market]);
  const sessionMode = INDEXER_URL === undefined;

  const blockMs = m && m.blockTimeMs > 0n ? Number(m.blockTimeMs) : BLOCK_TIME_MS;
  const timeOf = (block: bigint, timestamp: bigint) => (timestamp > 0n ? Number(timestamp) : m && now > 0 ? estimateBlockTimeSec(block, m.lastFundingBlock, now, blockMs) : 0);

  // main series by price source; without the indexer: this session's chain reads (trades, mark, index)
  const q = view.source === "last" ? candles : view.source === "mark" ? marks : view.source === "reference" ? reference : view.source === "perpl" ? perpl : index;
  let bars: Bar[] = [];
  let source: PriceSource = view.source;
  let fellBack = false;
  if (view.source === "reference") {
    bars = reference.data ?? []; // its own series only: never merged with our trades, mark or index
  } else if (view.source === "perpl") {
    bars = perpl.data ?? []; // another venue's trades: its own series only, never merged with ours
  } else if (sessionMode) {
    const samples = sessionSamples(market);
    if (source === "last") {
      const pts = (trades ?? []).map((t) => ({ time: timeOf(t.block, t.timestamp), price: t.priceWad })).filter((p) => p.time > 0);
      bars = pointsToBars(pts, sec, offset);
      if (bars.length === 0) {
        source = "mark"; // no trades in this session: show the mark rather than an empty chart, and say so
        fellBack = true;
      }
    }
    if (source !== "last") bars = pointsToBars(samples.map((x) => ({ time: x.time, price: source === "mark" ? x.mark : x.index })).filter((p) => p.price > 0n), sec, offset);
  } else if (view.source === "last" && candles.data) {
    bars = aggregate(candles.data.map(toBar), sec, true, offset);
    // live: overlay recent trade prices on the newest bars (price only: volume stays the indexer's, no double count)
    const lastT = bars[bars.length - 1]?.time;
    if (lastT !== undefined && trades)
      for (const t of [...trades].reverse()) {
        const ts = timeOf(t.block, t.timestamp);
        if (ts >= lastT) bars = applyTrade(bars, sec, ts, t.priceWad, 0n, 0n, false);
      }
  } else if (view.source === "mark" && marks.data) bars = pointsToBars(marks.data, sec, offset);
  else if (view.source === "index" && index.data) bars = pointsToBars(index.data, sec, offset);
  const firstReal = bars.find((b) => !b.gapFill);
  const ind = buildIndicators(bars, view.indicators);

  const lines: PriceLineSpec[] = [
    ...(view.markLine && m ? [{ id: "mark", priceWad: m.lastMarkPrice, tone: "brand" as const, title: "Mark", dashed: true }] : []),
    ...(view.indexLine && m ? [{ id: "index", priceWad: m.lastIndexPrice, tone: "muted" as const, title: "Index", dashed: true }] : []),
    ...priceLines,
  ];
  // oracle band: the realized 1h / 8h / 24h APR from the funding-rate oracle, drawn as guides on the funding pane
  const band = [m?.realizedApr1hWad, m?.realizedApr8hWad, m?.realizedApr24hWad].filter((x): x is bigint => x !== undefined).map((x) => wadToNum(x * 100n));
  const fundingPanes: PaneSpec[] =
    view.fundingPane && ticks && ticks.length > 0
      ? [
          {
            id: "funding",
            title: "Funding APR % (per block)",
            guides: [0, ...band],
            series: [{ id: "apr", kind: "line", tone: "warn", points: bySecond(ticks.map((t) => ({ time: timeOf(t.block, t.timestamp), value: wadToNum(t.rateAprWad * 100n) })).filter((p) => p.time > 0)) }],
          },
          {
            id: "premium",
            title: "Premium: (mark − index) / index, %",
            guides: [0],
            series: [
              {
                id: "prem",
                kind: "histogram",
                tone: "muted",
                signedColors: true,
                points: bySecond(ticks.filter((t) => t.index > 0n).map((t) => ({ time: timeOf(t.block, t.timestamp), value: wadToNum(((t.mark - t.index) * 100n * 10n ** 18n) / t.index) })).filter((p) => p.time > 0)),
              },
            ],
          },
        ]
      : [];

  // OHLC legend: the hovered bar, else the newest one
  const lastBar = bars[bars.length - 1];
  const legend = hover ?? (lastBar ? { time: lastBar.time, open: wadToNum(lastBar.open), high: wadToNum(lastBar.high), low: wadToNum(lastBar.low), close: wadToNum(lastBar.close) } : null);
  const f6 = (n: number) => n.toFixed(pm.priceDp);
  const chg = legend && legend.open ? ((legend.close - legend.open) / legend.open) * 100 : 0;
  const volBar = legend ? bars.find((b) => b.time === legend.time) : undefined;
  const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(0));
  const legendVol = volBar ? compact(wadToNum(volBar.volumeBaseWad)) : undefined;

  // range bar: after the timeframe switch lands and the engine has made its own fit, frame the chosen window
  useEffect(() => {
    const r = pendingRange.current;
    if (!r || !coords || bars.length === 0) return;
    pendingRange.current = null;
    const id = setTimeout(() => (r.from !== undefined && r.to !== undefined ? coords.setVisibleSeconds(r.from, r.to) : setResetKey((k) => k + 1)), 60);
    return () => clearTimeout(id);
  }, [coords, bars.length, tf]);
  const pickRange = (id: RangeId) => {
    const w = rangeWindow(id, Math.floor(now / 1_000)); // now = the wall clock ticking for the UTC label
    setRange(id);
    pendingRange.current = { from: w.from, to: w.to };
    setView(market, { timeframe: w.timeframe });
    setResetKey((k) => k + 1);
  };
  const saveImage = () => {
    if (!coords) return;
    try {
      const url = coords.screenshot().toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `meridian-${(m?.symbol ?? pm.symbol).toLowerCase()}-${tf}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
      a.click();
    } catch {
      /* canvas export blocked: nothing to save */
    }
  };

  const notice = (() => {
    if (bars.length > 0) return undefined;
    if (view.source === "reference") {
      if (reference.isError) return { title: "Reference unavailable", body: `${reference.error.message}. Our mark and index lines still show.` };
      return reference.isPending ? { title: "Loading", body: "" } : { title: "No reference data", body: "GeckoTerminal returned no MON/USDC candles for this pool." };
    }
    if (view.source === "perpl") {
      if (perpl.isError) return { title: "Perpl unavailable", body: `${perpl.error.message}. Our mark and index lines still show.` };
      return perpl.isPending ? { title: "Loading", body: "" } : { title: "No Perpl data", body: "Perpl returned no MON candles for this window." };
    }
    if (sessionMode) return { title: "Recording", body: "Prices read from the chain every block are drawn from the moment this page opened." };
    if (view.source === "index" && oracle === undefined) return { title: "Oracle address unknown", body: "The index series is keyed by the market's oracle, which this data source doesn't report." };
    if (q.isError) return { title: "Indexer unavailable", body: "Retrying. Nothing is drawn rather than a made-up history." };
    if (q.isPending) return { title: "Loading", body: "" };
    return { title: view.source === "last" ? "No trades yet" : "No history yet", body: view.source === "last" ? "Candles appear with the first trade." : "Points appear as the indexer records them." };
  })();

  return (
    <section
      ref={shell}
      aria-label="Price chart"
      className={`flex h-full min-h-[360px] flex-col overflow-hidden rounded-card border border-border bg-card card-elev ${fs ? "fixed inset-2 z-40 !h-auto" : ""}`}
    >
      <ChartToolbar
        view={view}
        fullscreen={fs}
        onChange={(patch) => {
          setView(market, patch);
          if (patch.timeframe) setRange(null);
          if (patch.timeframe || patch.source) setResetKey((k) => k + 1);
        }}
        onFullscreen={() => void toggleFullscreen()}
        onScreenshot={saveImage}
        undo={{ can: draw.canUndo, run: draw.undo }}
        redo={{ can: draw.canRedo, run: draw.redo }}
        referenceEnabled={refOk}
      />
      <div className="flex min-h-0 flex-1">
        <ToolRail api={draw} onZoomIn={() => coords?.zoom(0.6)} />
        <div className="relative min-h-0 min-w-0 flex-1">
          <LightweightEngine
            bars={bars}
            chartType={view.chartType}
            showVolume={view.volume && source === "last"}
            priceLines={lines}
            overlays={[...ind.overlays, ...overlays]}
            panes={[...fundingPanes, ...ind.panes, ...panes]}
            resetKey={resetKey}
            pricePrecision={pm.priceDp}
            onPriceClick={draw.tool || draw.erase ? undefined : onPriceClick}
            onCoords={setCoords}
            onCrosshair={setHover}
          />
          <DrawingLayer coords={coords} bars={bars} api={draw} />
          <SeriesNotes source={source} fellBack={fellBack} />
          {/* legend: logo · name · timeframe · venue, OHLC and change; Vol below; collapsible */}
          {legend && (
            <div className="pointer-events-none absolute left-2 top-1.5 z-10 space-y-0.5 text-[12.5px]" data-testid="ohlc-legend">
              <div className="flex flex-wrap items-center gap-x-1.5">
                <Image src="/meridian-logo.png" alt="" width={16} height={16} className="rounded-full bg-brand p-[2px]" />
                <span className="text-text">{m?.symbol ?? pm.symbol}</span>
                <span className="text-muted">·</span>
                <span className="num text-text">{tf}</span>
                <span className="text-muted">·</span>
                <span className="text-text">{VENUE[source]}</span>
                <span className="rounded-[4px] bg-brand-tint px-1 text-[10px] font-semibold text-brand-soft">
                  {SOURCE_NAME[source]}
                  {sessionMode && !isOutside(source) ? " · session" : ""}
                </span>
                {legendOpen && (
                  <span className="num flex flex-wrap items-center gap-x-1">
                    <span className="text-muted">O</span>
                    <span className={chg >= 0 ? "text-long" : "text-short"}>{f6(legend.open)}</span>
                    <span className="text-muted">H</span>
                    <span className={chg >= 0 ? "text-long" : "text-short"}>{f6(legend.high)}</span>
                    <span className="text-muted">L</span>
                    <span className={chg >= 0 ? "text-long" : "text-short"}>{f6(legend.low)}</span>
                    <span className="text-muted">C</span>
                    <span className={chg >= 0 ? "text-long" : "text-short"}>{f6(legend.close)}</span>
                    <span className={chg >= 0 ? "text-long" : "text-short"}>
                      {legend.close - legend.open >= 0 ? "+" : "−"}
                      {f6(Math.abs(legend.close - legend.open))} ({chg >= 0 ? "+" : "−"}
                      {Math.abs(chg).toFixed(2)}%)
                    </span>
                  </span>
                )}
              </div>
              {legendOpen && view.volume && source === "last" && legendVol !== undefined && (
                <div className="num flex items-center gap-1.5">
                  <span className="text-text">Vol</span>
                  <span className={chg >= 0 ? "text-long" : "text-short"}>{legendVol}</span>
                </div>
              )}
              <button type="button" aria-label={legendOpen ? "Collapse legend" : "Expand legend"} aria-expanded={legendOpen} onClick={() => setLegendOpen((o) => !o)} className="pointer-events-auto grid h-6 w-7 place-items-center rounded-[6px] border border-border bg-card/80 text-muted hover:text-text pointer-coarse:h-11 pointer-coarse:w-11">
                <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path d={legendOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
                </svg>
              </button>
            </div>
          )}
          {notice && (
            <div className="pointer-events-none absolute inset-x-4 top-16 z-10">
              <Notice tone="info" title={notice.title}>
                {notice.body}
              </Notice>
            </div>
          )}
        </div>
      </div>
      <ChartFooter
        range={range}
        onRange={pickRange}
        note={historyNote({ source: view.source, session: sessionMode, firstSec: firstReal?.time, markRows: view.source === "mark" ? marks.data?.length : undefined })}
        chips={
          <>
            {view.fundingPane && ticks && ticks.length === 0 && <Chip>funding: no update in the log window</Chip>}
            {ticks && ticks.some((t) => t.timestamp === 0n) && <Chip>times ≈ from block height</Chip>}
          </>
        }
        nowMs={now}
        view={view}
        onToggle={(k) => setView(market, { [k]: !view[k] })}
        onReset={() => {
          setView(market, { ...DEFAULT_VIEW, indicators: view.indicators });
          setRange(null);
          setResetKey((k) => k + 1);
        }}
      />
    </section>
  );
}
