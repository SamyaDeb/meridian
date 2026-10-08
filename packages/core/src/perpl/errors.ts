// Perpl errors: typed failures (mfi/src/perpl/errors.ts, main @ 0ba1664) and the documented status tables → plain English.
// Tables: api-docs @ 25ab6e2 types.md "OrderStatus", "OrderStatusReason", "OrderFailureReason"; README "HTTP Status
// Codes", "WebSocket Close Codes"; authentication.md "Signature validity and errors". Wording is ours; codes are theirs.

/** Perpl could not be read: callers exclude the venue instead of guessing. */
export class PerplUnavailableError extends Error {
  constructor(
    readonly kind: "timeout" | "network" | "http" | "rate-limited" | "not-ready" | "unknown-market",
    message: string,
    readonly status?: number,
    /** server's Retry-After, if any */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PerplUnavailableError";
  }
}

/** Perpl answered, but the payload does not match the documented schema. */
export class PerplSchemaError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "PerplSchemaError";
  }
}

/** A signed REST call answered non-2xx (after the 429/503 retries). `status` drives the onboarding detector. */
export class PerplHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly target: string,
    readonly body: string,
  ) {
    super(`perpl ${method} ${target}: HTTP ${status} ${body.slice(0, 200)}`);
    this.name = "PerplHttpError";
  }
}

/** types.md "OrderStatus". */
export const ORDER_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "Unspecified",
  1: "Pending",
  2: "Open",
  3: "PartiallyFilled",
  4: "Filled",
  5: "Canceled",
  6: "Expired",
  7: "Failed",
  8: "Untriggered",
  9: "Triggered",
  10: "Executed",
};

/** types.md "OrderStatusReason" (all 70 values). */
export const ORDER_STATUS_REASON_NAMES: Readonly<Record<number, string>> = {
  0: "Unspecified",
  1: "AmountExceedsAvailableBalance",
  2: "AccountFrozen",
  3: "CancelExistingInvalidCloseOrders",
  4: "CantChangeCloseOrder",
  5: "ChangeExpiredOrderNeedsNewExpiry",
  6: "ClearingExpiredOrder",
  7: "ClearingFrozenAccountOrder",
  8: "ClearingInvalidCloseOrder",
  9: "ClearingSelfMatchingOrder",
  10: "CloseOrderExceedsPosition",
  11: "CloseOrderPositionMismatch",
  12: "ContractNotOperational",
  13: "CrossesBook",
  14: "ExceedsLastExecutionBlock",
  15: "ForwardingReverted",
  16: "ImmediateOrCancelExecuted",
  17: "ImmediateOrderUnderMinimum",
  18: "InsuficientFundsForRecycleFee",
  19: "InvalidAccountFrozenOrder",
  20: "InvalidExpiryBlock",
  21: "InvalidOrderId",
  22: "MakerOrderFilled",
  23: "MakerOrderSettlementFailed",
  24: "MaximumAccountOrders",
  25: "MaxMatchesReached",
  26: "NoOp",
  27: "OrderBookFull",
  28: "OrderCancelled",
  29: "OrderCancelledByAdmin",
  30: "OrderCancelledByLiquidator",
  31: "OrderChanged",
  32: "OrderDescIdTooLow",
  33: "OrderDoesNotExist",
  34: "OrderForwardingNotAllowed",
  35: "OrderPlaced",
  36: "OrderPostFailed",
  37: "OrderSettlementImpliesInsolvent",
  38: "OrderSizeExceedsAvailableSize",
  39: "PostOrderUnderMinimum",
  40: "PriceOutOfRange",
  41: "RecycleBalanceInsufficientSevere",
  42: "SizeOutOfRange",
  43: "TakerOrderFilled",
  44: "TakerOrderSettlementFailed",
  45: "UnableToCancelOrder",
  46: "UnmatchedLotRemainsInFillOrKill",
  47: "UnspecifiedCollateral",
  48: "UnspecifiedPrice",
  49: "UnspecifiedSize",
  50: "WrongAccountForOrder",
  51: "WrongChainForOrder",
  52: "WrongMarketForOrder",
  53: "PerpetualInsolvent",
  54: "Triggered",
  55: "InvalidAmount",
  56: "InvalidFlags",
  57: "InvalidTriggerOrder",
  58: "WrongTriggerPosition",
  59: "TriggerDescIdTooLow",
  60: "TriggerOrderRequest",
  61: "ValueExceedsMaximum",
  62: "ClearingRemainingOrderLockBeyondBalance",
  63: "PriceSetDuringTriggerExec",
  64: "TriggeredExecutionAttemptsExhausted",
  65: "TriggeredOrderExecuted",
  66: "TriggeredOrderPartiallyFilled",
  67: "TriggeredOrderExpired",
  68: "TriggeredOrderRecoverableFailure",
  69: "OrderExtensionRejected",
};

