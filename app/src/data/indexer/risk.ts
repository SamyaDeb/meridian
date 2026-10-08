// Rates & Risk data from the indexer: open positions of the product market and the insurance fund totals.
// > VERIFY: relation column `market_id` on AccountMarket, `_neq` on BigInt, and root-field names on the live Hasura.
import type { OpenPos } from "@/lib/liqDistance";
import { big, postGql } from "./stats";

export const RISK_QUERY = `query MeridianRisk($market: String!) {
  AccountMarket(where: { market_id: { _ilike: $market }, size: { _neq: "0" } }, limit: 1000) { account_id size entryPrice collateralWad }
  InsuranceFund { fundedToken coveredToken }
}`;

export type RiskData = { positions: OpenPos[]; insurance?: { fundedToken: bigint; coveredToken: bigint } };

export function parseRisk(data: unknown): RiskData {
  const d = (data ?? {}) as { AccountMarket?: Record<string, unknown>[]; InsuranceFund?: Record<string, unknown>[] };
  if (!Array.isArray(d.AccountMarket)) throw new Error("indexer: no AccountMarket field");
  const f = d.InsuranceFund?.[0];
  return {
    positions: d.AccountMarket.map((r) => ({
      ...(typeof r.account_id === "string" ? { account: r.account_id.toLowerCase() } : {}),
      size: big(r.size, "size"),
      entryPrice: big(r.entryPrice, "entryPrice"),
      collateralWad: big(r.collateralWad, "collateralWad"),
    })),
    ...(f ? { insurance: { fundedToken: big(f.fundedToken, "fundedToken"), coveredToken: big(f.coveredToken, "coveredToken") } } : {}),
  };
}

export const fetchRisk = async (url: string, market: string, signal?: AbortSignal) => parseRisk(await postGql(url, RISK_QUERY, { market }, signal));
