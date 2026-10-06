// Candles from the indexer (Candle1m / Candle1h, indexer/SCHEMA.md; id `<market>-<bucketStart>`, market = ClearingHouse
// address, bucketStart = block timestamp floored to the bucket, seconds). The ONLY candle source for the UI: the chain
// data source has no candles of its own, and mock candles are never shown as market data.
// > VERIFY: root-field names, `_ilike` on `market` and bigint encoding against the live Hasura console (same as stats.ts).
import type { Address, Candle } from "../types";
import { big, int, postGql } from "./stats";

export type CandleTable = "Candle1m" | "Candle1h";

export const candlesQuery = (table: CandleTable) => `query MeridianCandles($market: String!, $limit: Int!) {
  ${table}(where: { market: { _ilike: $market } }, order_by: { bucketStart: desc }, limit: $limit) {
    id market bucketStart open high low close volumeBaseWad volumeQuoteWad trades
  }
}`;

/** Pure: GraphQL `data` → candles, oldest first. Garbled numerics throw (never silently zero). */
export function parseCandles(data: unknown, table: CandleTable): Candle[] {
  const rows = ((data ?? {}) as Record<string, unknown>)[table];
  if (!Array.isArray(rows)) throw new Error(`indexer: no ${table} field`);
  return rows
    .map((r: Record<string, unknown>) => ({
      id: String(r.id),
      market: String(r.market) as Address,
      bucketStart: big(r.bucketStart, "bucketStart"),
      open: big(r.open, "open"),
      high: big(r.high, "high"),
      low: big(r.low, "low"),
      close: big(r.close, "close"),
      volumeBaseWad: big(r.volumeBaseWad, "volumeBaseWad"),
      volumeQuoteWad: big(r.volumeQuoteWad, "volumeQuoteWad"),
      trades: int(r.trades, "trades"),
    }))
    .sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0));
}

export async function fetchCandles(url: string, table: CandleTable, market: Address, limit: number, signal?: AbortSignal): Promise<Candle[]> {
  return parseCandles(await postGql(url, candlesQuery(table), { market, limit }, signal), table);
}
