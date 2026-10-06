"use client";
// Meridian chart top bar (timeframe ▾ · chart type ▾ · price source ▾ · Indicators · undo / redo … full screen ·
// screenshot). Original Meridian code in the Monad theme (brand violet for active state); the control order follows the
// conventions traders know from charting terminals.
import type { ReactNode } from "react";
import { Popover } from "@/components/ds";
import { TIMEFRAMES, type PriceSource, type Timeframe } from "../datafeed/types";
import { REFERENCE_ENABLED } from "../datafeed/reference";
import type { ChartType } from "../engine/types";
import { CORE_INDICATORS, INDICATOR_LABEL, PRO_INDICATORS } from "../indicators/build";
import type { ChartView, IndicatorId } from "../store";
import { I } from "./icons";

const TYPE_LABEL: Record<ChartType, string> = { candles: "Candles", hollow: "Hollow candles", bars: "Bars", line: "Line", area: "Area", heikin: "Heikin-Ashi" };
export const SOURCE_LABEL: Record<PriceSource, { label: string; hint: string }> = {
  last: { label: "Last", hint: "Trades on Meridian's MON-PERP book" },
  mark: { label: "Mark", hint: "Mark price (drives PnL, liquidation and funding)" },
  index: { label: "Index", hint: "Oracle MON/USD index (spot reference; nobody trades at it here)" },
  reference: { label: "MON/USD ref (Monad DEX)", hint: "MON/USDC on Uniswap v4 (Monad mainnet) via GeckoTerminal. Not Meridian trades." },
};
/** Sources the toolbar offers: the outside reference only with NEXT_PUBLIC_REFERENCE_CHART=1, and always last. */
export const sourceOptions = (referenceEnabled = REFERENCE_ENABLED): PriceSource[] => (referenceEnabled ? ["last", "mark", "index", "reference"] : ["last", "mark", "index"]);
const GROUPS: [string, Timeframe[]][] = [
  ["Minutes", TIMEFRAMES.filter((t) => t.endsWith("m"))],
  ["Hours", TIMEFRAMES.filter((t) => t.endsWith("h"))],
  ["Days", TIMEFRAMES.filter((t) => t.endsWith("D") || t.endsWith("W"))],
];

const btn = "inline-flex h-8 items-center gap-1 rounded-[6px] px-2 text-[13.5px] text-text hover:bg-card-2 disabled:opacity-35 pointer-coarse:min-h-11";
const item = (on: boolean) => `flex min-h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] pointer-coarse:min-h-11 ${on ? "bg-brand-tint text-brand-soft" : "hover:bg-card-2"}`;
const Divider = () => <span className="mx-1 h-6 w-px bg-border" aria-hidden />;

export function TopBar({
  view,
  onChange,
  onFullscreen,
  fullscreen,
  onScreenshot,
  undo,
  redo,
  typeIcon,
}: {
  view: ChartView;
  onChange: (patch: Partial<ChartView>) => void;
  onFullscreen: () => void;
  fullscreen: boolean;
  onScreenshot: () => void;
  undo: { can: boolean; run: () => void };
  redo: { can: boolean; run: () => void };
  typeIcon: Record<ChartType, ReactNode>;
}) {
  const toggleIndicator = (id: IndicatorId) => onChange({ indicators: view.indicators.includes(id) ? view.indicators.filter((x) => x !== id) : [...view.indicators, id] });
  return (
    <div role="toolbar" aria-label="Chart controls" className="flex min-h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
      <Popover label="Timeframe" align="start" triggerClassName={btn} trigger={<span className="num font-medium">{view.timeframe}</span>}>
        {(close) => (
          <div className="w-52 space-y-1 p-1">
            {GROUPS.map(([title, tfs]) => (
              <div key={title}>
                <p className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-muted">{title}</p>
                <div className="grid grid-cols-3 gap-0.5">
                  {tfs.map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      role="menuitemradio"
                      aria-checked={tf === view.timeframe}
                      className={`num ${item(tf === view.timeframe)} justify-center`}
                      onClick={() => {
                        onChange({ timeframe: tf });
                        close();
                      }}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Popover>
      <Divider />
      <Popover label="Chart type" align="start" triggerClassName={btn} trigger={typeIcon[view.chartType]}>
        {(close) => (
          <div className="w-48 p-1">
            {(Object.keys(TYPE_LABEL) as ChartType[]).map((t) => (
              <button
                key={t}
                type="button"
                role="menuitemradio"
                aria-checked={view.chartType === t}
                className={item(view.chartType === t)}
                onClick={() => {
                  onChange({ chartType: t });
                  close();
                }}
              >
                {typeIcon[t]}
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        )}
      </Popover>
      <Divider />
      <Popover label="Price source" align="start" triggerClassName={btn} trigger={<span>{SOURCE_LABEL[view.source].label}</span>}>
        {(close) => (
          <div className="w-64 p-1">
            {sourceOptions().map((s) => (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={view.source === s}
                className={`${item(view.source === s)} flex-col items-start py-1.5`}
                onClick={() => {
                  onChange({ source: s });
                  close();
                }}
              >
                <span>{SOURCE_LABEL[s].label}</span>
                <span className="text-[10.5px] text-muted">{SOURCE_LABEL[s].hint}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>
      <Divider />
      <Popover label="Indicators" align="start" triggerClassName={`${btn} ${view.indicators.length ? "text-brand-soft" : ""}`} trigger={<>{I.indicators}<span className="max-sm:sr-only">Indicators{view.indicators.length ? ` · ${view.indicators.length}` : ""}</span></>}>
        {(
          [
            ["Core", CORE_INDICATORS],
            ["Pro", PRO_INDICATORS],
          ] as const
        ).map(([title, ids]) => (
          <fieldset key={title} className="space-y-0.5 p-1">
            <legend className="mb-1 text-[11px] text-muted">{title}</legend>
            {ids.map((id) => (
              <label key={id} className={`${item(false)} cursor-pointer`}>
                <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={view.indicators.includes(id)} onChange={() => toggleIndicator(id)} />
                {INDICATOR_LABEL[id]}
              </label>
            ))}
          </fieldset>
        ))}
      </Popover>
      <Divider />
      <button type="button" aria-label="Undo drawing" title="Undo" disabled={!undo.can} onClick={undo.run} className={btn}>
        {I.undo}
      </button>
      <button type="button" aria-label="Redo drawing" title="Redo" disabled={!redo.can} onClick={redo.run} className={btn}>
        {I.redo}
      </button>
      <span className="flex-1" />
      <button type="button" aria-label={fullscreen ? "Exit full screen" : "Full screen"} aria-pressed={fullscreen} title="Full screen" onClick={onFullscreen} className={btn}>
        {I.fullscreen}
      </button>
      <button type="button" aria-label="Save chart image" title="Save chart image (PNG)" onClick={onScreenshot} className={btn}>
        {I.camera}
      </button>
    </div>
  );
}
