"use client";
// Top bar of Meridian's chart, written from docs/outputs/CHART_TOPBAR_SPEC.md §2: view pickers on the left
// (timeframe, type, price source, indicators), drawing history and output actions on the right.
import type { ReactNode } from "react";
import { Popover } from "@/components/ds";
import type { PriceSource, Timeframe } from "../datafeed/types";
import type { ChartType } from "../engine/types";
import { CORE_INDICATORS, INDICATOR_LABEL, PRO_INDICATORS } from "../indicators/build";
import type { ChartView, IndicatorId } from "../store";
import { I, Icon } from "./icons";
import { SOURCE_LABEL, sourceOptions } from "./sources";

const TF_SECTIONS: { caption: string; items: Timeframe[] }[] = [
  { caption: "Minutes", items: ["1m", "3m", "5m", "15m", "30m"] },
  { caption: "Hours", items: ["1h", "2h", "4h", "6h", "12h"] },
  { caption: "Days", items: ["1D", "1W"] },
];

// glyphs for each chart type (24-unit grid, drawn for this bar)
const TYPE_META: { id: ChartType; name: string; glyph: ReactNode }[] = [
  { id: "candles", name: "Candles", glyph: <Icon d="M8 4v16M16 4v16M5.5 8h5v7h-5zM13.5 6h5v9h-5z" /> },
  { id: "hollow", name: "Hollow candles", glyph: <Icon d="M8 4v4M8 15v5M16 4v2M16 15v5M5.5 8h5v7h-5zM13.5 6h5v9h-5z" /> },
  { id: "bars", name: "Bars", glyph: <Icon d="M8 4v16M5 8h3M8 16h3M16 6v14M13 9h3M16 17h3" /> },
  { id: "line", name: "Line", glyph: <Icon d="M3 17l5-6 4 3 4-7 5 5" /> },
  { id: "area", name: "Area", glyph: <Icon d="M3 17l5-6 4 3 4-7 5 5v8H3z" /> },
  { id: "heikin", name: "Heikin-Ashi", glyph: <Icon d="M8 5v14M16 5v14M5.5 9h5v6h-5zM13.5 8h5v6h-5zM3 21h18" /> },
];

const btn = "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-control px-1.5 text-[13px] text-muted hover:bg-card-2 hover:text-text disabled:pointer-events-none disabled:opacity-35 pointer-coarse:h-11 pointer-coarse:min-w-11";
const option = (on: boolean) =>
  `flex w-full items-center rounded-control px-2 text-left text-[13px] min-h-8 pointer-coarse:min-h-11 ${on ? "bg-brand-tint text-brand-soft" : "text-text hover:bg-card-2"}`;

const Divider = () => <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />;

