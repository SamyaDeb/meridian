import { describe, expect, it } from "vitest";
import { candlesQuery, parseCandles } from "./candles";

const row = (b: string) => ({ id: `m-${b}`, market: "0xAbC", bucketStart: b, open: "1", high: "3", low: "1", close: "2", volumeBaseWad: "10", volumeQuoteWad: 20, trades: 2 });

describe("indexer candles", () => {
  it("parses strings or numbers into bigint, oldest first", () => {
    const out = parseCandles({ Candle1h: [row("7200"), row("3600")] }, "Candle1h");
    expect(out.map((c) => c.bucketStart)).toEqual([3600n, 7200n]);
    expect(out[0]!.volumeQuoteWad).toBe(20n);
    expect(out[0]!.trades).toBe(2);
  });
  it("rejects garbled numerics and a missing table (no silent zeros)", () => {
    expect(() => parseCandles({ Candle1m: [{ ...row("60"), close: "1.5" }] }, "Candle1m")).toThrow(/close/);
    expect(() => parseCandles({}, "Candle1m")).toThrow(/Candle1m/);
  });
  it("query targets the table, newest first, filtered by market", () => {
    const q = candlesQuery("Candle1m");
    expect(q).toContain("Candle1m(");
    expect(q).toContain("order_by: { bucketStart: desc }");
    expect(q).toContain("_ilike: $market");
  });
});
