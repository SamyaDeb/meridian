import type {
  EvmOnEventContext,
  Account,
  Market,
  ProtocolStats,
  AccountMarket,
  ProtocolDaily,
  SwapStats,
  SwapPosition,
  Vault,
  VaultUser,
} from "envio";
import { DEPLOYMENTS, MM_ACCOUNTS, OPERATOR_ACCOUNTS, TEST_MARKETS } from "../deployments.gen.js";
import { DEFAULT_BLOCK_TIME_MS } from "./math.js";

export type Ctx = EvmOnEventContext;
export type BookKind = "Perp" | "Swap";

/** Block/tx fields every handler reads. */
export const FIELDS = { block: ["timestamp"], transaction: ["hash"] } as const;

type Ev = { readonly block: { readonly number: number; readonly timestamp: number }; readonly logIndex: number };

export const evId = (e: Ev): string => `${e.block.number}-${e.logIndex}`;
export const blockOf = (e: Ev): bigint => BigInt(e.block.number);
export const tsOf = (e: Ev): bigint => BigInt(e.block.timestamp);
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const PROTOCOL_ID = "protocol";
export const DEFAULT_SYMBOL = "MON-PERP"; // single launch market (PRD); replaced by MarketRegistered.symbol

/** Json columns can't hold bigint: stringify bigints (and nested structs) for storage. */
export function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

export async function getProtocol(context: Ctx): Promise<ProtocolStats> {
  return context.ProtocolStats.getOrCreate({
    id: PROTOCOL_ID,
    users: 0,
    externalUsers: 0,
    perpVolumeQuoteWad: 0n,
    perpVolumeMmQuoteWad: 0n,
    swapVolumeWad: 0n,
    feesWad: 0n,
    tvlToken: 0n,
    perpCollateralToken: 0n,
    swapCollateralToken: 0n,
    vaultNavToken: 0n,
    trades: 0,
    liquidations: 0,
    fundingTicks: 0,
    keeperReports: 0,
    keeperReportFailures: 0,
    perpOpenInterestLongWad: 0n,
    perpOpenInterestShortWad: 0n,
    swapOpenInterestWad: 0n,
    updatedBlock: 0n,
  });
}

export const DAY = 86_400n;
export const dayStart = (ts: bigint): bigint => ts - (ts % DAY);

async function getDaily(context: Ctx, day: bigint, p: ProtocolStats): Promise<ProtocolDaily> {
  return context.ProtocolDaily.getOrCreate({
    id: String(day),
    day,
    perpVolumeQuoteWad: 0n,
    perpVolumeMmQuoteWad: 0n,
    swapVolumeWad: 0n,
    feesWad: 0n,
    trades: 0,
    liquidations: 0,
    fundingTicks: 0,
    newUsers: 0,
    newExternalUsers: 0,
    activeExternalUsers: 0,
    tvlTokenClose: p.tvlToken,
    perpCollateralTokenClose: p.perpCollateralToken,
    vaultNavTokenClose: p.vaultNavToken,
    perpOpenInterestLongWadClose: p.perpOpenInterestLongWad,
    perpOpenInterestShortWadClose: p.perpOpenInterestShortWad,
    swapOpenInterestWadClose: p.swapOpenInterestWad,
    updatedBlock: 0n,
  });
}

