// Perpl candles (api-docs @ 25ab6e2 rest-endpoints.md "GET /api/v1/market-data/:market_id/candles/:resolution/:from-:to",
// types.md "Candle"): parser + client window checks, against a REAL testnet recording (fixtures README).
import { describe, expect, it } from "vitest";
import { CANDLE_RESOLUTIONS_SEC, MAX_CANDLES_PER_REQUEST, PerplSchemaError, candleWindow, createPerplClient, fixtureTransport, parseCandleSeries, type TransportResponse } from "../src/perpl";
import { fixtureJson } from "./helpers";

const ok = (body: unknown): TransportResponse => ({ status: 200, body });
const noSleep = { sleep: async () => {} };
const H1 = fixtureJson("perpl/testnet/candles-64-3600.json");
const M1 = fixtureJson("perpl/testnet/candles-64-60.json");

describe("parseCandleSeries", () => {
  it("parses the recorded 1h and 1m series (oldest first, prices scaled, volume a decimal string)", () => {
    const h = parseCandleSeries(H1);
    expect(h.r).toBe(3600);
    expect(h.d).toHaveLength(7);
    expect(h.d[0]).toEqual({ t: 1791496800000, o: 2416, c: 2406, h: 2429, l: 2388, v: "3355972980", n: 261 });
    const m = parseCandleSeries(M1);
    expect(m.r).toBe(60);
    expect(m.d.length).toBeGreaterThan(30);
    for (let i = 1; i < m.d.length; i++) expect(m.d[i]!.t).toBeGreaterThan(m.d[i - 1]!.t);
  });
  it("an empty market returns an empty d (docs)", () => {
    expect(parseCandleSeries({ mt: 12, at: { b: 1 }, r: 60, d: [] }).d).toEqual([]);
  });
  it("rejects off-schema candles: non-integer price, missing volume, h < l", () => {
    expect(() => parseCandleSeries({ mt: 12, r: 60, d: [{ t: 1, o: 1.5, c: 1, h: 2, l: 1, v: "0", n: 0 }] })).toThrow(PerplSchemaError);
    expect(() => parseCandleSeries({ mt: 12, r: 60, d: [{ t: 1, o: 1, c: 1, h: 2, l: 1, n: 0 }] })).toThrow(PerplSchemaError);
    expect(() => parseCandleSeries({ mt: 12, r: 60, d: [{ t: 1, o: 1, c: 1, h: 1, l: 2, v: "0", n: 0 }] })).toThrow(/high below low/);
  });
  it("sorts and deduplicates by open time (last wins)", () => {
    const s = parseCandleSeries({ mt: 12, r: 60, d: [{ t: 120000, o: 2, c: 2, h: 2, l: 2, v: "0", n: 0 }, { t: 60000, o: 1, c: 1, h: 1, l: 1, v: "0", n: 0 }, { t: 120000, o: 3, c: 3, h: 3, l: 3, v: "0", n: 1 }] });
    expect(s.d.map((c) => [c.t, c.c])).toEqual([[60000, 1], [120000, 3]]);
  });
});

describe("candleWindow / getCandles", () => {
  it("resolutions are exactly the documented set", () => {
    expect(CANDLE_RESOLUTIONS_SEC).toEqual([60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400]);
    expect(MAX_CANDLES_PER_REQUEST).toBe(1024);
  });
  it("window = the last n candles ending at now, n ≤ 1024, from aligned down to the resolution", () => {
    const w = candleWindow(3600, 1791520541000, 24);
    expect(w.toMs).toBe(1791520541000);
    expect(w.fromMs % 3_600_000).toBe(0);
    expect((w.toMs - w.fromMs) / 3_600_000).toBeLessThanOrEqual(24);
    expect(() => candleWindow(3600, 1791520541000, 1025)).toThrow(RangeError);
    expect(() => candleWindow(120, 1791520541000, 10)).toThrow(/resolution/);
  });
  it("getCandles hits the documented path and validates the resolution echoed back", async () => {
    const path = "/v1/market-data/64/candles/3600/1791498941000-1791520541000";
    const c = createPerplClient({ transport: fixtureTransport({ [path]: ok(H1) }), ...noSleep });
    const s = await c.getCandles(64, 3600, 1791498941000, 1791520541000);
    expect(s.d).toHaveLength(7);
    const bad = createPerplClient({ transport: fixtureTransport({ [path]: ok({ ...(H1 as object), r: 60 }) }), ...noSleep });
    await expect(bad.getCandles(64, 3600, 1791498941000, 1791520541000)).rejects.toThrow(/resolution/);
    await expect(c.getCandles(64, 3600, 10, 5)).rejects.toThrow(RangeError);
    await expect(c.getCandles(64, 3600, 0, 3_600_000 * 1025)).rejects.toThrow(/1024/);
  });
});
