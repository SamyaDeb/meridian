// Per-account history from the indexer (indexer/SCHEMA.md: Trade, Order, Liquidation; perp book only).
// > VERIFY: root-field names, enum literals (BookKind.Perp, OrderStatus) and `_ilike` on address strings against the
// live Hasura console (same caveat as stats.ts). Garbled rows throw: the UI shows "unavailable", never zeros.
import type { Address } from "../types";
import { big, int, postGql } from "./stats";

export type HistTrade = { id: string; isMaker: boolean; isBuy: boolean; priceWad: bigint; sizeWad: bigint; notionalWad: bigint; block: bigint; timestamp: bigint; txHash: string };
export type HistOrder = { id: string; orderId: bigint; isBid: boolean; tick: bigint; lots: bigint; filledLots: bigint; remainingLots: bigint; flags: number; status: string; placedBlock: bigint; updatedBlock: bigint };
export type HistLiquidation = { id: string; sizeTransferred: bigint; markPriceWad: bigint | undefined; penalty: bigint; badDebt: bigint; block: bigint; timestamp: bigint; txHash: string };
export type AccountHistory = { trades: HistTrade[]; orders: HistOrder[]; liquidations: HistLiquidation[] };

export const ACCOUNT_HISTORY_QUERY = `query PulseAccountHistory($a: String!, $limit: Int!) {
  Trade(where: { kind: { _eq: "Perp" }, _or: [{ maker: { _ilike: $a } }, { taker: { _ilike: $a } }] }, order_by: { block: desc }, limit: $limit) {
    id maker taker takerIsBid priceWad sizeWad notionalWad block timestamp txHash
  }
  Order(where: { kind: { _eq: "Perp" }, maker: { _ilike: $a } }, order_by: { updatedBlock: desc }, limit: $limit) {
    id orderId isBid tick lots filledLots remainingLots flags status placedBlock updatedBlock
  }
  Liquidation(where: { kind: { _eq: "Perp" }, account: { _ilike: $a } }, order_by: { block: desc }, limit: $limit) {
    id sizeTransferred markPriceWad penalty badDebt block timestamp txHash
  }
}`;

type Raw = Record<string, unknown>;
const rows = (d: unknown, k: string): Raw[] => {
  const v = ((d ?? {}) as Record<string, unknown>)[k];
  if (!Array.isArray(v)) throw new Error(`indexer: no ${k} field`);
  return v as Raw[];
};

/** Pure: GraphQL data → history. A trade is a buy for the account if it took the bid side as taker or made a bid as maker. */
export function parseAccountHistory(data: unknown, account: Address): AccountHistory {
  const me = account.toLowerCase();
  return {
    trades: rows(data, "Trade").map((r) => {
      const isMaker = String(r.maker).toLowerCase() === me && String(r.taker).toLowerCase() !== me;
      const takerIsBid = Boolean(r.takerIsBid);
      return {
        id: String(r.id),
        isMaker,
        isBuy: isMaker ? !takerIsBid : takerIsBid,
        priceWad: big(r.priceWad, "priceWad"),
        sizeWad: big(r.sizeWad, "sizeWad"),
        notionalWad: big(r.notionalWad, "notionalWad"),
        block: big(r.block, "block"),
        timestamp: big(r.timestamp, "timestamp"),
        txHash: String(r.txHash),
      };
    }),
    orders: rows(data, "Order").map((r) => ({
      id: String(r.id),
      orderId: big(r.orderId, "orderId"),
      isBid: Boolean(r.isBid),
      tick: big(r.tick, "tick"),
      lots: big(r.lots, "lots"),
      filledLots: big(r.filledLots, "filledLots"),
      remainingLots: big(r.remainingLots, "remainingLots"),
      flags: int(r.flags, "flags"),
      status: String(r.status),
      placedBlock: big(r.placedBlock, "placedBlock"),
      updatedBlock: big(r.updatedBlock, "updatedBlock"),
    })),
    liquidations: rows(data, "Liquidation").map((r) => ({
      id: String(r.id),
      sizeTransferred: big(r.sizeTransferred, "sizeTransferred"),
      markPriceWad: r.markPriceWad === null || r.markPriceWad === undefined ? undefined : big(r.markPriceWad, "markPriceWad"),
      penalty: big(r.penalty, "penalty"),
      badDebt: big(r.badDebt, "badDebt"),
      block: big(r.block, "block"),
      timestamp: big(r.timestamp, "timestamp"),
      txHash: String(r.txHash),
    })),
  };
}

export async function fetchAccountHistory(url: string, account: Address, limit: number, signal?: AbortSignal): Promise<AccountHistory> {
  return parseAccountHistory(await postGql(url, ACCOUNT_HISTORY_QUERY, { a: account, limit }, signal), account);
}
