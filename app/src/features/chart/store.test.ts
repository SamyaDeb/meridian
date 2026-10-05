import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW, parseView, setView } from "./store";

describe("chart view store", () => {
  it("parses valid state and drops unknown / malformed fields", () => {
    expect(parseView(JSON.stringify({ timeframe: "4h", chartType: "heikin", volume: false, indicators: ["rsi14", "rsi14", "bogus"] }))).toEqual({ ...DEFAULT_VIEW, timeframe: "4h", chartType: "heikin", volume: false, indicators: ["rsi14"] });
    expect(parseView(JSON.stringify({ timeframe: "7m", chartType: 7, markLine: "yes" }))).toEqual(DEFAULT_VIEW);
    expect(parseView("{not json")).toEqual(DEFAULT_VIEW);
    expect(parseView(null)).toEqual(DEFAULT_VIEW);
  });
  it("setView survives a throwing localStorage (private mode)", () => {
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => setView("0xabc", { timeframe: "1h" })).not.toThrow();
    g.localStorage = prev;
  });
});
