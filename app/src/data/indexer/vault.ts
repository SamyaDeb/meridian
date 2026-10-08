// Vault totals and share-price history from the indexer (K2.4): the whole history since the vault's first
// NavSnapshot, instead of the chain source's RPC log window (2,000 blocks ≈ 10 min of testnet history).
import type { Address, VaultSnapshot } from "../types";
import { big, int, optBig, postGql } from "./stats";
import { rows, str } from "./rows";

export type VaultTotals = {
  id: Address;
  depositedToken: bigint;
  withdrawnToken: bigint;
  userCount: number;
  apy24hWad?: bigint;
  apy7dWad?: bigint;
  pendingRedeemShares: bigint;
  claimableToken: bigint;
};

export const VAULT_HISTORY_QUERY = `query MeridianVaultHistory($chainId: Int!, $vault: String!, $limit: Int!) {
  Vault(where: { chainId: { _eq: $chainId }, id: { _ilike: $vault } }, limit: 1) {
    id depositedToken withdrawnToken userCount apy24hWad apy7dWad pendingRedeemShares claimableToken
  }
  VaultSnapshot(where: { chainId: { _eq: $chainId }, vault_id: { _ilike: $vault } }, order_by: { block: desc }, limit: $limit) {
    id navToken totalShares sharePriceWad fundingAccruedWad block timestamp
  }
}`;

/** Pure: totals (undefined before the vault's first event) + snapshots newest first, like the chain source. */
export function parseVaultHistory(data: unknown, vault: Address): { totals?: VaultTotals; snapshots: VaultSnapshot[] } {
  const v = rows(data, "Vault")[0];
  const snapshots = rows(data, "VaultSnapshot").map((r) => ({
    id: str(r.id, "id"),
    vault_id: vault,
    navToken: big(r.navToken, "navToken"),
    totalShares: big(r.totalShares, "totalShares"),
    sharePriceWad: big(r.sharePriceWad, "sharePriceWad"),
    fundingAccruedWad: big(r.fundingAccruedWad, "fundingAccruedWad"),
    block: big(r.block, "block"),
    timestamp: big(r.timestamp, "timestamp"),
  }));
  if (!v) return { snapshots };
  const apy24hWad = optBig(v.apy24hWad, "apy24hWad");
  const apy7dWad = optBig(v.apy7dWad, "apy7dWad");
  return {
    totals: {
      id: str(v.id, "id") as Address,
      depositedToken: big(v.depositedToken, "depositedToken"),
      withdrawnToken: big(v.withdrawnToken, "withdrawnToken"),
      userCount: int(v.userCount, "userCount"),
      ...(apy24hWad !== undefined ? { apy24hWad } : {}),
      ...(apy7dWad !== undefined ? { apy7dWad } : {}),
      pendingRedeemShares: big(v.pendingRedeemShares, "pendingRedeemShares"),
      claimableToken: big(v.claimableToken, "claimableToken"),
    },
    snapshots,
  };
}

export const fetchVaultHistory = async (url: string, chainId: number, vault: Address, limit: number, signal?: AbortSignal) =>
  parseVaultHistory(await postGql(url, VAULT_HISTORY_QUERY, { chainId, vault, limit }, signal), vault);
