// One order leg, resume-safe (shared by every exec machine). A leg goes prepare → send → confirm:
//   prepare: the adapter fixes the order's identity WITHOUT sending it and returns `ref` — Perpl: the rq it will use
//            (re-sending the same rq is Perpl's retry mechanism, at-most-once, rest-endpoints.md "Request IDs");
//            Meridian / swap: the signed tx's hash (re-broadcasting the same signed tx is idempotent by nonce).
//   send:    (re)send `ref` — safe to repeat after an app kill;
//   confirm: read the definitive outcome of `ref` (Perpl mt 24 / order-history; Meridian receipt) → FILLED or FAILED.
// The state is persisted after every event, so a kill between any two steps resumes at the same next action.
import { BPS, divCeil, divFloor } from "../util/fixed";
import type { Venue } from "../route/router";

export type OrderSide = "buy" | "sell";

export type LegSpec = {
  venue: Venue | "swap";
  side: OrderSide;
  sizeWad: bigint;
  /** worst acceptable price (WAD; swap: 1 + APR). The adapter converts with the venue's rounding (buy ↑, sell ↓). */
  limitPriceWad: bigint;
  reduceOnly: boolean;
  /** stable per (machine id, leg) so a resumed prepare finds the same order */
  key: string;
};

export type LegProgress = { ref?: string; sent: boolean };
export const freshLeg = (): LegProgress => ({ sent: false });

export type LegAction = { type: "prepare"; leg: LegSpec } | { type: "send"; leg: LegSpec; ref: string } | { type: "confirm"; leg: LegSpec; ref: string };

export function legAction(leg: LegSpec, p: LegProgress): LegAction {
  if (p.ref === undefined) return { type: "prepare", leg };
  if (!p.sent) return { type: "send", leg, ref: p.ref };
  return { type: "confirm", leg, ref: p.ref };
}

/** Leg events. FAILED = definitively nothing filled (revert, IOC rejected, refused before sending). */
export type LegEvent = { type: "PREPARED"; ref: string } | { type: "SENT" } | { type: "FILLED"; filledWad: bigint; avgPriceWad?: bigint } | { type: "FAILED"; error: string };

export class ExecTransitionError extends Error {
  override name = "ExecTransitionError";
}

/** Applies PREPARED / SENT to the progress; FILLED / FAILED are handled by the machine. */
export function advanceLeg(p: LegProgress, e: LegEvent): LegProgress {
  if (e.type === "PREPARED") {
    if (p.ref !== undefined && p.ref !== e.ref) throw new ExecTransitionError(`leg already prepared as ${p.ref}`);
    return { ref: e.ref, sent: false };
  }
  if (e.type === "SENT") {
    if (p.ref === undefined) throw new ExecTransitionError("SENT before PREPARED");
    return { ...p, sent: true };
  }
  return p;
}

/** Worst price for an unwind / retry from a reference: buy ref·(1 + s) ↑, sell ref·(1 − s) ↓ (never better than asked). */
export const limitFrom = (refWad: bigint, side: OrderSide, slippageBps: bigint): bigint => (side === "buy" ? divCeil(refWad * (BPS + slippageBps), BPS) : divFloor(refWad * (BPS - slippageBps), BPS));

export const opposite = (s: OrderSide): OrderSide => (s === "buy" ? "sell" : "buy");
export const floorTo = (x: bigint, step: bigint): bigint => (step <= 0n ? x : (x / step) * step);
