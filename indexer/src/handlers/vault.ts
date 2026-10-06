// IMeridianVault (ERC-4626 over AUSD) + IKuruHedger events.
import { indexer } from "envio";
import {
  FIELDS,
  ZERO_ADDRESS,
  type Ctx,
  evId,
  blockOf,
  tsOf,
  getVault,
  getVaultUser,
  touchAccount,
  updateProtocol,
  logAdmin,
  toJson,
} from "../lib/common.js";
import { annualizedChangeWad } from "../lib/math.js";

export const REBALANCE_REASONS = [
  "None",
  "Deploy",
  "DeltaDrift",
  "MarginLow",
  "ExitHedge",
  "EnterHedge",
  "Withdraw",
  "SkewCap",
] as const;

const HOUR = 3_600n;
const MAX_HOUR_WALK = 3n; // bounded lookback when an hour had no NavSnapshot

async function sharePriceHoursAgo(context: Ctx, vault: string, hour: bigint, hoursAgo: bigint) {
  for (let k = 0n; k <= MAX_HOUR_WALK; k++) {
    const h = await context.VaultHourly.get(`${vault}-${hour - hoursAgo - k}`);
    if (h) return h;
  }
  return undefined;
}

indexer.onEvent({ contract: "MeridianVault", event: "Deposit", fields: FIELDS }, async ({ event, context }) => {
  const { owner, assets } = event.params;
  const block = blockOf(event);
  await touchAccount(context, owner, block, tsOf(event));
  const u = await getVaultUser(context, event.srcAddress, owner, block);
  context.VaultUser.set({ ...u, depositedToken: u.depositedToken + assets, updatedBlock: block });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, depositedToken: v.depositedToken + assets });
});

indexer.onEvent({ contract: "MeridianVault", event: "Withdraw", fields: FIELDS }, async ({ event, context }) => {
  const { owner, assets } = event.params;
  const block = blockOf(event);
  const u = await getVaultUser(context, event.srcAddress, owner, block);
  context.VaultUser.set({ ...u, withdrawnToken: u.withdrawnToken + assets, updatedBlock: block });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, withdrawnToken: v.withdrawnToken + assets });
});

// Share balances come from Transfer only (Deposit/Withdraw also emit mint/burn Transfers). The vault's own balance
// (CR-014 escrow of Pending requests) is not a user: it is tracked as Vault.pendingRedeemShares instead.
indexer.onEvent({ contract: "MeridianVault", event: "Transfer", fields: FIELDS }, async ({ event, context }) => {
  const { from, to, value } = event.params;
  const block = blockOf(event);
  if (from !== ZERO_ADDRESS && from !== event.srcAddress) {
    const u = await getVaultUser(context, event.srcAddress, from, block);
    context.VaultUser.set({ ...u, shares: u.shares - value, updatedBlock: block });
  }
  if (to !== ZERO_ADDRESS && to !== event.srcAddress) {
    const u = await getVaultUser(context, event.srcAddress, to, block);
    context.VaultUser.set({ ...u, shares: u.shares + value, updatedBlock: block });
  }
});

indexer.onEvent({ contract: "MeridianVault", event: "NavSnapshot", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const block = blockOf(event);
  const ts = tsOf(event);
  const hour = ts / HOUR;
  context.VaultSnapshot.set({
    id: evId(event),
    vault_id: event.srcAddress,
    navToken: p.nav,
    totalShares: p.totalShares,
    sharePriceWad: p.sharePriceWad,
    fundingAccruedWad: p.fundingAccruedWad,
    block,
    timestamp: ts,
  });
  context.VaultHourly.set({ id: `${event.srcAddress}-${hour}`, vault: event.srcAddress, hour, sharePriceWad: p.sharePriceWad, timestamp: ts });
  const d1 = await sharePriceHoursAgo(context, event.srcAddress, hour, 24n);
  const d7 = await sharePriceHoursAgo(context, event.srcAddress, hour, 168n);
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({
    ...v,
    navToken: p.nav,
    totalShares: p.totalShares,
    sharePriceWad: p.sharePriceWad,
    fundingAccruedWad: p.fundingAccruedWad,
    apy24hWad: d1 ? annualizedChangeWad(d1.sharePriceWad, p.sharePriceWad, ts - d1.timestamp) : v.apy24hWad,
    apy7dWad: d7 ? annualizedChangeWad(d7.sharePriceWad, p.sharePriceWad, ts - d7.timestamp) : v.apy7dWad,
  });
  await updateProtocol(context, () => ({ vaultNavToken: p.nav }), { block: blockOf(event) });
});

indexer.onEvent({ contract: "MeridianVault", event: "Rebalanced", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  const reason = REBALANCE_REASONS[Number(p.reason)] ?? "None";
  const block = blockOf(event);
  context.VaultRebalance.set({
    id: evId(event),
    vault: event.srcAddress,
    reason,
    spotDeltaBase: p.spotDeltaBase,
    perpDeltaBase: p.perpDeltaBase,
    navAfter: p.navAfter,
    sharePriceWad: p.sharePriceWad,
    block,
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, lastRebalanceReason: reason, lastRebalanceBlock: block });
});