/** Pure: the day's row after the cumulative stats moved from `prev` to `next` (flows add the change, closes = next). */
export function rollDaily(d: ProtocolDaily, prev: ProtocolStats, next: ProtocolStats, block: bigint): ProtocolDaily {
  return {
    ...d,
    perpVolumeQuoteWad: d.perpVolumeQuoteWad + next.perpVolumeQuoteWad - prev.perpVolumeQuoteWad,
    perpVolumeMmQuoteWad: d.perpVolumeMmQuoteWad + next.perpVolumeMmQuoteWad - prev.perpVolumeMmQuoteWad,
    swapVolumeWad: d.swapVolumeWad + next.swapVolumeWad - prev.swapVolumeWad,
    feesWad: d.feesWad + next.feesWad - prev.feesWad,
    trades: d.trades + next.trades - prev.trades,
    liquidations: d.liquidations + next.liquidations - prev.liquidations,
    fundingTicks: d.fundingTicks + next.fundingTicks - prev.fundingTicks,
    newUsers: d.newUsers + next.users - prev.users,
    newExternalUsers: d.newExternalUsers + next.externalUsers - prev.externalUsers,
    tvlTokenClose: next.tvlToken,
    perpCollateralTokenClose: next.perpCollateralToken,
    vaultNavTokenClose: next.vaultNavToken,
    perpOpenInterestLongWadClose: next.perpOpenInterestLongWad,
    perpOpenInterestShortWadClose: next.perpOpenInterestShortWad,
    swapOpenInterestWadClose: next.swapOpenInterestWad,
    updatedBlock: block > d.updatedBlock ? block : d.updatedBlock,
  };
}

/** Where a stat change comes from: its block (shown next to the numbers) and whether it's a labelled test market. */
export type StatOpts = { readonly block?: bigint; readonly testMarket?: boolean };
/** A stat change also lands in that UTC day's ProtocolDaily row, so it needs the event's block and timestamp. */
export type StatAt = StatOpts & { readonly block: bigint; readonly ts: bigint };

/**
 * Read-modify-write the per-chain ProtocolStats singleton (tvl recomputed from its parts) and roll the change into
 * the day's ProtocolDaily row (K2.1). Test-market events never reach the product stats (they stay on their Market).
 */
export async function updateProtocol(context: Ctx, patch: (p: ProtocolStats) => Partial<ProtocolStats>, opts: StatAt): Promise<void> {
  if (opts.testMarket) return;
  const p = await getProtocol(context);
  const merged = { ...p, ...patch(p) };
  const next: ProtocolStats = {
    ...merged,
    tvlToken: merged.perpCollateralToken + merged.swapCollateralToken + merged.vaultNavToken,
    updatedBlock: opts.block > p.updatedBlock ? opts.block : p.updatedBlock,
  };
  context.ProtocolStats.set(next);
  const d = await getDaily(context, dayStart(opts.ts), p);
  context.ProtocolDaily.set(rollDaily(d, p, next, opts.block));
}

/** Count `address` once per UTC day in ProtocolDaily.activeExternalUsers (AccountDay marker, one row per day). */
async function markActive(context: Ctx, address: string, block: bigint, ts: bigint): Promise<void> {
  const day = dayStart(ts);
  const id = `${day}-${address}`;
  if (await context.AccountDay.get(id)) return;
  context.AccountDay.set({ id });
  const d = await getDaily(context, day, await getProtocol(context));
  context.ProtocolDaily.set({ ...d, activeExternalUsers: d.activeExternalUsers + 1, updatedBlock: block > d.updatedBlock ? block : d.updatedBlock });
}

const lc = (a: string) => a.toLowerCase();
export const isOperator = (chainId: number, address: string): boolean => (OPERATOR_ACCOUNTS[chainId] ?? []).includes(lc(address));
export const mmAccounts = (chainId: number): readonly string[] => MM_ACCOUNTS[chainId] ?? [];

/** Pure: the part of a trade's notional that our MM took part in (maker or taker; counted once). */
export function mmShareOf(maker: string, taker: string, notional: bigint, mm: readonly string[]): bigint {
  return mm.includes(lc(maker)) || mm.includes(lc(taker)) ? notional : 0n;
}

/** Is this clearing house a labelled test market (entity label first, deployments list otherwise)? */
export async function isTestClearingHouse(context: Ctx, clearingHouse: string): Promise<boolean> {
  const m = await context.Market.get(clearingHouse);
  return m?.testMarket ?? isTestMarket(context.chain.id, clearingHouse);
}

