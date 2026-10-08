// Pure helpers for the vault's withdrawal queue (CR-014, MATH_SPEC §5.6). bigint only; unit-tested in redeem.test.ts.
// Mirrors MeridianVault: sync redeem is idle-only (maxRedeem); beyond idle, requestRedeem escrows the shares (still
// exposed to NAV), the keeper's fulfillRedeems prices them at the NAV of that block minus the 5 bps fee and the batch's
// unwind cost, and claimRedeem pays the receiver. Pending requests can be cancelled by their owner only.
import type { Address, RedeemChainView } from "@/data/types";
import { VAULT_WITHDRAW_FEE_WAD, WAD } from "./earnfix";

/** IMeridianVault.RedeemStatus, in enum order (Pending, Claimable, Claimed, Cancelled). */
export const REDEEM_STATUSES = ["requested", "claimable", "claimed", "cancelled"] as const;
export type RedeemStatusName = (typeof REDEEM_STATUSES)[number];

export function redeemStatusName(n: number): RedeemStatusName {
  const s = REDEEM_STATUSES[n];
  if (s === undefined) throw new Error(`unknown RedeemStatus ${n}`);
  return s;
}

/** Indexer enum names (schema.graphql RedeemStatus) → the app's names. */
export function redeemStatusFromIndexer(s: string): RedeemStatusName {
  const m: Record<string, RedeemStatusName> = { Pending: "requested", Claimable: "claimable", Claimed: "claimed", Cancelled: "cancelled" };
  const v = m[s];
  if (v === undefined) throw new Error(`unknown RedeemStatus ${s}`);
  return v;
}

export type WithdrawRoute =
  | { kind: "none" }
  /** idle AUSD covers it: sync redeem now */
  | { kind: "redeem" }
  /** beyond idle: requestRedeem, the keeper fulfils it */
  | { kind: "request" }
  /** one request may not exceed maxSliceAssets (RequestTooLarge): at most `maxShares` per request */
  | { kind: "split"; maxShares: bigint };

/**
 * Which path a withdrawal of `shares` takes. `maxRedeemShares` = vault.maxRedeem(me) (idle-only), `previewToken` =
 * previewRedeem(shares), `maxSliceToken` = vaultParams().maxSliceAssets (0 = no cap known, e.g. the local mock).
 * The split size rounds DOWN so the suggested request stays under the cap.
 */
export function withdrawRoute(shares: bigint, maxRedeemShares: bigint, previewToken: bigint, maxSliceToken: bigint): WithdrawRoute {
  if (shares <= 0n) return { kind: "none" };
  if (shares <= maxRedeemShares) return { kind: "redeem" };
  if (maxSliceToken > 0n && previewToken > maxSliceToken) return { kind: "split", maxShares: (shares * maxSliceToken) / previewToken };
  return { kind: "request" };
}

/**
 * Estimated payout of `shares` at a share price (assets per 1e18 shares, WAD-scaled in token units ⇒ token = shares ·
 * price / 1e18 / 1e12), minus the 5 bps fee. Rounds against the user like previewRedeem: gross down, fee up. Only an
 * estimate for a pending request: the real payout is fixed at fulfilment (that block's NAV, minus the unwind cost).
 */
export function estimateRedeemToken(shares: bigint, sharePriceWad: bigint): bigint {
  const gross = (shares * sharePriceWad) / WAD / 10n ** 12n;
  const fee = (gross * VAULT_WITHDRAW_FEE_WAD + WAD - 1n) / WAD;
  return gross - fee;
}

/** 1-based place of `id` among the vault's pending ids (ascending: the keeper fulfils oldest first); undefined if absent. */
export function queuePosition(id: bigint, pendingIds: readonly bigint[]): number | undefined {
  const sorted = [...new Set(pendingIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const i = sorted.indexOf(id);
  return i < 0 ? undefined : i + 1;
}

export type { RedeemChainView };

export interface RedeemRow {
  id: bigint;
  owner: Address;
  receiver: Address;
  shares: bigint;
  status: RedeemStatusName;
  /** fixed payout (token units) once fulfilled */
  assets?: bigint;
  /** this request's share of the batch's unwind cost (indexer) */
  unwindCost?: bigint;
  requestedBlock: bigint;
  txHash?: string;
  fulfilTxHash?: string;
  claimTxHash?: string;
}

/**
 * Indexer history + live chain state → rows, newest first. The chain wins on status / assets (the indexer can lag);
 * ids only the chain knows (indexer off or behind) are added; ids only the indexer knows are kept as indexed.
 */
export function mergeRedeems(indexed: readonly RedeemRow[], live: readonly RedeemChainView[]): RedeemRow[] {
  const out = new Map<bigint, RedeemRow>();
  for (const r of indexed) out.set(r.id, { ...r });
  for (const c of live) {
    const prev = out.get(c.id);
    const status = redeemStatusName(c.status);
    out.set(c.id, {
      ...(prev ?? {}),
      id: c.id,
      owner: c.owner,
      receiver: c.receiver,
      shares: c.shares,
      status,
      ...(status === "claimable" || status === "claimed" ? { assets: c.assets } : {}),
      requestedBlock: c.requestedBlock,
    });
  }
  return [...out.values()].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
}

/** Which buttons a row gets: Cancel = owner + pending (cancelRedeem: owner only); Claim = claimable (anyone may claim). */
export function redeemActions(row: RedeemRow, me: Address | undefined): { cancel: boolean; claim: boolean } {
  const mine = me !== undefined && row.owner.toLowerCase() === me.toLowerCase();
  return { cancel: mine && row.status === "requested", claim: row.status === "claimable" };
}
