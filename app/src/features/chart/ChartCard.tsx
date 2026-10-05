"use client";
import { useState, type ReactNode } from "react";
import { useFundingTicks, useIndexerCandles, useMarket, useTrades, INDEXER_URL } from "@/data/hooks";
import { Card, Chip, Notice, PillTabs, Popover } from "@/components/ds";
import { useNow } from "@/lib/useNow";
import { BLOCK_TIME_MS } from "@/lib/units";
import { aggregate, applyTrade, toBar } from "./datafeed/candles";
import { SOURCE_OF, TIMEFRAME_SEC, type Bar, type Timeframe } from "./datafeed/types";
import { LightweightEngine } from "./engine/LightweightEngine";
import type { ChartType, LineOverlay, PaneSpec, PriceLineSpec } from "./engine/types";
import { estimateBlockTimeSec, wadToNum } from "./series";
import { setView, useChartView, type IndicatorId } from "./store";
import { DrawingLayer } from "./drawings/DrawingLayer";
import { DrawingToolbar } from "./drawings/DrawingToolbar";
import { useDrawings } from "./drawings/useDrawings";
import type { ChartCoords } from "./engine/types";
import { CORE_INDICATORS, INDICATOR_LABEL, PRO_INDICATORS, buildIndicators } from "./indicators/build";

// Indexer rows fetched per timeframe (coarse frames aggregate many source candles; Hasura limit stays modest)
const LIMIT: Record<Timeframe, number> = { "1m": 500, "5m": 1_500, "15m": 2_000, "1h": 500, "4h": 1_500, "1D": 2_000 };
const TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "hollow", label: "Hollow" },
  { id: "bars", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "heikin", label: "Heikin-Ashi" },
];

function ToggleChip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label: string }) {
  return (
    <button type="button" aria-pressed={on} aria-label={label} onClick={onClick} className={`h-7 rounded-full px-2.5 text-[11px] pointer-coarse:h-11 ${on ? "bg-brand-tint text-brand-soft" : "bg-card-2 text-muted hover:text-text"}`}>
      {children}
    </button>
  );
}

