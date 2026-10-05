// Mark and index price history from the indexer, for the chart's price-source switch.
// Index = OraclePrice (one row per oracle update, keyed by the market's oracle address; time = publishTime).
// Mark = FundingTick.mark (one row per funding block: dense, so only the most recent `limit` blocks are fetched).
// > VERIFY: root-field names, `market_id`, and `_ilike` on address strings against the live Hasura console.
import { big, postGql } from "./stats";

export type PricePoint = { time: number; price: bigint };

export const INDEX_QUERY = `query PulseIndex($oracle: String!, $limit: Int!) {
  OraclePrice(where: { oracle: { _ilike: $oracle } }, order_by: { block: desc }, limit: $limit) { priceWad publishTime }
}`;
export const MARK_QUERY = `query PulseMark($market: String!, $limit: Int!) {
  FundingTick(where: { market_id: { _ilike: $market } }, order_by: { block: desc }, limit: $limit) { mark timestamp }
}`;

/** Pure: GraphQL data → points (oldest first). Garbled rows throw. */
export function parsePoints(data: unknown, table: "OraclePrice" | "FundingTick"): PricePoint[] {
  const rows = ((data ?? {}) as Record<string, unknown>)[table];
  if (!Array.isArray(rows)) throw new Error(`indexer: no ${table} field`);
  return rows
    .map((r: Record<string, unknown>) =>
      table === "OraclePrice" ? { time: Number(big(r.publishTime, "publishTime")), price: big(r.priceWad, "priceWad") } : { time: Number(big(r.timestamp, "timestamp")), price: big(r.mark, "mark") },
    )
    .sort((a, b) => a.time - b.time);
}

export const fetchIndexPoints = async (url: string, oracle: string, limit: number, signal?: AbortSignal) => parsePoints(await postGql(url, INDEX_QUERY, { oracle, limit }, signal), "OraclePrice");
export const fetchMarkPoints = async (url: string, market: string, limit: number, signal?: AbortSignal) => parsePoints(await postGql(url, MARK_QUERY, { market, limit }, signal), "FundingTick");
