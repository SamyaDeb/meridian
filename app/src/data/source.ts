// The app reads data through this interface. Mock now (Days 1–4); indexer GraphQL + contract views from CP1.
import type {
  Address,
  AccountMarket,
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
  VaultSnapshot,
  VaultUser,
} from "./types";

export interface PulseDataSource {
  readonly kind: "mock" | "indexer";
  market(): Promise<Market>;
  fundingTicks(limit: number): Promise<FundingTick[]>;
  candles1m(limit: number): Promise<Candle[]>;
  trades(limit: number): Promise<Trade[]>;
  depth(levels: number): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }>;
  positions(account: Address): Promise<AccountMarket[]>;
  vault(): Promise<Vault>;
  vaultSnapshots(limit: number): Promise<VaultSnapshot[]>;
  vaultUser(account: Address): Promise<VaultUser | undefined>;
  swapStats(): Promise<SwapStats>;
  swapInfo(): Promise<SwapMarketInfo>;
  swapPositions(account: Address): Promise<SwapPosition[]>;
  protocolStats(): Promise<ProtocolStats>;
}