/** Plain-English text for the reasons a mobile user can actually hit; the rest fall back to a generic line + the name. */
const REASON_TEXT: Readonly<Record<number, string>> = {
  1: "Not enough free AUSD in your Perpl account for this order.",
  2: "Your Perpl account is frozen.",
  10: "The close is larger than your open position.",
  12: "Perpl is not accepting orders right now.",
  13: "The order would cross the book.",
  14: "The order expired before it could execute. Try again.",
  15: "Perpl could not submit the order onchain. Try again.",
  16: "Filled what was available; the rest was cancelled.",
  17: "The order is below Perpl's minimum size.",
  18: "Not enough AUSD for Perpl's recycle fee.",
  24: "Too many open orders on Perpl.",
  25: "The order matched too many resting orders at once. Try a smaller size.",
  27: "Perpl's order book is full at this price.",
  32: "Order id out of sequence. Retry.",
  34: "One-click trading isn't enabled on Perpl yet. Enable it in onboarding.",
  36: "Perpl refused to post the order.",
  37: "This fill would make the market insolvent; Perpl refused it.",
  38: "The order is larger than the size available.",
  39: "The order is below Perpl's minimum size.",
  40: "The price is outside Perpl's allowed range.",
  42: "The size is outside Perpl's allowed range.",
  43: "Filled.",
  44: "The fill could not settle on Perpl.",
  46: "Fill-or-kill: not enough liquidity to fill the whole order.",
  51: "The order was for the wrong network.",
  52: "The order was for the wrong market.",
  53: "The Perpl market is insolvent.",
  61: "The amount is above Perpl's maximum.",
};

/** types.md "OrderFailureReason" (`fr`, present when sr is 23, 36 or 44): why the exchange refused it. */
const FAILURE_TEXT: Readonly<Record<number, string>> = {
  0: "",
  1: "Your Perpl balance is below the collateral and fee this position needs.",
  2: "Not enough free collateral to increase the position.",
  3: "Not enough free collateral to flip the position.",
  4: "There is no position to close.",
  5: "Settling at this price would leave the market insolvent.",
  6: "Closing would realise a negative position value.",
  7: "Perpl had no fresh reference price. Try again in a moment.",
  8: "The price moved too far from the mark for this order's loss limit.",
  9: "Perpl refused the order for an unpublished reason.",
};

export const reasonName = (sr: number): string => ORDER_STATUS_REASON_NAMES[sr] ?? `Unknown(${sr})`;
export const statusName = (st: number): string => ORDER_STATUS_NAMES[st] ?? `Unknown(${st})`;

/** One line for the receipt / toast: failure reason (fr) wins when present, else the status reason (sr). */
export function explainOrder(o: { st: number; sr: number; fr?: number }): string {
  const fr = o.fr !== undefined ? FAILURE_TEXT[o.fr] : undefined;
  if (fr) return fr;
  const t = REASON_TEXT[o.sr];
  if (t) return t;
  if (o.st === 7) return `Perpl rejected the order (${reasonName(o.sr)}).`;
  return `${statusName(o.st)} (${reasonName(o.sr)}).`;
}

/** README "HTTP Status Codes" + authentication.md, per the endpoint family. */
export function explainHttp(status: number): string {
  switch (status) {
    case 400:
      return "Perpl rejected the request as invalid.";
    case 401:
      return "Perpl didn't accept the API-key signature (clock off, key revoked or not enrolled).";
    case 403:
      return "The Perpl API key can't trade (read-only scope).";
    case 404:
      return "No Perpl exchange account for this wallet yet.";
    case 409:
      return "This Perpl API key is already registered.";
    case 423:
      return "This wallet has the maximum number of Perpl API keys (16).";
    case 429:
      return "Perpl is rate-limiting requests. Wait a moment and retry.";
    case 503:
      return "Perpl is catching up with the chain. Retry shortly.";
    default:
      return status >= 500 ? "Perpl had a server error. Retry shortly." : `Perpl answered HTTP ${status}.`;
  }
}

/** README "WebSocket Close Codes". */
export function explainClose(code: number, reason = ""): string {
  if (code === 1008 && /too many requests/i.test(reason)) return "Too many Perpl requests; reconnecting.";
  if (code === 1008 && /too many connections/i.test(reason)) return "Too many Perpl connections for this wallet (4 max); close other sessions.";
  if (code === 1008) return "Perpl closed an idle connection; reconnecting.";
  if (code === 1011) return "Perpl couldn't process a request.";
  if (code === 1013) return "The app fell behind Perpl's stream; reconnecting after a pause.";
  if (code === 1001) return "Perpl is restarting; reconnecting.";
  if (code === 3401) return "Perpl sign-in failed; re-signing.";
  return "Lost the Perpl connection; reconnecting.";
}
