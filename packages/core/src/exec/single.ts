// Single-leg trade (Trade screen): QUOTE → SEND → CONFIRM → DONE | FAILED. Pure: `nextSingleAction` says what to do,
// `reduceSingle` folds the adapter's answer in. SEND covers prepare + send (leg.ts), CONFIRM waits for the outcome.
import type { Venue } from "../route/router";
import { ExecTransitionError, advanceLeg, freshLeg, legAction, type LegAction, type LegEvent, type LegProgress, type LegSpec, type OrderSide } from "./leg";

export type SinglePhase = "QUOTE" | "SEND" | "CONFIRM" | "DONE" | "FAILED";
export const SINGLE_PHASES: readonly SinglePhase[] = ["QUOTE", "SEND", "CONFIRM", "DONE", "FAILED"];

export type SingleState = {
  v: 1;
  kind: "single";
  id: string;
  phase: SinglePhase;
  order: { venue: Venue; side: OrderSide; sizeWad: bigint; reduceOnly: boolean };
  limitPriceWad?: bigint;
  expectedAvgWad?: bigint;
  leg: LegProgress;
  result?: { filledWad: bigint; avgPriceWad?: bigint };
  error?: string;
};

export type SingleEvent = { type: "QUOTED"; limitPriceWad: bigint; expectedAvgWad?: bigint } | { type: "QUOTE_FAILED"; error: string } | LegEvent;
export type SingleAction = { type: "quote"; order: SingleState["order"] } | LegAction | { type: "none" };

export function startSingle(id: string, order: SingleState["order"]): SingleState {
  if (order.sizeWad <= 0n) throw new RangeError("size must be positive");
  return { v: 1, kind: "single", id, phase: "QUOTE", order, leg: freshLeg() };
}

const spec = (s: SingleState): LegSpec => ({ venue: s.order.venue, side: s.order.side, sizeWad: s.order.sizeWad, limitPriceWad: s.limitPriceWad!, reduceOnly: s.order.reduceOnly, key: `${s.id}:leg` });

export function nextSingleAction(s: SingleState): SingleAction {
  switch (s.phase) {
    case "QUOTE":
      return { type: "quote", order: s.order };
    case "SEND":
    case "CONFIRM":
      return legAction(spec(s), s.leg);
    default:
      return { type: "none" };
  }
}

export function reduceSingle(s: SingleState, e: SingleEvent): SingleState {
  const bad = () => new ExecTransitionError(`single ${s.id}: ${e.type} in ${s.phase}`);
  switch (s.phase) {
    case "QUOTE":
      if (e.type === "QUOTED") return { ...s, phase: "SEND", limitPriceWad: e.limitPriceWad, ...(e.expectedAvgWad !== undefined ? { expectedAvgWad: e.expectedAvgWad } : {}) };
      if (e.type === "QUOTE_FAILED") return { ...s, phase: "FAILED", error: e.error };
      throw bad();
    case "SEND":
    case "CONFIRM":
      if (e.type === "PREPARED") return { ...s, phase: "SEND", leg: advanceLeg(s.leg, e) };
      if (e.type === "SENT") return { ...s, phase: "CONFIRM", leg: advanceLeg(s.leg, e) };
      if (e.type === "FILLED") {
        if (e.filledWad < 0n || e.filledWad > s.order.sizeWad) throw new ExecTransitionError(`single ${s.id}: filled ${e.filledWad} outside [0, ${s.order.sizeWad}]`);
        const result = { filledWad: e.filledWad, ...(e.avgPriceWad !== undefined ? { avgPriceWad: e.avgPriceWad } : {}) };
        return e.filledWad === 0n ? { ...s, phase: "FAILED", result, error: "nothing filled" } : { ...s, phase: "DONE", result };
      }
      if (e.type === "FAILED") return { ...s, phase: "FAILED", error: e.error };
      throw bad();
    default:
      throw bad();
  }
}

export const isSingleTerminal = (s: SingleState): boolean => s.phase === "DONE" || s.phase === "FAILED";
