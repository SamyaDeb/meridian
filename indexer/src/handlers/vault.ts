// IPulseVault (ERC-4626 over AUSD) + IKuruHedger events.
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

indexer.onEvent({ contract: "PulseVault", event: "Deposit", fields: FIELDS }, async ({ event, context }) => {
  const { owner, assets } = event.params;
  const block = blockOf(event);
  await touchAccount(context, owner, block, tsOf(event));
  const u = await getVaultUser(context, event.srcAddress, owner, block);
  context.VaultUser.set({ ...u, depositedToken: u.depositedToken + assets, updatedBlock: block });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, depositedToken: v.depositedToken + assets });
});

indexer.onEvent({ contract: "PulseVault", event: "Withdraw", fields: FIELDS }, async ({ event, context }) => {
  const { owner, assets } = event.params;
  const block = blockOf(event);
  const u = await getVaultUser(context, event.srcAddress, owner, block);
  context.VaultUser.set({ ...u, withdrawnToken: u.withdrawnToken + assets, updatedBlock: block });
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, withdrawnToken: v.withdrawnToken + assets });
});

// Share balances come from Transfer only (Deposit/Withdraw also emit mint/burn Transfers).
indexer.onEvent({ contract: "PulseVault", event: "Transfer", fields: FIELDS }, async ({ event, context }) => {
  const { from, to, value } = event.params;
  const block = blockOf(event);
  if (from !== ZERO_ADDRESS) {
    const u = await getVaultUser(context, event.srcAddress, from, block);
    context.VaultUser.set({ ...u, shares: u.shares - value, updatedBlock: block });
  }
  if (to !== ZERO_ADDRESS) {
    const u = await getVaultUser(context, event.srcAddress, to, block);
    context.VaultUser.set({ ...u, shares: u.shares + value, updatedBlock: block });
  }
});

indexer.onEvent({ contract: "PulseVault", event: "NavSnapshot", fields: FIELDS }, async ({ event, context }) => {
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
  await updateProtocol(context, () => ({ vaultNavToken: p.nav }));
});

indexer.onEvent({ contract: "PulseVault", event: "Rebalanced", fields: FIELDS }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "PulseVault", event: "HedgeEntered", fields: FIELDS }, async ({ event, context }) => {
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, hedged: true });
  await logAdmin(context, event, "HedgeEntered", event.params);
});

indexer.onEvent({ contract: "PulseVault", event: "HedgeExited", fields: FIELDS }, async ({ event, context }) => {
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, hedged: false });
  await logAdmin(context, event, "HedgeExited", event.params);
});

indexer.onEvent({ contract: "PulseVault", event: "VaultParamsUpdated", fields: FIELDS }, async ({ event, context }) => {
  const v = await getVault(context, event.srcAddress);
  context.Vault.set({ ...v, params: toJson(event.params.params) });
  await logAdmin(context, event, "VaultParamsUpdated", event.params.params);
});

indexer.onEvent({ contract: "PulseVault", event: "KeeperUpdated", fields: FIELDS }, async ({ event, context }) => {
  const { keeper, allowed } = event.params;
  const v = await getVault(context, event.srcAddress);
  const rest = v.keepers.filter((k) => k !== keeper);
  context.Vault.set({ ...v, keepers: allowed ? [...rest, keeper] : rest });
  await logAdmin(context, event, "KeeperUpdated", event.params);
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
