// Funding history from the indexer (K2.4): realized-APR windows (FundingWindow), the hourly Meridian-vs-Perpl series
// (CrossVenueFunding) and an account's funding payments (FundingPayment). Shapes: indexer/SCHEMA.md.
import type { Address } from "../types";
import { big, optBig, postGql } from "./stats";
import { type Raw, rows, optStr } from "./rows";

export type FundingWindow = {
  block: bigint;
  apr1hWad?: bigint;
  apr8hWad?: bigint;
  apr24hWad?: bigint;
  apr7dWad?: bigint;
  rateAprWad: bigint;
};

export const FUNDING_WINDOW_QUERY = `query MeridianFundingWindow($chainId: Int!, $market: String!) {
  FundingWindow(where: { chainId: { _eq: $chainId }, market: { _ilike: $market } }, limit: 1) {
    block apr1hWad apr8hWad apr24hWad apr7dWad rateAprWad
  }
}`;

/** Pure: undefined when the market has no FundingWindow row yet (no funding tick indexed). */
export function parseFundingWindow(data: unknown): FundingWindow | undefined {
  const r = rows(data, "FundingWindow")[0];
  if (!r) return undefined;
  const w: FundingWindow = { block: big(r.block, "block"), rateAprWad: big(r.rateAprWad, "rateAprWad") };
  for (const k of ["apr1hWad", "apr8hWad", "apr24hWad", "apr7dWad"] as const) {
    const v = optBig(r[k], k);
    if (v !== undefined) w[k] = v;
  }
  return w;
}

export const fetchFundingWindow = async (url: string, chainId: number, market: Address, signal?: AbortSignal) =>
  parseFundingWindow(await postGql(url, FUNDING_WINDOW_QUERY, { chainId, market }, signal));

export type CrossVenueHour = {
  hour: number; // unix seconds, start of the UTC hour
  meridianAprWad?: bigint;
  perplAprWad?: bigint;
  spreadAprWad?: bigint;
};

export const CROSS_VENUE_QUERY = `query MeridianCrossVenue($chainId: Int!, $limit: Int!) {
  CrossVenueFunding(where: { chainId: { _eq: $chainId } }, order_by: { hour: desc }, limit: $limit) {
    hour meridianAprWad perplAprWad spreadAprWad
  }
}`;

/** Pure: oldest first. */
export function parseCrossVenue(data: unknown): CrossVenueHour[] {
  return rows(data, "CrossVenueFunding")
    .map((r: Raw) => {
      const h: CrossVenueHour = { hour: Number(big(r.hour, "hour")) };
      for (const k of ["meridianAprWad", "perplAprWad", "spreadAprWad"] as const) {
        const v = optBig(r[k], k);
        if (v !== undefined) h[k] = v;
      }
      return h;
    })
    .sort((a, b) => a.hour - b.hour);
}

export const fetchCrossVenue = async (url: string, chainId: number, hours: number, signal?: AbortSignal) =>
  parseCrossVenue(await postGql(url, CROSS_VENUE_QUERY, { chainId, limit: hours }, signal));

/** One settled funding payment: + = the account paid, − = received (quote WAD). */
export type FundingPayment = { block: bigint; timestamp: bigint; payment: bigint; txHash?: string };

export const FUNDING_PAYMENTS_QUERY = `query MeridianFundingPayments($chainId: Int!, $a: String!, $limit: Int!) {
  FundingPayment(where: { chainId: { _eq: $chainId }, account: { _ilike: $a } }, order_by: { block: desc }, limit: $limit) {
    block timestamp payment txHash
  }
}`;

/** Pure: newest first, as the indexer returns them. */
export function parseFundingPayments(data: unknown): FundingPayment[] {
  return rows(data, "FundingPayment").map((r) => {
    const tx = optStr(r.txHash, "txHash");
    return { block: big(r.block, "block"), timestamp: big(r.timestamp, "timestamp"), payment: big(r.payment, "payment"), ...(tx ? { txHash: tx } : {}) };
  });
}

export const fetchFundingPayments = async (url: string, chainId: number, account: Address, limit: number, signal?: AbortSignal) =>
  parseFundingPayments(await postGql(url, FUNDING_PAYMENTS_QUERY, { chainId, a: account, limit }, signal));
