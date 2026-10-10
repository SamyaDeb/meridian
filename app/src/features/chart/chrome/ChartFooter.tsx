"use client";
// Bottom bar of Meridian's chart, written from docs/outputs/CHART_TOPBAR_SPEC.md §3: range shortcuts, where the
// drawn history comes from, status chips, the UTC clock and the chart settings.
import type { ReactNode } from "react";
import { Popover } from "@/components/ds";
import { formatFixed } from "@/lib/format";
import { PERPL_VENUE } from "../datafeed/perpl";
import type { PriceSource } from "../datafeed/types";
import type { ChartView } from "../store";
import { I } from "./icons";
import { RANGES, type RangeId } from "./ranges";

const iso = (sec: number) => new Date(sec * 1_000).toISOString();
const minute = (sec: number) => iso(sec).slice(0, 16).replace("T", " "); // YYYY-MM-DD HH:MM
const hhmm = (sec: number) => iso(sec).slice(11, 16);

/** Pure: the footer's note on what the drawn series is and how far back it goes (all times UTC). */
export function historyNote({ source, session, firstSec, markRows }: { source: PriceSource; session: boolean; firstSec?: number; markRows?: number }): string {
  let note: string;
  if (firstSec === undefined) note = "No candle history";
  else if (source === "reference") note = `MON/USDC on Uniswap v4 (Monad) from ${minute(firstSec)} UTC, via GeckoTerminal`;
  else if (source === "perpl") note = `${PERPL_VENUE} trades from ${minute(firstSec)} UTC, via Perpl's public API`;
  else if (session) note = `Session data since ${hhmm(firstSec)} UTC (indexer not connected: full history appears once it is)`;
  else note = `History starts at ${minute(firstSec)} UTC`;
  if (source === "mark" && markRows !== undefined) note += ` · mark: last ${formatFixed(BigInt(markRows), 0, 0)} funding blocks`;
  return note;
}

/** Pure: wall clock as HH:MM:SS UTC; empty before the first tick (server render). */
export const utcClock = (nowMs: number) => (nowMs > 0 ? `${new Date(nowMs).toISOString().slice(11, 19)} UTC` : "");

const SETTINGS: [keyof Pick<ChartView, "volume" | "markLine" | "indexLine" | "fundingPane">, string][] = [
  ["volume", "Volume"],
  ["markLine", "Mark price line"],
  ["indexLine", "Index price line"],
  ["fundingPane", "Funding rate pane"],
];

export function ChartFooter({
  range,
  onRange,
  note,
  chips,
  nowMs,
  view,
  onToggle,
  onReset,
}: {
  range: RangeId | null;
  onRange: (r: RangeId) => void;
  note: string;
  chips?: ReactNode;
  nowMs: number;
  view: ChartView;
  onToggle: (key: (typeof SETTINGS)[number][0]) => void;
  onReset: () => void;
}) {
  return (
    <footer className="flex min-h-10 shrink-0 items-center gap-2 border-t border-border px-1.5 text-[12.5px]">
      <div role="group" aria-label="Range" className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto">
        {RANGES.map((r) => {
          const on = r === range;
          return (
            <button
              key={r}
              type="button"
              aria-pressed={on}
              onClick={() => onRange(r)}
              className={`h-7 shrink-0 rounded-[6px] px-2 font-medium pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${on ? "bg-brand-tint text-brand-soft" : "text-muted hover:bg-card-2 hover:text-text"}`}
            >
              {r}
            </button>
          );
        })}
      </div>
      <span data-testid="history-start" className="min-w-0 flex-1 truncate text-[10.5px] text-muted max-sm:hidden" title={note}>
        {note}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {chips}
        <time aria-label="UTC time" className="num text-text max-sm:hidden">
          {utcClock(nowMs)}
        </time>
        <Popover label="Chart settings" trigger={I.gear} triggerClassName="grid h-8 w-8 place-items-center rounded-[6px] text-muted hover:bg-card-2 hover:text-text pointer-coarse:h-11 pointer-coarse:w-11" panelClassName="!w-56 !p-1">
          <div className="space-y-0.5">
            {SETTINGS.map(([k, label]) => (
              <label key={k} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-[13px] hover:bg-card-2 pointer-coarse:min-h-11">
                <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={view[k]} onChange={() => onToggle(k)} />
                {label}
              </label>
            ))}
            <button type="button" onClick={onReset} className="flex min-h-8 w-full items-center rounded-[6px] px-2 text-left text-[13px] hover:bg-card-2 pointer-coarse:min-h-11">
              Reset chart view
            </button>
            <p className="px-2 pt-1 text-[10px] text-muted">Lightweight Charts by TradingView</p>
          </div>
        </Popover>
      </div>
    </footer>
  );
}
