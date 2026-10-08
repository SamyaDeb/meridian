// The app reads data through this interface. Mock now (Days 1–4); indexer GraphQL + contract views from CP1.
import type {
  Address,
  AccountMarket,
  AccountSummary,
  RiskParamsView,
  Candle,
  DepthLevel,
  FundingTick,
  Market,
  ProtocolStats,
  SwapMarketInfo,
  SwapPosition,
  SwapStats,
  Trade,
  Vault,
  VaultRedeemLive,
  VaultSnapshot,
  VaultUser,
} from "./types";

export interface MeridianDataSource {
  readonly kind: "mock" | "indexer" | "chain";
  market(): Promise<Market>;
  fundingTicks(limit: number): Promise<FundingTick[]>;
  candles1m(limit: number): Promise<Candle[]>;
  trades(limit: number): Promise<Trade[]>;
  depth(levels: number): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }>;
  positions(account: Address): Promise<AccountMarket[]>;
  /** Live account view (getAccount); undefined when the account has never touched the market. */
  accountView(account: Address): Promise<AccountSummary | undefined>;
  riskParams(): Promise<RiskParamsView>;
  vault(): Promise<Vault>;
  vaultSnapshots(limit: number): Promise<VaultSnapshot[]>;
  vaultUser(account: Address): Promise<VaultUser | undefined>;
  /** Earn queue (CR-014): live getRedeemRequest of `knownIds` (indexer) + my ids in the log window, maxRedeem, slice cap. */
  vaultRedeems(account: Address, knownIds: readonly bigint[]): Promise<VaultRedeemLive>;
  swapStats(): Promise<SwapStats>;
  swapInfo(): Promise<SwapMarketInfo>;
  swapPositions(account: Address): Promise<SwapPosition[]>;
  protocolStats(): Promise<ProtocolStats>;
}
