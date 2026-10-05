import { describe, expect, it } from "vitest";
import { RANGES, rangeWindow } from "./ranges";

describe("range bar", () => {
  const now = Date.UTC(2026, 9, 5, 12) / 1_000;
  it("each range has a timeframe; windows end now and span the range", () => {
    expect(rangeWindow("1D", now)).toEqual({ timeframe: "1m", from: now - 86_400, to: now });
    expect(rangeWindow("5D", now).timeframe).toBe("5m");
    expect(rangeWindow("1Y", now).from).toBe(now - 365 * 86_400);
    for (const r of RANGES) expect(rangeWindow(r, now).timeframe).toBeTruthy();
  });
  it("YTD starts 1 Jan UTC; All fits everything", () => {
    expect(rangeWindow("YTD", now).from).toBe(Date.UTC(2026, 0, 1) / 1_000);
    expect(rangeWindow("All", now)).toEqual({ timeframe: "1D" });
  });
});
