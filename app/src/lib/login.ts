// Login state machine (pure). Privy gives us ready/authenticated/wallet; the UI needs one label per situation.
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import type { WalletKind } from "./sponsor";

export type LoginInput = {
  /** NEXT_PUBLIC_PRIVY_APP_ID present */
  privyEnabled: boolean;
  /** Privy SDK finished initialising */
  ready: boolean;
  authenticated: boolean;
  /** embedded (or linked) wallet address wagmi sees */
  walletAddress: string | undefined;
  /** Privy's walletClientType for that address: "privy" ⇒ embedded (sponsorable), anything else ⇒ external. Unknown while
   *  Privy's wallet list loads. */
  walletKind?: WalletKind | undefined;
  /** last login/signature failure, if any */
  error: string | undefined;
};

export type LoginState =
  | { kind: "injected-only" }
  | { kind: "loading" }
  | { kind: "logged-out" }
  | { kind: "creating-wallet" }
  | { kind: "ready"; address: string; wallet: WalletKind | "unknown" }
  | { kind: "error"; message: string };

export function deriveLoginState(i: LoginInput): LoginState {
  if (!i.privyEnabled) return { kind: "injected-only" };
  if (!i.ready) return { kind: "loading" };
  if (i.error && !i.authenticated) return { kind: "error", message: i.error };
  if (!i.authenticated) return { kind: "logged-out" };
  if (!i.walletAddress) return { kind: "creating-wallet" };
  return { kind: "ready", address: i.walletAddress, wallet: i.walletKind ?? "unknown" };
}

/** Privy's walletClientType → our wallet kind ("privy" is the only embedded type in @privy-io/react-auth 3.47.0). */
export const walletKindOf = (walletClientType: string | undefined): WalletKind | undefined =>
  walletClientType === undefined ? undefined : walletClientType === "privy" ? "embedded" : "external";

/** Plain-language text for the contracts' custom errors (abi.ts declares them, so viem decodes the revert). */
export const REVERT_TEXT: Record<string, string> = {
  OracleStale: "Oracle price is stale: the market takes no new risk until the price feed updates. Try again shortly",
  Paused: "Market paused: try again later",
  SlippageExceeded: "Not filled inside your slippage: no fillable liquidity at that price",
  NoLiquidity: "No liquidity on that side of the book",
  InsufficientMargin: "Not enough margin for this",
  PostOnlyWouldCross: "Post-only would cross the book",
  ReduceOnlyViolated: "Reduce-only would increase the position",
  PositionCapExceeded: "Over the position size cap",
  OpenInterestCapExceeded: "Market open-interest cap reached",
  TooManyOpenOrders: "Too many open orders: cancel some first",
  OrderNotFound: "Order no longer on the book (filled or cancelled)",
  InvalidTick: "Invalid price",
  InvalidSize: "Invalid size",
  Matured: "This swap market has matured",
  ZeroAmount: "Enter an amount",
  NothingToDo: "Nothing to do",
  ERC4626ExceededMaxDeposit: "Over the vault's deposit limit",
  ERC4626ExceededMaxRedeem: "More than you can withdraw right now",
};

/** No MON for gas on a wallet that pays its own (external or passkey wallet; embedded Privy wallets are sponsored). */
export const NO_MON = "this wallet has no MON. Add testnet MON from a Monad faucet, then retry";
/** RPC / wallet wordings for "can't pay gas" (viem, MetaMask-style, Monad's RPC). */
const NO_GAS = /insufficient funds|signer had insufficient balance/i;
/** Longest error text shown: RPC errors can carry the whole request body (raw tx, URL with the RPC key). */
const MAX_ERROR = 160;
const clip = (s: string) => (s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR - 1)}…` : s);

/** User-visible message for a failed signature/login/transaction (rejection is normal, not an error to shout about). */
export function describeSignError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  // checked first: wallets report a gas shortfall as an internal error, which viem reads as a revert
  if (NO_GAS.test(text) || (e instanceof BaseError && e.walk((x) => x instanceof Error && NO_GAS.test(x.message)))) return "Not enough MON for gas: add MON to this wallet and retry";
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "Signature cancelled";
    // a revert: name the contract's reason (the first line alone only says "The contract function … reverted")
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName;
      if (name) return REVERT_TEXT[name] ?? `Reverted: ${name}`;
      if (rev.reason) return clip(`Reverted: ${rev.reason.split("\n")[0]}`);
    }
  }
  // whole words only: a reverted "cancelOrder" call is not a cancelled signature
  if (/\b(rejected|denied|cancell?ed)\b/i.test(text)) return "Signature cancelled";
  if ((e as { code?: string })?.code === "wrong-chain") return "Wrong network: switch to Monad and retry";
  if ((e as { code?: string })?.code === "deadline-expired") return "Permit expired: try again";
  return clip(text.split("\n")[0] ?? text);
}