/**
 * Get or create an Account; a new non-vault account counts as a user. Its first activity on a product market (not a
 * test market) by an account that isn't ours (OPERATOR_ACCOUNTS) also counts it once as an external user.
 */
export async function touchAccount(context: Ctx, address: string, block: bigint, ts: bigint, opts: StatOpts = {}): Promise<Account> {
  const existing = await context.Account.get(address);
  let acc: Account = existing ?? {
    id: address,
    firstSeenBlock: block,
    firstSeenTimestamp: ts,
    tradeCount: 0,
    volumeQuoteWad: 0n,
    countedExternal: false,
  };
  // The vault trades as a normal account (INTERFACES §2.4) but is not a user.
  const isVault = Boolean(await context.Vault.get(address));
  if (!existing && !isVault) await updateProtocol(context, (p) => ({ users: p.users + 1 }), { block, ts });
  const external = !opts.testMarket && !isVault && !isOperator(context.chain.id, address);
  if (!acc.countedExternal && external) {
    acc = { ...acc, countedExternal: true };
    await updateProtocol(context, (p) => ({ externalUsers: p.externalUsers + 1 }), { block, ts });
  }
  if (external) await markActive(context, address, block, ts);
  if (!existing || acc !== existing) context.Account.set(acc);
  return acc;
}

/** A labelled test market: listed in deployments (demoMarket) or registered with a "-DEMO" symbol. */
export function isTestMarket(chainId: number, clearingHouse: string, symbol?: string): boolean {
  if (symbol?.toUpperCase().endsWith("-DEMO")) return true;
  return (TEST_MARKETS[chainId] ?? []).includes(clearingHouse.toLowerCase());
}

export async function getMarket(context: Ctx, clearingHouse: string): Promise<Market> {
  return context.Market.getOrCreate({
    id: clearingHouse,
    marketId: undefined,
    symbol: DEFAULT_SYMBOL,
    testMarket: isTestMarket(context.chain.id, clearingHouse),
    clearingHouse,
    orderBook: DEPLOYMENTS[context.chain.id]?.OrderBook,
    oracle: undefined,
    active: true,
    paused: false,
    lastFundingBlock: 0n,
    lastRate: 0n,
    lastRateAprWad: 0n,
    lastPremium: 0n,
    lastEmaPremium: 0n,
    lastCumFunding: 0n,
    lastCumIndexTime: 0n,
    lastIndexPrice: 0n,
    lastMarkPrice: 0n,
    fundingTickCount: 0,
    realizedApr1hWad: undefined,
    realizedApr8hWad: undefined,
    realizedApr24hWad: undefined,
    realizedApr7dWad: undefined,
    lastTradePrice: 0n,
    volumeBaseWad: 0n,
    volumeQuoteWad: 0n,
    tradeCount: 0,
    feesWad: 0n,
    feesCollectedToken: 0n,
    openInterestLongWad: 0n,
    openInterestShortWad: 0n,
    blockTimeMs: DEFAULT_BLOCK_TIME_MS,
    riskParams: undefined,
    fundingParams: undefined,
  });
}

export async function getAccountMarket(context: Ctx, market: string, account: string, block: bigint): Promise<AccountMarket> {
  return context.AccountMarket.getOrCreate({
    id: `${market}-${account}`,
    account_id: account,
    market_id: market,
    collateralWad: 0n,
    size: 0n,
    openNotional: 0n,
    entryPrice: 0n,
    lastCumFunding: 0n,
    fundingPaid: 0n,
    realizedPnl: 0n,
    feesPaid: 0n,
    reservedOrderMargin: 0n,
    depositedToken: 0n,
    withdrawnToken: 0n,
    liquidationCount: 0,
    lastTradeBlock: undefined,
    updatedBlock: block,
  });
}

