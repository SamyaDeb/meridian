import { describe, expect, it } from "vitest";
import type { Bar } from "../datafeed/types";
import { buildIndicators } from "./build";

const bars: Bar[] = Array.from({ length: 60 }, (_, i) => {
  const px = BigInt(27_000 + (i % 7) * 10) * 10n ** 12n;
  return { time: i * 60, open: px, high: px, low: px, close: px, volumeBaseWad: 1n, volumeQuoteWad: 1n, trades: 1, ...(i === 30 ? { gapFill: true as const } : {}) };
});

describe("buildIndicators", () => {
  it("maps ids to overlays / panes, skipping gap-fill bars", () => {
    const r = buildIndicators(bars, ["sma20", "bb20", "rsi14", "macd"]);
    expect(r.overlays.map((o) => o.id)).toEqual(["sma20", "bb20-mid", "bb20-up", "bb20-lo"]);
    expect(r.panes.map((p) => p.id)).toEqual(["rsi14", "macd"]);
    expect(r.overlays[0]!.points.some((p) => p.time === 30 * 60)).toBe(false);
    expect(r.overlays[0]!.points).toHaveLength(59 - 19);
  });
  it("nothing chosen ⇒ nothing drawn", () => {
    expect(buildIndicators(bars, [])).toEqual({ overlays: [], panes: [] });
  });
});

describe("pro indicators in build", () => {
  it("each pro id produces overlays or a pane; Ichimoku spans are shifted ahead", () => {
    const r = buildIndicators(bars, ["vwap", "supertrend", "ichimoku", "atr14", "stoch", "adx14", "obv"]);
    expect(r.overlays.map((o) => o.id)).toEqual(["vwap", "supertrend", "ichi-tenkan", "ichi-kijun", "ichi-a", "ichi-b"]);
    expect(r.panes.map((p) => p.id)).toEqual(["atr14", "stoch", "adx14", "obv"]);
    const lastBar = bars[bars.length - 1]!.time;
    expect(Math.max(...r.overlays.find((o) => o.id === "ichi-a")!.points.map((p) => p.time))).toBeGreaterThan(lastBar);
  });
});
