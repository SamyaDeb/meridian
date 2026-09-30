import type {
  EvmOnEventContext,
  Account,
  Market,
  ProtocolStats,
  AccountMarket,
  SwapStats,
  SwapPosition,
  Vault,
  VaultUser,
} from "envio";
import { DEPLOYMENTS, TEST_MARKETS } from "../deployments.gen.js";
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
    perpVolumeQuoteWad: 0n,
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
  });
}

/** Read-modify-write the per-chain ProtocolStats singleton (tvl recomputed from its parts). */
export async function updateProtocol(context: Ctx, patch: (p: ProtocolStats) => Partial<ProtocolStats>): Promise<void> {
  const p = await getProtocol(context);
  const next = { ...p, ...patch(p) };
  context.ProtocolStats.set({
    ...next,
    tvlToken: next.perpCollateralToken + next.swapCollateralToken + next.vaultNavToken,
  });
}

/** Get or create an Account; a new non-protocol account counts as a user. */
export async function touchAccount(context: Ctx, address: string, block: bigint, ts: bigint): Promise<Account> {
  const existing = await context.Account.get(address);
  if (existing) return existing;
  const acc: Account = { id: address, firstSeenBlock: block, firstSeenTimestamp: ts, tradeCount: 0, volumeQuoteWad: 0n };
  context.Account.set(acc);
  // The vault trades as a normal account (INTERFACES §2.4) but is not a user.
  if (!(await context.Vault.get(address))) await updateProtocol(context, (p) => ({ users: p.users + 1 }));
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
  });
}

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