/** Dedupes by second (several 300 ms blocks share a second; the chart needs strictly increasing times): keeps the last. */
function bySecond(points: { time: number; value: number }[]) {
  const m = new Map<number, number>();
  for (const p of points) m.set(p.time, p.value);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

export type ChartCardProps = {
  /** extra price lines (position entry / liquidation, resting orders) */
  priceLines?: PriceLineSpec[];
  /** indicator overlays and panes, computed by the caller from the bars passed to `onBars` */
  overlays?: LineOverlay[];
  panes?: PaneSpec[];
  onPriceClick?: (priceWad: bigint) => void;
  toolbarExtra?: ReactNode;
};

/**
 * Price chart (FRONTEND_TRADE_PLAN §4): indexer candles (1m / 1h, coarser frames aggregated), live last-trade overlay
 * per block, volume, mark / index lines, per-block funding-rate pane. Never backfilled: "history starts at …".
 */
export function ChartCard({ priceLines = [], overlays = [], panes = [], onPriceClick, toolbarExtra }: ChartCardProps) {
  const { data: m } = useMarket();
  const market = m?.clearingHouse ?? "MON-PERP";
  const view = useChartView(market);
  const tf = view.timeframe;
  const sec = TIMEFRAME_SEC[tf];
  const candles = useIndexerCandles(SOURCE_OF[tf], LIMIT[tf]);
  const { data: trades } = useTrades(40);
  const { data: ticks } = useFundingTicks(200); // same query as the funding ticker (one RPC scan, shared cache)
  const now = useNow(1_000);
  const [resetKey, setResetKey] = useState(0);
  const [fs, setFs] = useState(false);
  const [coords, setCoords] = useState<ChartCoords | null>(null);
  const draw = useDrawings(market);

  const blockMs = m && m.blockTimeMs > 0n ? Number(m.blockTimeMs) : BLOCK_TIME_MS;
  const timeOf = (block: bigint, timestamp: bigint) => (timestamp > 0n ? Number(timestamp) : m && now > 0 ? estimateBlockTimeSec(block, m.lastFundingBlock, now, blockMs) : 0);

  let bars: Bar[] = candles.data ? aggregate(candles.data.map(toBar), sec, true) : [];
  // live: overlay recent trade prices on the newest bars (price only: volume stays the indexer's, no double count)
  const lastT = bars[bars.length - 1]?.time;
  if (lastT !== undefined && trades) {
    for (const t of [...trades].reverse()) {
      const ts = timeOf(t.block, t.timestamp);
      if (ts >= lastT) bars = applyTrade(bars, sec, ts, t.priceWad, 0n, 0n, false);
    }
  }
  const firstReal = bars.find((b) => !b.gapFill);
  const ind = buildIndicators(bars, view.indicators);
  const toggleIndicator = (id: IndicatorId) =>
    setView(market, { indicators: view.indicators.includes(id) ? view.indicators.filter((x) => x !== id) : [...view.indicators, id] });

  const lines: PriceLineSpec[] = [
    ...(view.markLine && m ? [{ id: "mark", priceWad: m.lastMarkPrice, tone: "brand" as const, title: "Mark", dashed: true }] : []),
    ...(view.indexLine && m ? [{ id: "index", priceWad: m.lastIndexPrice, tone: "muted" as const, title: "Index", dashed: true }] : []),
    ...priceLines,
  ];
  // oracle band: the realized 1h / 8h / 24h APR from the funding-rate oracle, drawn as guides on the funding pane
  const band = [m?.realizedApr1hWad, m?.realizedApr8hWad, m?.realizedApr24hWad].filter((x): x is bigint => x !== undefined).map((x) => wadToNum(x * 100n));
  const fundingPane: PaneSpec[] =
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

  return (
    <Card
      className={`flex h-full min-h-[360px] flex-col ${fs ? "fixed inset-2 z-40 !h-auto" : ""}`}
      bodyClassName="flex min-h-0 flex-1 flex-col"
      aria-label="Price chart"
      header={
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <PillTabs size="sm" ariaLabel="Timeframe" value={tf} onChange={(v) => (setView(market, { timeframe: v }), setResetKey((k) => k + 1))} tabs={(["1m", "5m", "15m", "1h", "4h", "1D"] as const).map((id) => ({ id, label: id }))} />
          <select aria-label="Chart type" value={view.chartType} onChange={(e) => setView(market, { chartType: e.target.value as ChartType })} className="h-7 rounded-full bg-card-2 px-2 text-[11px] text-muted pointer-coarse:h-11">
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <ToggleChip label="Volume" on={view.volume} onClick={() => setView(market, { volume: !view.volume })}>
            Vol
          </ToggleChip>
          <ToggleChip label="Mark price line" on={view.markLine} onClick={() => setView(market, { markLine: !view.markLine })}>
            Mark
          </ToggleChip>
          <ToggleChip label="Index price line" on={view.indexLine} onClick={() => setView(market, { indexLine: !view.indexLine })}>
            Index
          </ToggleChip>
          <ToggleChip label="Funding rate pane" on={view.fundingPane} onClick={() => setView(market, { fundingPane: !view.fundingPane })}>
            Funding
          </ToggleChip>
          <Popover
            label="Indicators"
            align="start"
            triggerClassName={`h-7 rounded-full px-2.5 text-[11px] pointer-coarse:h-11 ${view.indicators.length ? "bg-brand-tint text-brand-soft" : "bg-card-2 text-muted hover:text-text"}`}
            trigger={`Indicators${view.indicators.length ? ` · ${view.indicators.length}` : ""}`}
          >
            {(
              [
                ["Core", CORE_INDICATORS],
                ["Pro", PRO_INDICATORS],
              ] as const
            ).map(([title, ids]) => (
              <fieldset key={title} className="space-y-0.5 p-1">
                <legend className="mb-1 text-[11px] text-muted">{title}</legend>
                {ids.map((id) => (
                  <label key={id} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-xs hover:bg-card-2 pointer-coarse:min-h-11">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={view.indicators.includes(id)} onChange={() => toggleIndicator(id)} />
                    {INDICATOR_LABEL[id]}
                  </label>
                ))}
              </fieldset>
            ))}
          </Popover>
          <DrawingToolbar api={draw} />
          {toolbarExtra}
          <span className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => setResetKey((k) => k + 1)} className="h-7 rounded-full bg-card-2 px-2.5 text-[11px] text-muted hover:text-text pointer-coarse:h-11">
              Reset
            </button>
            <button type="button" aria-pressed={fs} onClick={() => setFs((f) => !f)} className="h-7 rounded-full bg-card-2 px-2.5 text-[11px] text-muted hover:text-text pointer-coarse:h-11">
              {fs ? "Exit full" : "Full"}
            </button>
            <span className="num text-[11px] text-muted" aria-label="UTC time">
              {now > 0 ? `${new Date(now).toISOString().slice(11, 19)} UTC` : ""}
            </span>
          </span>
        </div>
      }
    >
      <div className="relative min-h-0 flex-1">
        <LightweightEngine bars={bars} chartType={view.chartType} showVolume={view.volume} priceLines={lines} overlays={[...ind.overlays, ...overlays]} panes={[...fundingPane, ...ind.panes, ...panes]} resetKey={resetKey} onPriceClick={draw.tool || draw.erase ? undefined : onPriceClick} onCoords={setCoords} />
        <DrawingLayer coords={coords} bars={bars} api={draw} />
        {bars.length === 0 && (
          <div className="pointer-events-none absolute inset-x-4 top-4 z-10">
            <Notice tone="info" title={INDEXER_URL === undefined ? "Price history needs the indexer" : candles.isError ? "Indexer unavailable" : candles.isPending ? "Loading candles" : "No trades yet"}>
              {INDEXER_URL === undefined
                ? "Candles come from the Meridian indexer (Candle1m / Candle1h), which isn't connected here. The funding pane below is read from the chain."
                : candles.isError
                  ? "Retrying. Nothing is drawn rather than a made-up history."
                  : "Candles appear with the first trade."}
            </Notice>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 pt-2 text-[10px] text-muted">
        <span data-testid="history-start">{firstReal ? `History starts at ${new Date(firstReal.time * 1_000).toISOString().slice(0, 16).replace("T", " ")} UTC` : "No candle history"}</span>
        <span className="flex items-center gap-1.5">
          {view.fundingPane && ticks && ticks.length === 0 && <Chip>funding: no update in the log window</Chip>}
          {ticks && ticks.some((t) => t.timestamp === 0n) && <Chip>times ≈ from block height</Chip>}
          <span>Lightweight Charts by TradingView</span>
        </span>
      </div>
    </Card>
  );
}