/** A trigger button and a panel of mutually exclusive options; choosing one closes the panel. */
function RadioMenu<T extends string>({
  label,
  face,
  value,
  options,
  render,
  onPick,
}: {
  label: string;
  face: ReactNode;
  value: T;
  options: readonly T[];
  render: (o: T) => ReactNode;
  onPick: (o: T) => void;
}) {
  return (
    <Popover label={label} trigger={face} align="start" triggerClassName={btn} panelClassName="!w-72">
      {(close) => (
        <div className="space-y-0.5">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="menuitemradio"
              aria-checked={o === value}
              className={option(o === value)}
              onClick={() => {
                onPick(o);
                close();
              }}
            >
              {render(o)}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

export type ChartToolbarProps = {
  view: ChartView;
  onChange: (patch: Partial<ChartView>) => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  onScreenshot: () => void;
  undo: { can: boolean; run: () => void };
  redo: { can: boolean; run: () => void };
};

export function ChartToolbar({ view, onChange, fullscreen, onFullscreen, onScreenshot, undo, redo }: ChartToolbarProps) {
  const type = TYPE_META.find((t) => t.id === view.chartType) ?? TYPE_META[0]!;
  const toggleIndicator = (id: IndicatorId) => onChange({ indicators: view.indicators.includes(id) ? view.indicators.filter((x) => x !== id) : [...view.indicators, id] });
  const count = view.indicators.length;

  return (
    <div role="toolbar" aria-label="Chart controls" className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-1 border-b border-border px-1.5 py-1.5">
      <div className="flex items-center gap-0.5">
        {/* timeframe: one panel, three captioned grids */}
        <Popover label="Timeframe" trigger={<span className="num font-medium text-text">{view.timeframe}</span>} align="start" triggerClassName={btn} panelClassName="!w-64">
          {(close) => (
            <div className="space-y-2 p-1">
              {TF_SECTIONS.map((s) => (
                <div key={s.caption}>
                  <p className="mb-1 px-1 text-[10.5px] font-medium uppercase tracking-wide text-muted">{s.caption}</p>
                  <div className="grid grid-cols-3 gap-1">
                    {s.items.map((tf) => (
                      <button
                        key={tf}
                        type="button"
                        role="menuitemradio"
                        aria-checked={tf === view.timeframe}
                        className={`${option(tf === view.timeframe)} num justify-center`}
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
        <RadioMenu<ChartType>
          label="Chart type"
          face={type.glyph}
          value={view.chartType}
          options={TYPE_META.map((t) => t.id)}
          render={(id) => {
            const t = TYPE_META.find((x) => x.id === id)!;
            return (
              <span className="flex items-center gap-2">
                <span className="text-muted">{t.glyph}</span>
                {t.name}
              </span>
            );
          }}
          onPick={(chartType) => onChange({ chartType })}
        />
        <Divider />
        <RadioMenu<PriceSource>
          label="Price source"
          face={<span className="max-w-[9rem] truncate font-medium text-text">{SOURCE_LABEL[view.source].label}</span>}
          value={view.source}
          options={sourceOptions()}
          render={(s) => (
            <span className="block py-1">
              <span className="block font-medium">{SOURCE_LABEL[s].label}</span>
              <span className="block text-[11.5px] text-muted"> {SOURCE_LABEL[s].hint}</span>
            </span>
          )}
          onPick={(source) => onChange({ source })}
        />
        <Divider />
        <Popover
          label="Indicators"
          align="start"
          triggerClassName={btn}
          panelClassName="!w-64"
          trigger={
            <>
              {I.indicators}
              <span className="max-sm:hidden">Indicators</span>
              {count > 0 && <span className="num rounded-full bg-brand-tint px-1.5 text-[10.5px] font-semibold text-brand-soft">{count}</span>}
            </>
          }
        >
          <div className="space-y-2 p-1">
            {(
              [
                ["Core", CORE_INDICATORS],
                ["Pro", PRO_INDICATORS],
              ] as const
            ).map(([name, ids]) => (
              <div key={name} role="group" aria-label={name}>
                <span className="mb-1 block px-1 text-[10.5px] font-medium uppercase tracking-wide text-muted">{name}</span>
                {ids.map((id) => (
                  <label key={id} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-[13px] hover:bg-card-2 pointer-coarse:min-h-11">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={view.indicators.includes(id)} onChange={() => toggleIndicator(id)} />
                    {INDICATOR_LABEL[id]}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </Popover>
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <button type="button" aria-label="Undo drawing" title="Undo" disabled={!undo.can} onClick={undo.run} className={btn}>
          {I.undo}
        </button>
        <button type="button" aria-label="Redo drawing" title="Redo" disabled={!redo.can} onClick={redo.run} className={btn}>
          {I.redo}
        </button>
        <Divider />
        <button type="button" aria-label="Full screen" title={fullscreen ? "Exit full screen" : "Full screen"} aria-pressed={fullscreen} onClick={onFullscreen} className={`${btn} ${fullscreen ? "text-brand-soft" : ""}`}>
          {I.fullscreen}
        </button>
        <button type="button" aria-label="Save chart image" title="Save chart image (PNG)" onClick={onScreenshot} className={btn}>
          {I.camera}
        </button>
      </div>
    </div>
  );
}