export async function getSwapStats(context: Ctx, swapMarket: string): Promise<SwapStats> {
  return context.SwapStats.getOrCreate({
    id: swapMarket,
    markAprWad: 0n,
    lastTradeBlock: 0n,
    realizedApr8hWad: undefined,
    openInterestWad: 0n,
    volumeWad: 0n,
    tradeCount: 0,
    feesWad: 0n,
    matured: false,
    cumFundingAtMaturity: undefined,
    cumIndexTimeAtMaturity: undefined,
    maturityBlock: undefined,
    params: undefined,
  });
}

export async function getSwapPosition(context: Ctx, swapMarket: string, account: string, block: bigint): Promise<SwapPosition> {
  return context.SwapPosition.getOrCreate({
    id: `${swapMarket}-${account}`,
    swapMarket,
    account_id: account,
    size: 0n,
    fixedAprNotional: 0n,
    avgFixedAprWad: undefined,
    lockedSpread: false,
    collateralWad: 0n,
    floatingReceived: 0n,
    fixedPaid: 0n,
    netAccrued: 0n,
    realizedPnl: 0n,
    feesPaid: 0n,
    liquidationCount: 0,
    updatedBlock: block,
  });
}

export async function getVault(context: Ctx, vault: string): Promise<Vault> {
  return context.Vault.getOrCreate({
    id: vault,
    navToken: 0n,
    totalShares: 0n,
    sharePriceWad: 0n,
    fundingAccruedWad: 0n,
    hedged: false,
    lastRebalanceReason: "None",
    lastRebalanceBlock: 0n,
    depositedToken: 0n,
    withdrawnToken: 0n,
    userCount: 0,
    apy24hWad: undefined,
    apy7dWad: undefined,
    params: undefined,
    keepers: [],
    pendingRedeemShares: 0n,
    claimableToken: 0n,
    emergencyUnwinds: 0,
  });
}

/** InsuranceFund entity (id = fund address). */
export const getInsuranceFund = (context: Ctx, id: string) =>
  context.InsuranceFund.getOrCreate({ id, fundedToken: 0n, coveredToken: 0n, penaltyToken: 0n, balanceToken: 0n, authorizedMarkets: [] });

/** The chain's InsuranceFund address (deployments), for flows emitted by the markets rather than the fund. */
export const insuranceFundAddress = (context: Ctx): string | undefined => DEPLOYMENTS[context.chain.id]?.InsuranceFund;

export async function getVaultUser(context: Ctx, vault: string, user: string, block: bigint): Promise<VaultUser> {
  const id = `${vault}-${user}`;
  const existing = await context.VaultUser.get(id);
  if (existing) return existing;
  const v = await getVault(context, vault);
  context.Vault.set({ ...v, userCount: v.userCount + 1 });
  return { id, vault, user, shares: 0n, depositedToken: 0n, withdrawnToken: 0n, updatedBlock: block };
}

/** The perp market (ClearingHouse) a book trades for, or the swap market for the swap book. */
export async function resolveBookMarket(context: Ctx, book: string, kind: BookKind): Promise<string> {
  const ref = await context.BookRef.get(book);
  if (ref) return ref.market;
  const d = DEPLOYMENTS[context.chain.id];
  const m = kind === "Perp" ? d?.ClearingHouse : d?.FundingSwapMarket;
  return m ?? book;
}

/** The perp market whose funding underlies the swaps (single launch market). */
export const underlyingPerpMarket = (context: Ctx): string | undefined => DEPLOYMENTS[context.chain.id]?.ClearingHouse;

export async function logAdmin(
  context: Ctx,
  e: Ev & { readonly srcAddress: string; readonly transaction: { readonly hash: string } },
  name: string,
  data: unknown,
): Promise<void> {
  context.AdminEvent.set({
    id: evId(e),
    contract: e.srcAddress,
    name,
    data: toJson(data),
    block: blockOf(e),
    timestamp: tsOf(e),
    txHash: e.transaction.hash,
  });
}
