// Perpl trading API types: the subset the hedge uses. Source: github.com/PerplFoundation/api-docs (7 Oct 2026),
// types.md ("Order", "OrderSpec", "Fill", "Position", "Account", "Wallet") and websocket.md ("Message Types",
// "Trading WebSocket"). Field names and codes come only from there; anything else is marked > VERIFY.

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

/** types.md "OrderStatusReason": the values the hedge reacts to by name (the rest are logged as numbers). */
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

/** types.md "PositionType" / "PositionStatus". */
export const PositionSide = { Long: 1, Short: 2 } as const;
export const PositionStatus = { Open: 1 } as const;

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
