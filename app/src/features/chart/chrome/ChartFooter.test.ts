import { describe, expect, it } from "vitest";
import { historyNote, utcClock } from "./ChartFooter";

const T = Date.UTC(2026, 9, 5, 22, 30) / 1_000; // 2026-10-05 22:30 UTC

describe("historyNote", () => {
  it("no real bars: says so", () => {
    expect(historyNote({ source: "last", session: false })).toBe("No candle history");
  });
  it("indexer history starts at the first real bar", () => {
    expect(historyNote({ source: "last", session: false, firstSec: T })).toBe("History starts at 2026-10-05 22:30 UTC");
  });
  it("session mode names the start time and why there is no more", () => {
    expect(historyNote({ source: "index", session: true, firstSec: T })).toBe("Session data since 22:30 UTC (indexer not connected: full history appears once it is)");
  });
  it("the reference is labelled as an outside series, even in session mode", () => {
    expect(historyNote({ source: "reference", session: true, firstSec: T })).toBe("MON/USDC on Uniswap v4 (Monad) from 2026-10-05 22:30 UTC, via GeckoTerminal");
  });
  it("mark appends how many funding blocks it covers, grouped", () => {
    expect(historyNote({ source: "mark", session: false, firstSec: T, markRows: 2_000 })).toBe("History starts at 2026-10-05 22:30 UTC · mark: last 2,000 funding blocks");
    expect(historyNote({ source: "last", session: false, firstSec: T, markRows: 2_000 })).not.toContain("funding blocks");
  });
});

describe("utcClock", () => {
  it("formats HH:MM:SS UTC, empty before the first tick", () => {
    expect(utcClock(0)).toBe("");
    expect(utcClock(T * 1_000 + 59_000)).toBe("22:30:59 UTC");
  });
});
