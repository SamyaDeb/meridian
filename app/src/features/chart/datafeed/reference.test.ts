import { describe, expect, it } from "vitest";
import { GECKO_BASE, GECKO_QUERIES, REFERENCE_LIMIT, REFERENCE_NETWORK, REFERENCE_POOL, UPSTREAM_OF, geckoToBars, parseReferenceQuery, upstreamUrl } from "./reference";
import { TIMEFRAMES, TIMEFRAME_SEC } from "./types";

const WAD = 10n ** 18n;
const T0 = 1_791_000_000 - (1_791_000_000 % 3_600); // an hour boundary
type Row = [number, number, number, number, number, number];
const gecko = (rows: unknown[]) => ({ data: { id: "x", type: "ohlcv_request_response", attributes: { ohlcv_list: rows } }, meta: {} });

describe("geckoToBars: GeckoTerminal OHLCV → Bar[]", () => {
  it("maps [t, o, h, l, c, v] to ascending WAD bars with zero volume (an outside venue's volume is never drawn)", () => {
    const bars = geckoToBars(gecko([[T0, 0.03, 0.031, 0.0295, 0.031, 5_000], [T0 + 60, 0.031, 0.032, 0.03, 0.0315, 9_000]] satisfies Row[]), "1m");
    expect(bars.map((b) => b.time)).toEqual([T0, T0 + 60]);
    expect(bars[0]).toEqual({ time: T0, open: (30n * WAD) / 1000n, high: (31n * WAD) / 1000n, low: (295n * WAD) / 10_000n, close: (31n * WAD) / 1000n, volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0 });
    expect(bars[1]!.close).toBe((315n * WAD) / 10_000n);
  });
  it("sorts the upstream's newest-first order ascending and fills missing buckets, flagged gapFill", () => {
    const bars = geckoToBars(gecko([[T0 + 180, 2, 2, 2, 2, 1], [T0, 1, 1, 1, 1, 1]]), "1m");
    expect(bars.map((b) => [b.time, b.gapFill ?? false])).toEqual([[T0, false], [T0 + 60, true], [T0 + 120, true], [T0 + 180, false]]);
    expect(bars[1]!.close).toBe(WAD);
  });
  it("keeps the last row of a duplicated time and drops malformed rows", () => {
    const bars = geckoToBars(gecko([[T0, 1, 1, 1, 1, 0], [T0, 2, 2, 2, 2, 0], [T0 + 60, NaN, 1, 1, 1, 0], [T0 + 120, 1, 0.5, 2, 1, 0], [T0 + 180, -1, 1, 1, 1, 0], [T0 + 240, 1, 1], "x", null]), "1m");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBe(2n * WAD);
  });
  it("accepts numeric strings", () => {
    expect(geckoToBars(gecko([[String(T0), "0.03", "0.03", "0.03", "0.03", "1"]]), "1m")[0]!.close).toBe((3n * WAD) / 100n);
  });
  it("empty list ⇒ []; missing or garbled shape ⇒ throws (shown as unavailable, never invented)", () => {
    expect(geckoToBars(gecko([]), "1h")).toEqual([]);
    expect(() => geckoToBars(null, "1h")).toThrow(/ohlcv_list/);
    expect(() => geckoToBars({ data: { attributes: {} } }, "1h")).toThrow(/ohlcv_list/);
    expect(() => geckoToBars({ data: { attributes: { ohlcv_list: "nope" } } }, "1h")).toThrow(/ohlcv_list/);
  });
  it("aggregates 3m from minute/1", () => {
    const bars = geckoToBars(gecko([[T0 + 120, 2.5, 2.5, 0.5, 1, 0], [T0 + 60, 2, 3, 1.5, 2.5, 0], [T0, 1, 2, 1, 2, 0]]), "3m");
    expect(bars).toHaveLength(1);
    expect([bars[0]!.open, bars[0]!.high, bars[0]!.low, bars[0]!.close]).toEqual([WAD, 3n * WAD, WAD / 2n, WAD]);
  });
  it("aggregates 1W from day/1 on Monday 00:00 UTC buckets", () => {
    const monday = 1_791_158_400; // Mon 5 Oct 2026 00:00 UTC
    expect(new Date(monday * 1_000).getUTCDay()).toBe(1);
    const days: Row[] = [-1, 0, 1, 6, 7].map((d, i) => [monday + d * 86_400, i + 1, i + 1, i + 1, i + 1, 0]);
    const bars = geckoToBars(gecko(days), "1W");
    expect(bars.map((b) => b.time)).toEqual([monday - 7 * 86_400, monday, monday + 7 * 86_400]);
    expect([bars[1]!.open, bars[1]!.close]).toEqual([2n * WAD, 4n * WAD]); // Mon..Sun of one week
  });
});

describe("timeframe mapping and server query validation", () => {
  it("every timeframe maps to an allow-listed upstream bucket that divides it, and the route accepts its query", () => {
    const sec = { minute: 60, hour: 3_600, day: 86_400 } as const;
    for (const tf of TIMEFRAMES) {
      const u = UPSTREAM_OF[tf];
      expect(TIMEFRAME_SEC[tf] % (sec[u.timeframe] * u.aggregate)).toBe(0);
      expect(parseReferenceQuery(new URLSearchParams({ timeframe: u.timeframe, aggregate: String(u.aggregate) }))).toEqual(u);
    }
  });
  it("rejects pairs the upstream doesn't accept and anything else", () => {
    const q = (o: Record<string, string>) => parseReferenceQuery(new URLSearchParams(o));
    expect(q({ timeframe: "minute", aggregate: "3" })).toBeNull();
    expect(q({ timeframe: "hour", aggregate: "2" })).toBeNull();
    expect(q({ timeframe: "day", aggregate: "7" })).toBeNull();
    expect(q({ timeframe: "week", aggregate: "1" })).toBeNull();
    expect(q({ timeframe: "minute" })).toBeNull();
    expect(q({})).toBeNull();
    expect(GECKO_QUERIES).toHaveLength(7);
  });
  it("upstream URL: the fixed network and pool, limit 1000 (the route is not a general proxy)", () => {
    const u = new URL(upstreamUrl({ timeframe: "hour", aggregate: 4 }));
    expect(`${u.origin}${u.pathname}`).toBe(`${GECKO_BASE}/networks/${REFERENCE_NETWORK}/pools/${REFERENCE_POOL}/ohlcv/hour`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ aggregate: "4", limit: String(REFERENCE_LIMIT) });
    expect(REFERENCE_POOL).toBe("0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954");
  });
});
