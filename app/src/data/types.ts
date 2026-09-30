// App-side mirror of the indexer schema (ws-06-indexer: indexer/SCHEMA.md, indexer/schema.graphql).
// Shapes match the GraphQL entities field-for-field, with BigInt columns parsed to bigint.
// Keep in sync: WS-06 announces schema changes in its PR description.

export type Address = `0x${string}`;
export type BookKind = "Perp" | "Swap";
export type OrderStatus = "Open" | "PartiallyFilled" | "Filled" | "Cancelled" | "Evicted";
export type RebalanceReason = "None" | "Deploy" | "DeltaDrift" | "MarginLow" | "ExitHedge" | "EnterHedge" | "Withdraw" | "SkewCap";

export interface Market {
  id: Address; // ClearingHouse
  chainId: number;
  marketId?: string;
  symbol: string;
  /** Labelled TEST market (indexer `Market.testMarket` / deployments `demoMarket`): always shown with a badge. */
  testMarket?: boolean;
  clearingHouse: Address;
  orderBook?: Address;
  oracle?: Address;
  active: boolean;
  paused: boolean;
  lastFundingBlock: bigint;
  lastRate: bigint;
  lastRateAprWad: bigint;
  lastPremium: bigint;
  lastEmaPremium: bigint;
  lastCumFunding: bigint;
  lastCumIndexTime: bigint;
  lastIndexPrice: bigint;
  lastMarkPrice: bigint;
  fundingTickCount: number;
  realizedApr1hWad?: bigint;
  realizedApr8hWad?: bigint;
  realizedApr24hWad?: bigint;
  lastTradePrice: bigint;
  volumeBaseWad: bigint;
  volumeQuoteWad: bigint;
  tradeCount: number;
  feesWad: bigint;
  feesCollectedToken: bigint;
  openInterestLongWad: bigint;
  openInterestShortWad: bigint;
  blockTimeMs: bigint;
}

export interface FundingTick {
  id: string; // <market>-<block>
  market_id: Address;
  block: bigint;
  timestamp: bigint;
  rate: bigint;
  rateAprWad: bigint;
  premium: bigint;
  emaPremium: bigint;
  cumFunding: bigint;
  cumIndexTime: bigint;
  index: bigint;
  mark: bigint;
}

export interface Trade {
  id: string;
  kind: BookKind;
  book: Address;
  market_id?: Address;
  swapMarket?: Address;
  makerOrderId: bigint;
  maker: Address;
  taker: Address;
  takerIsBid: boolean;
  tick: bigint;
  lots: bigint;
  priceWad: bigint;
  sizeWad: bigint;
  notionalWad: bigint;
  aprWad?: bigint;
  block: bigint;
  timestamp: bigint;
  txHash: string;
}

export interface Candle {
  id: string;
  market: Address;
  bucketStart: bigint;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volumeBaseWad: bigint;
  volumeQuoteWad: bigint;
  trades: number;
}

export interface AccountMarket {
  id: string; // <market>-<account>
  account_id: Address;
  market_id: Address;
  collateralWad: bigint;
  size: bigint;
  openNotional: bigint;
  entryPrice: bigint;
  lastCumFunding: bigint;
  fundingPaid: bigint;
  realizedPnl: bigint;
  feesPaid: bigint;
  reservedOrderMargin: bigint;
  depositedToken: bigint;
  withdrawnToken: bigint;
  liquidationCount: number;
  updatedBlock: bigint;
}

export interface Vault {
  id: Address;
  navToken: bigint;
  totalShares: bigint;
  sharePriceWad: bigint;
  fundingAccruedWad: bigint;
  hedged: boolean;
  lastRebalanceReason: RebalanceReason;
  lastRebalanceBlock: bigint;
  depositedToken: bigint;
  withdrawnToken: bigint;
  userCount: number;
  apy24hWad?: bigint;
  apy7dWad?: bigint;
  /** chain source: APY from the share price over `apyWindowSec` (NavSnapshot → now), when the window is < 24 h */
  apyWad?: bigint;
  apyWindowSec?: number;
  /** chain source (contract views): what the Earn screen needs for status and the withdraw path */
  needsRebalance?: number;
  idleToken?: bigint;
  shortCapacityWad?: bigint;
  spotBaseWad?: bigint;
  perpSizeWad?: bigint;
  netDeltaWad?: bigint;
  marginRatioWad?: bigint;
}

export interface VaultSnapshot {
  id: string;
  vault_id: Address;
  navToken: bigint;
  totalShares: bigint;
  sharePriceWad: bigint;
  fundingAccruedWad: bigint;
  block: bigint;
  timestamp: bigint;
}

export interface VaultUser {
  id: string;
  vault: Address;
  user: Address;
  shares: bigint;
  depositedToken: bigint;
  withdrawnToken: bigint;
  updatedBlock: bigint;
}

export interface SwapStats {
  id: Address; // FundingSwapMarket
  markAprWad: bigint;
  lastTradeBlock: bigint;
  realizedApr8hWad?: bigint;
  openInterestWad: bigint;
  volumeWad: bigint;
  tradeCount: number;
  feesWad: bigint;
  matured: boolean;
  cumFundingAtMaturity?: bigint;
  cumIndexTimeAtMaturity?: bigint;
  maturityBlock?: bigint;
}

export interface SwapPosition {
  id: string;
  swapMarket: Address;
  account_id: Address;
  size: bigint; // q
  fixedAprNotional: bigint; // K
  avgFixedAprWad?: bigint;
  lockedSpread: boolean;
  collateralWad: bigint;
  floatingReceived: bigint;
  fixedPaid: bigint;
  netAccrued: bigint;
  realizedPnl: bigint;
  feesPaid: bigint;
  liquidationCount: number;
  updatedBlock: bigint;
}

export interface ProtocolStats {
  id: "protocol";
  users: number;
  perpVolumeQuoteWad: bigint;
  swapVolumeWad: bigint;
  feesWad: bigint;
  tvlToken: bigint;
  perpCollateralToken: bigint;
  swapCollateralToken: bigint;
  vaultNavToken: bigint;
  trades: number;
  liquidations: number;
  fundingTicks: number;
  keeperReports: number;
  keeperReportFailures: number;
}

/** Order-book depth level (from contract views, not the indexer). */
export interface DepthLevel {
  priceWad: bigint;
  sizeWad: bigint;
}

/** Swap market static info (contract views: maturity, timeToMaturity). */
export interface SwapMarketInfo {
  id: Address;
  maturityTimestamp: number; // unix seconds
  /** chain source: the swap OrderBook (orders go there) */
  orderBook?: Address;
}
