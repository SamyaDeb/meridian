"use client";
// Per-market chart view state (timeframe, type, toggles, indicators), persisted per viewer in localStorage.
// Every storage access is guarded (private mode / blocked storage ⇒ in-memory defaults, never a crash).
import { useSyncExternalStore } from "react";
import { TIMEFRAMES, type PriceSource, type Timeframe } from "./datafeed/types";
import { REFERENCE_ENABLED } from "./datafeed/reference";
import type { ChartType } from "./engine/types";

export type IndicatorId = "sma20" | "ema50" | "bb20" | "rsi14" | "macd" | "vwap" | "atr14" | "stoch" | "adx14" | "ichimoku" | "obv" | "supertrend";
export type ChartView = {
  timeframe: Timeframe;
  chartType: ChartType;
  volume: boolean;
  markLine: boolean;
  indexLine: boolean;
  fundingPane: boolean;
  indicators: IndicatorId[];
  /** main series: trades on the book (default), mark, the oracle index, or the labelled outside reference (flag) */
  source: PriceSource;
};
export const DEFAULT_VIEW: ChartView = { timeframe: "15m", chartType: "candles", volume: true, markLine: true, indexLine: true, fundingPane: false, indicators: [], source: "last" }; // single price pane by default; funding panes via the gear menu

const TYPES: readonly ChartType[] = ["candles", "hollow", "bars", "line", "area", "heikin"];
const INDICATORS: readonly IndicatorId[] = ["sma20", "ema50", "bb20", "rsi14", "macd", "vwap", "atr14", "stoch", "adx14", "ichimoku", "obv", "supertrend"];

/**
 * Pure: parse stored JSON into a valid view (unknown / malformed fields fall back to defaults). A saved view keeps its
 * own toggles: setView always stores every field, so the index line defaulting to on (6 Oct) reaches only viewers
 * without a saved view, and the key stays v2 (bumping it would silently reset everyone's saved views). A saved
 * `reference` source falls back to Last whenever the reference flag is off.
 */
export function parseView(raw: string | null, referenceEnabled = REFERENCE_ENABLED): ChartView {
  if (!raw) return DEFAULT_VIEW;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof ChartView, unknown>>;
    const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
    return {
      timeframe: TIMEFRAMES.includes(o.timeframe as Timeframe) ? (o.timeframe as Timeframe) : DEFAULT_VIEW.timeframe,
      chartType: TYPES.includes(o.chartType as ChartType) ? (o.chartType as ChartType) : DEFAULT_VIEW.chartType,
      volume: bool(o.volume, DEFAULT_VIEW.volume),
      markLine: bool(o.markLine, DEFAULT_VIEW.markLine),
      indexLine: bool(o.indexLine, DEFAULT_VIEW.indexLine),
      fundingPane: bool(o.fundingPane, DEFAULT_VIEW.fundingPane),
      source: o.source === "mark" || o.source === "index" || (o.source === "reference" && referenceEnabled) ? o.source : "last",
      indicators: Array.isArray(o.indicators) ? [...new Set(o.indicators.filter((x): x is IndicatorId => INDICATORS.includes(x as IndicatorId)))] : [],
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

const key = (market: string) => `meridian.chart.v2.${market.toLowerCase()}`; // v2: funding panes default off
const memory = new Map<string, ChartView>();
const listeners = new Set<() => void>();

function read(market: string): ChartView {
  const cached = memory.get(market);
  if (cached) return cached;
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(key(market)) ?? null;
  } catch {
    raw = null;
  }
  const v = parseView(raw);
  memory.set(market, v);
  return v;
}

export function setView(market: string, patch: Partial<ChartView>): void {
  const v = { ...read(market), ...patch };
  memory.set(market, v);
  try {
    globalThis.localStorage?.setItem(key(market), JSON.stringify(v));
  } catch {
    /* storage unavailable: the view lasts for this page session */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useChartView(market: string): ChartView {
  return useSyncExternalStore(subscribe, () => read(market), () => DEFAULT_VIEW);
}
