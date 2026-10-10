// Perpl API types: the subset Meridian uses. Source: github.com/PerplFoundation/api-docs @ 25ab6e2 (types.md, websocket.md,
// rest-endpoints.md). Ported from meridian-k3/mm-bot/src/perpl/types.ts (perpl-hedge @ fe873b0) and mfi/src/perpl/types.ts
// (main @ 0ba1664, + K3 116e26d fees / order_ttl_blocks). Field names and codes come only from the docs.

/** websocket.md "Message Types" (trading subset). */
export const MT = {
  ping: 1,
  pong: 2,
  status: 3,
  walletSnapshot: 19,
  walletUpdate: 20,
  account: 21,
  order: 22,
  ordersSnapshot: 23,
  orders: 24,
  fills: 25,
  positionsSnapshot: 26,
  positions: 27,
  accountStats: 28,
  signIn: 29,
  heartbeat: 100,
} as const;

/** types.md "OrderType". */
export const OrderType = { OpenLong: 1, OpenShort: 2, CloseLong: 3, CloseShort: 4, Cancel: 5, IncreasePositionCollateral: 6, Change: 7 } as const;
export type OrderTypeT = (typeof OrderType)[keyof typeof OrderType];

/** types.md "OrderFlags". */
export const OrderFlags = { GoodTillCancel: 0, PostOnly: 1, FillOrKill: 2, ImmediateOrCancel: 4 } as const;

/** types.md "OrderStatus". */
export const OrderStatus = { Unspecified: 0, Pending: 1, Open: 2, PartiallyFilled: 3, Filled: 4, Canceled: 5, Expired: 6, Failed: 7, Untriggered: 8, Triggered: 9, Executed: 10 } as const;

/** types.md "OrderStatusReason": the values code reacts to by name (errors.ts has the full table). */
export const OrderStatusReason = {
  AmountExceedsAvailableBalance: 1,
  ExceedsLastExecutionBlock: 14,
  ImmediateOrCancelExecuted: 16,
  ImmediateOrderUnderMinimum: 17,
  OrderDescIdTooLow: 32,
  OrderForwardingNotAllowed: 34,
  OrderPostFailed: 36,
  TakerOrderFilled: 43,
  TakerOrderSettlementFailed: 44,
} as const;

/** types.md "PositionType" / "PositionStatus" (trading API: 1 Long, 2 Short; the onchain views use 0/1, see route/liq). */
export const PositionSide = { Long: 1, Short: 2 } as const;
export const PositionStatus = { Open: 1 } as const;

/** types.md "ScopeMask": 1 read, 2 trade (implies read). */
export const ScopeMask = { Read: 1, Trade: 2, All: 3 } as const;

export type BlockTs = { b?: number; t?: number; tx?: number; txid?: string; l?: number };

/** types.md "OrderSpec": the same body over WS (under an mt: 22 header) and REST (POST /v1/trading/orders `d[]`). */
export type OrderSpec = {
  rq: number;
  mkt: number;
  acc: number;
  oid?: number;
  t: OrderTypeT;
  p?: number;
  s: number;
  ms?: number;
  mnp?: number;
  tif?: number;
  fl: number;
  lp?: number;
  lv: number;
  lb: number;
};

/** types.md "Account" (trading WS mt: 21, wallet snapshot `as[]`). Amounts are decimal strings in collateral units. */
export type Account = { in: number; id: number; fr: boolean; fw: boolean; ft: number; lfr: number; b: string; lb: string };

/** types.md "Order" (subset). */
export type Order = {
  at?: BlockTs;
  rq: number;
  mkt: number;
  acc: number;
  oid: number;
  st: number;
  sr: number;
  fr?: number;
  t: number;
  r?: boolean;
  p?: number;
  os: number;
  fp: number;
  fs: number;
  f: string;
  fl: number;
  lv: number;
};

/** types.md "Fill". */
export type Fill = { at?: BlockTs; mkt: number; acc: number; oid: number; t: number; l: number; p?: number; s: number; f: string };

/** types.md "Position" (subset). */
export type Position = { at?: BlockTs; mkt: number; acc: number; pid: number; st: number; sd: number; s: number; ep: number; c: string };

/** websocket.md "Command Status (mt: 3)". */
export type StatusFrame = { mt: 3; sid?: number; sn?: number; cid?: number; status: { code: number; error?: string } };

/** REST "BatchStatusResponse" (POST /v1/trading/orders). */
export type BatchStatus = { mt?: number; cid?: number; status: { code: number; error?: string }; statuses?: { code: number; error?: string }[] };

// ── public market data (REST + market-data WS) ──

/** Block/timestamp; `t` in ms. */
export type BlockTimestamp = { b?: number; t?: number };

/** types.md "BlockTxLogTimestamp" (the fields this code reads; tx index / log index omitted). */
export type BlockTxLogTimestamp = BlockTimestamp & { txid?: string };

/** types.md "TradeSide" / websocket.md "Trade Messages": 1 = buy (taker bought), 2 = sell. */
export type TradeSide = 1 | 2;

/** One public trade (websocket.md mt 17 snapshot / mt 18 update `d[]`, types.md "Trade"): price and size scaled. */
export type PerplTrade = { at: BlockTxLogTimestamp; p: number; s: number; sd: TradeSide };
export type TradeSeries = { mt: 17 | 18; sid?: number; d: PerplTrade[] };

/** types.md "FundingEvent". `rate` in micros (10^-6) of notional per funding interval; positive ⇒ longs pay (MFI.md §2). */
export type FundingEvent = { at: BlockTimestamp; feb: number; rate: number; idx: number; ppl: number; sum: number; div: number };

/** types.md "MarketState" (prices scaled by price_decimals, sizes by size_decimals). */
export type MarketState = { at: BlockTimestamp; orl: number; mrk: number; lst: number; mid: number; bid: number; ask: number; oi: number };

/** types.md "MarketConfig" fees: micros (1000 = 0.1 % = 10 bps), per-tier arrays indexed by Account.ft. */
export type PerplFees = { makerMicros: number; takerMicros: number; makerTiers?: number[]; takerTiers?: number[] };

/** types.md "MarketConfig" (subset). */
export type MarketConfig = { is_open: boolean; price_decimals: number; size_decimals: number; fees?: PerplFees };

/** types.md "Market" (subset). */
export type Market = {
  id: number;
  symbol: string;
  name: string;
  funding_interval_sec: number;
  funding_interval_blocks: number;
  /** lb ceiling: head < lb <= head + order_ttl_blocks (websocket.md "Last execution block"); absent in old recordings */
  order_ttl_blocks?: number;
  config: MarketConfig;
};

/** GET /v1/pub/context (subset). */
export type Context = { chain: { chain_id: number }; markets: Market[] };

/** GET /v1/market-data/:id/ticker and /v1/market-data/ticker: keyed by market id. */
export type MarketStateUpdate = { mt: number; sn: number; d: Record<string, MarketState> };

/** GET /v1/market-data/:id/funding/:from-:to */
export type FundingSeries = { mt: number; at: BlockTimestamp; m: number; d: FundingEvent[] };

/** types.md "L2PriceLevel": price and size scaled; `o` = order count (on an update, o: 0 removes the level). */
export type L2Level = { p: number; s: number; o: number };

/** types.md "L2Book": mt 15 snapshot / 16 update; each side ordered away from the spread (best first). */
export type L2Book = { mt: 15 | 16; sn?: number; sid?: number; at: BlockTimestamp; bid: L2Level[]; ask: L2Level[] };
