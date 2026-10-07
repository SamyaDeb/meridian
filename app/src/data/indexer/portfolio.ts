// One account's all-time totals from the indexer (K2.4): per-market realized PnL, funding paid, fees, liquidations,
// and its vault v2 redemption requests (request → fulfil → claim). Live position values stay on getAccount().
import type { Address } from "../types";
import { big, int, optBig, postGql } from "./stats";
import { rows, str, optStr } from "./rows";

export type AccountTotals = {
  market: string;
  fundingPaidWad: bigint; // + = paid
  realizedPnlWad: bigint;
  feesPaidWad: bigint; // rebates negative
  liquidations: number;
  depositedToken: bigint;
  withdrawnToken: bigint;
  lastTradeBlock?: bigint;
};

export const REDEEM_STATUSES = ["Pending", "Claimable", "Claimed", "Cancelled"] as const;
export type RedeemRequest = {
  requestId: bigint;
  shares: bigint;
  status: (typeof REDEEM_STATUSES)[number];
  assets?: bigint;
  unwindCost?: bigint;
  requestedAt: bigint;
  fulfilledAt?: bigint;
  claimedAt?: bigint;
  cancelledAt?: bigint;
  txHash: string;
};

export const PORTFOLIO_QUERY = `query MeridianPortfolio($chainId: Int!, $a: String!) {
  AccountMarket(where: { chainId: { _eq: $chainId }, account_id: { _ilike: $a } }) {
    market_id fundingPaid realizedPnl feesPaid liquidationCount depositedToken withdrawnToken lastTradeBlock
  }
  VaultRedeemRequest(where: { chainId: { _eq: $chainId }, owner: { _ilike: $a } }, order_by: { requestId: desc }, limit: 50) {
    requestId shares status assets unwindCost requestedAt fulfilledAt claimedAt cancelledAt txHash
  }
}`;

export function parsePortfolio(data: unknown): { markets: AccountTotals[]; redeems: RedeemRequest[] } {
  const markets = rows(data, "AccountMarket").map((r) => {
    const lastTradeBlock = optBig(r.lastTradeBlock, "lastTradeBlock");
    return {
      market: str(r.market_id, "market_id"),
      fundingPaidWad: big(r.fundingPaid, "fundingPaid"),
      realizedPnlWad: big(r.realizedPnl, "realizedPnl"),
      feesPaidWad: big(r.feesPaid, "feesPaid"),
      liquidations: int(r.liquidationCount, "liquidationCount"),
      depositedToken: big(r.depositedToken, "depositedToken"),
      withdrawnToken: big(r.withdrawnToken, "withdrawnToken"),
      ...(lastTradeBlock !== undefined ? { lastTradeBlock } : {}),
    };
  });
  const redeems = rows(data, "VaultRedeemRequest").map((r) => {
    const status = str(r.status, "status") as RedeemRequest["status"];
    if (!REDEEM_STATUSES.includes(status)) throw new Error("indexer: bad status");
    const opt = (k: "assets" | "unwindCost" | "fulfilledAt" | "claimedAt" | "cancelledAt") => {
      const v = optBig(r[k], k);
      return v === undefined ? {} : { [k]: v };
    };
    return {
      requestId: big(r.requestId, "requestId"),
      shares: big(r.shares, "shares"),
      status,
      requestedAt: big(r.requestedAt, "requestedAt"),
      txHash: optStr(r.txHash, "txHash") ?? "",
      ...opt("assets"),
      ...opt("unwindCost"),
      ...opt("fulfilledAt"),
      ...opt("claimedAt"),
      ...opt("cancelledAt"),
    } as RedeemRequest;
  });
  return { markets, redeems };
}

/** Σ over markets (one product market at launch; the shape allows more). */
export function sumTotals(ms: readonly AccountTotals[]) {
  return ms.reduce(
    (s, m) => ({
      fundingPaidWad: s.fundingPaidWad + m.fundingPaidWad,
      realizedPnlWad: s.realizedPnlWad + m.realizedPnlWad,
      feesPaidWad: s.feesPaidWad + m.feesPaidWad,
      liquidations: s.liquidations + m.liquidations,
    }),
    { fundingPaidWad: 0n, realizedPnlWad: 0n, feesPaidWad: 0n, liquidations: 0 },
  );
}

export const fetchPortfolio = async (url: string, chainId: number, account: Address, signal?: AbortSignal) =>
  parsePortfolio(await postGql(url, PORTFOLIO_QUERY, { chainId, a: account }, signal));
