// Closing the Earn pair, shared by the Earn screen and Close all (one plan, one order of sends): the hedged pair from the
// Earn record, capped by what both venues really hold (planEarnClose), and a Lock bought / sold back FIRST, in full
// (planSwapClose). The wallet's lock must be known before anything is planned: a pair closed while a lock is still open
// would leave the swap without its hedge.
import type { CloseExecPlan, OrderSide } from "@meridian/core/exec";
import { sizeText } from "../trade/ticket/quote";
import type { RunMeta, SwapCloseOrder } from "./executor";
import { EARN_LEVERAGE, planEarnClose, planSwapClose } from "./plan";
import type { EarnPosition } from "./record";
import type { EarnInputs } from "./useEarnQuote";

export type PairCloseInputs = Pick<EarnInputs, "accounts" | "meridian" | "perpl" | "swap" | "perplPriceDp" | "meridianPriceDp">;

/** The wallet's funding-swap position: `sizeWad` signed (+ bought), 0 when none; unknown until the swap reader has read it. */
export type LockState = { known: false } | { known: true; sizeWad: bigint };

/** `swapMarket`: the funding-swap market is deployed on this network (no market ⇒ no lock can exist). */
export function lockOf(inputs: Pick<EarnInputs, "swap">, swapMarket: boolean): LockState {
  if (!swapMarket) return { known: true, sizeWad: 0n };
  const a = inputs.swap?.account;
  return a ? { known: true, sizeWad: a.sizeWad } : { known: false };
}

/** The swap side an Earn pair opens its Lock on: a Meridian short sells the swap (receives fixed), a long buys it. */
export const lockSideOf = (perplSide: OrderSide): OrderSide => (perplSide === "buy" ? "sell" : "buy");

export const LOCK_UNKNOWN = "Reading your fixed-rate lock… Try again in a moment.";

export type EarnPairClose = { ok: true; plan: CloseExecPlan; sizeWad: bigint; swap: SwapCloseOrder | undefined; meta: RunMeta } | { ok: false; error: string };

/** What the Earn screen's Close sends (and Close all, for the Earn pair): plan + meta + the lock's close order, if any. */
export function planEarnPairClose(pos: Pick<EarnPosition, "perplSide" | "sizeWad">, inputs: PairCloseInputs, swapMarket: boolean): EarnPairClose {
  const lock = lockOf(inputs, swapMarket);
  if (!lock.known) return { ok: false, error: LOCK_UNKNOWN };
  const a = inputs.accounts;
  const pp = a.perpl?.position;
  const plan = planEarnClose({
    perplSide: pos.perplSide,
    sizeWad: pos.sizeWad,
    meridianSizeWad: a.meridian?.sizeWad,
    perpl: pp ? { side: pp.side, sizeWad: pp.sizeWad } : undefined,
    meridian: inputs.meridian,
    perplBook: inputs.perpl,
  });
  if (!plan.ok) return plan;
  let swap: SwapCloseOrder | undefined;
  if (lock.sizeWad !== 0n) {
    const sw = inputs.swap!;
    const sc = planSwapClose({ sizeWad: lock.sizeWad, bids: sw.bookKnown ? sw.bids : undefined, asks: sw.bookKnown ? sw.asks : undefined, tickSizeWad: sw.tickSizeWad, lotSizeWad: sw.lotSizeWad });
    if (!sc.ok) return sc;
    swap = sc.order;
  }
  const meta: RunMeta = { summary: `Close ${sizeText(plan.sizeWad, inputs.perpl.stepWad ?? 1n)} MON on both venues`, perplPriceDp: inputs.perplPriceDp, meridianPriceDp: inputs.meridianPriceDp, leverage100: Number(EARN_LEVERAGE) * 100 };
  return { ok: true, plan: plan.plan, sizeWad: plan.sizeWad, swap, meta };
}
