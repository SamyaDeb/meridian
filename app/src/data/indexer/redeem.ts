// Earn v2 (K6 B1): my vault withdrawal requests and the vault's pending queue from the indexer (VaultRedeemRequest).
// History (tx hashes, unwind cost) comes from here; live status / payout come from the chain (mergeRedeems).
import type { Address } from "../types";
import { redeemStatusFromIndexer, type RedeemRow } from "@/lib/redeem";
import { big, optBig, postGql } from "./stats";
import { optStr, rows, str } from "./rows";

export const REDEEMS_QUERY = `query MeridianRedeems($chainId: Int!, $vault: String!, $a: String!) {
  mine: VaultRedeemRequest(where: { chainId: { _eq: $chainId }, vault: { _ilike: $vault }, owner: { _ilike: $a } }, order_by: { requestId: desc }, limit: 50) {
    requestId owner receiver shares status assets unwindCost requestedBlock txHash fulfilTxHash claimTxHash
  }
  queue: VaultRedeemRequest(where: { chainId: { _eq: $chainId }, vault: { _ilike: $vault }, status: { _eq: "Pending" } }, order_by: { requestId: asc }, limit: 100) {
    requestId
  }
}`;

/** Pure: my rows (newest first) + the pending ids of the whole vault (oldest first). */
export function parseRedeems(data: unknown): { mine: RedeemRow[]; pendingIds: bigint[] } {
  const mine = rows(data, "mine").map((r): RedeemRow => {
    const assets = optBig(r.assets, "assets");
    const unwindCost = optBig(r.unwindCost, "unwindCost");
    const fulfil = optStr(r.fulfilTxHash, "fulfilTxHash");
    const claim = optStr(r.claimTxHash, "claimTxHash");
    return {
      id: big(r.requestId, "requestId"),
      owner: str(r.owner, "owner") as Address,
      receiver: str(r.receiver, "receiver") as Address,
      shares: big(r.shares, "shares"),
      status: redeemStatusFromIndexer(str(r.status, "status")),
      ...(assets !== undefined ? { assets } : {}),
      ...(unwindCost !== undefined ? { unwindCost } : {}),
      requestedBlock: big(r.requestedBlock, "requestedBlock"),
      txHash: str(r.txHash, "txHash"),
      ...(fulfil ? { fulfilTxHash: fulfil } : {}),
      ...(claim ? { claimTxHash: claim } : {}),
    };
  });
  const pendingIds = rows(data, "queue").map((r) => big(r.requestId, "requestId"));
  return { mine, pendingIds };
}

export const fetchRedeems = async (url: string, chainId: number, vault: Address, account: Address, signal?: AbortSignal) =>
  parseRedeems(await postGql(url, REDEEMS_QUERY, { chainId, vault, a: account }, signal));