indexer.onEvent({ contract: "MeridianVault", event: "HedgeEntered", fields: FIELDS }, async ({ event, context }) => {
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, hedged: true });
  await logAdmin(context, event, "HedgeEntered", event.params);
});

indexer.onEvent({ contract: "MeridianVault", event: "HedgeExited", fields: FIELDS }, async ({ event, context }) => {
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, hedged: false });
  await logAdmin(context, event, "HedgeExited", event.params);
});

indexer.onEvent({ contract: "MeridianVault", event: "VaultParamsUpdated", fields: FIELDS }, async ({ event, context }) => {
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, params: toJson(event.params.params) });
  await logAdmin(context, event, "VaultParamsUpdated", event.params.params);
});

indexer.onEvent({ contract: "MeridianVault", event: "KeeperUpdated", fields: FIELDS }, async ({ event, context }) => {
  const { keeper, allowed } = event.params;
  const v = await getVault(context, event.srcAddress);
  const rest = v.keepers.filter((k) => k !== keeper);
  context.Vault.set({ ...v, keepers: allowed ? [...rest, keeper] : rest });
  await logAdmin(context, event, "KeeperUpdated", event.params);
});

// ─── CR-014: request → fulfil → claim (and cancel), emergency unwind ─────────────────────────────────────────────

const reqId = (vault: string, id: bigint) => `${vault}-${id}`;

indexer.onEvent({ contract: "MeridianVault", event: "RedeemRequested", fields: FIELDS }, async ({ event, context }) => {
  const { id, owner, receiver, shares } = event.params;
  const block = blockOf(event);
  context.VaultRedeemRequest.set({
    id: reqId(event.srcAddress, id),
    vault: event.srcAddress,
    requestId: id,
    owner,
    receiver,
    shares,
    status: "Pending",
    assets: undefined,
    unwindCost: undefined,
    requestedBlock: block,
    requestedAt: tsOf(event),
    fulfilledBlock: undefined,
    claimedBlock: undefined,
    updatedBlock: block,
    txHash: event.transaction.hash,
  });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, pendingRedeemShares: v.pendingRedeemShares + shares });
});

indexer.onEvent({ contract: "MeridianVault", event: "RedeemCancelled", fields: FIELDS }, async ({ event, context }) => {
  const r = await context.VaultRedeemRequest.get(reqId(event.srcAddress, event.params.id));
  if (!r || r.status !== "Pending") return;
  context.VaultRedeemRequest.set({ ...r, status: "Cancelled", updatedBlock: blockOf(event) });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, pendingRedeemShares: v.pendingRedeemShares - r.shares });
});

indexer.onEvent({ contract: "MeridianVault", event: "RedeemFulfilled", fields: FIELDS }, async ({ event, context }) => {
  const { id, assets, unwindCost } = event.params;
  const r = await context.VaultRedeemRequest.get(reqId(event.srcAddress, id));
  if (!r || r.status !== "Pending") return;
  const block = blockOf(event);
  context.VaultRedeemRequest.set({ ...r, status: "Claimable", assets, unwindCost, fulfilledBlock: block, updatedBlock: block });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, pendingRedeemShares: v.pendingRedeemShares - r.shares, claimableToken: v.claimableToken + assets });
});

indexer.onEvent({ contract: "MeridianVault", event: "RedeemClaimed", fields: FIELDS }, async ({ event, context }) => {
  const { id, assets } = event.params;
  const r = await context.VaultRedeemRequest.get(reqId(event.srcAddress, id));
  if (!r || r.status !== "Claimable") return;
  const block = blockOf(event);
  context.VaultRedeemRequest.set({ ...r, status: "Claimed", claimedBlock: block, updatedBlock: block });
  // the claim is the withdrawal of the owner's position (the sync path's Withdraw event is not emitted here)
  const u = await getVaultUser(context, event.srcAddress, r.owner, block);
  context.VaultUser.set({ ...u, withdrawnToken: u.withdrawnToken + assets, updatedBlock: block });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, claimableToken: v.claimableToken - assets, withdrawnToken: v.withdrawnToken + assets });
});

indexer.onEvent({ contract: "MeridianVault", event: "EmergencyUnwind", fields: FIELDS }, async ({ event, context }) => {
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, emergencyUnwinds: v.emergencyUnwinds + 1 });
  await logAdmin(context, event, "EmergencyUnwind", event.params);
});

indexer.onEvent({ contract: "KuruHedger", event: "SpotBought", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  context.HedgeTrade.set({
    id: evId(event),
    hedger: event.srcAddress,
    vault: p.vault,
    isBuy: true,
    quoteToken: p.quoteInToken,
    baseWad: p.baseOut,
    avgPriceWad: p.avgPriceWad,
    block: blockOf(event),
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "KuruHedger", event: "SpotSold", fields: FIELDS }, async ({ event, context }) => {
  const p = event.params;
  context.HedgeTrade.set({
    id: evId(event),
    hedger: event.srcAddress,
    vault: p.vault,
    isBuy: false,
    quoteToken: p.quoteOutToken,
    baseWad: p.baseIn,
    avgPriceWad: p.avgPriceWad,
    block: blockOf(event),
    timestamp: tsOf(event),
    txHash: event.transaction.hash,
  });
});
