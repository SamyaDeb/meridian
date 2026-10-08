// Two-leg basis CLOSE = the open in reverse order (MOBILE_PLAN N6 "Close = reverse order"): Meridian reduce-only market
// order first (its fill is certain onchain), then Perpl reduce-only IOC for exactly what closed, so the pair never holds
// more one-sided exposure than the Perpl leg's shortfall. A Perpl shortfall retries once at 2× the slippage, then MANUAL.
//   CLOSE_MERIDIAN ─ q = 0 → ABORTED (nothing changed)
//                  └ q > 0 → CLOSE_PERPL(q) ─ filled → CLOSED (q = size) | CLOSED_PARTIAL (q < size, still hedged)
//                                            └ short / fail → CLOSE_PERPL_RETRY (2×) ─ filled → CLOSED* | short → MANUAL
import { ExecTransitionError, advanceLeg, floorTo, freshLeg, legAction, limitFrom, type LegAction, type LegEvent, type LegProgress, type LegSpec, type OrderSide } from "./leg";

export type ClosePhase = "CLOSE_MERIDIAN" | "CLOSE_PERPL" | "CLOSE_PERPL_RETRY" | "CLOSED" | "CLOSED_PARTIAL" | "ABORTED" | "MANUAL";
export const CLOSE_PHASES: readonly ClosePhase[] = ["CLOSE_MERIDIAN", "CLOSE_PERPL", "CLOSE_PERPL_RETRY", "CLOSED", "CLOSED_PARTIAL", "ABORTED", "MANUAL"];
export const CLOSE_TERMINAL: readonly ClosePhase[] = ["CLOSED", "CLOSED_PARTIAL", "ABORTED", "MANUAL"];

export type CloseExecPlan = {
  /** the CLOSING order sides (opposite of each open leg) */
  meridianSide: OrderSide;
  perplSide: OrderSide;
  sizeWad: bigint;
  meridianLimitPriceWad: bigint;
  /** Perpl reference (mark) and slippage for its limit; the retry doubles the slippage */
  perplRefPriceWad: bigint;
  perplSlippageBps: bigint;
  perplStepWad: bigint;
};

export type CloseExecState = {
  v: 1;
  kind: "close";
  id: string;
  phase: ClosePhase;
  plan: CloseExecPlan;
  leg: LegProgress;
  meridian?: { filledWad: bigint; avgPriceWad?: bigint };
  perpl: { targetWad: bigint; filledWad: bigint };
  errors: string[];
};

export type CloseAction = (LegAction & { phase: ClosePhase }) | { type: "none"; phase: ClosePhase };

export function startClose(id: string, plan: CloseExecPlan): CloseExecState {
  if (plan.sizeWad <= 0n) throw new RangeError("close size must be positive");
  if (plan.meridianSide === plan.perplSide) throw new RangeError("closing legs must be opposite sides");
  return { v: 1, kind: "close", id, phase: "CLOSE_MERIDIAN", plan, leg: freshLeg(), perpl: { targetWad: 0n, filledWad: 0n }, errors: [] };
}

function legSpec(s: CloseExecState): LegSpec | undefined {
  const p = s.plan;
  if (s.phase === "CLOSE_MERIDIAN") return { venue: "meridian", side: p.meridianSide, sizeWad: p.sizeWad, limitPriceWad: p.meridianLimitPriceWad, reduceOnly: true, key: `${s.id}:close-m` };
  if (s.phase === "CLOSE_PERPL" || s.phase === "CLOSE_PERPL_RETRY") {
    const slip = s.phase === "CLOSE_PERPL" ? p.perplSlippageBps : 2n * p.perplSlippageBps;
    return { venue: "perpl", side: p.perplSide, sizeWad: s.perpl.targetWad - s.perpl.filledWad, limitPriceWad: limitFrom(p.perplRefPriceWad, p.perplSide, slip), reduceOnly: true, key: `${s.id}:close-p${s.phase === "CLOSE_PERPL" ? 1 : 2}` };
  }
  return undefined;
}

export function nextCloseAction(s: CloseExecState): CloseAction {
  const spec = legSpec(s);
  return spec ? { ...legAction(spec, s.leg), phase: s.phase } : { type: "none", phase: s.phase };
}

export function reduceClose(s: CloseExecState, e: LegEvent): CloseExecState {
  if (CLOSE_TERMINAL.includes(s.phase)) throw new ExecTransitionError(`close ${s.id}: ${e.type} in ${s.phase}`);
  if (e.type === "PREPARED" || e.type === "SENT") return { ...s, leg: advanceLeg(s.leg, e) };
  const spec = legSpec(s)!;
  if (e.type === "FILLED" && (e.filledWad < 0n || e.filledWad > spec.sizeWad)) throw new ExecTransitionError(`close ${s.id}: filled ${e.filledWad} outside [0, ${spec.sizeWad}]`);
  const errors = e.type === "FAILED" ? [...s.errors, `${s.phase}: ${e.error}`] : s.errors;
  const got = e.type === "FILLED" ? e.filledWad : 0n;
  if (s.phase === "CLOSE_MERIDIAN") {
    if (got === 0n) return { ...s, errors, phase: "ABORTED", meridian: { filledWad: 0n } };
    const meridian = { filledWad: got, ...(e.type === "FILLED" && e.avgPriceWad !== undefined ? { avgPriceWad: e.avgPriceWad } : {}) };
    const target = floorTo(got, s.plan.perplStepWad);
    const done = got === s.plan.sizeWad ? "CLOSED" : "CLOSED_PARTIAL";
    return target === 0n ? { ...s, errors, meridian, phase: done, leg: freshLeg() } : { ...s, errors, meridian, perpl: { targetWad: target, filledWad: 0n }, phase: "CLOSE_PERPL", leg: freshLeg() };
  }
  const perpl = { ...s.perpl, filledWad: s.perpl.filledWad + got };
  if (perpl.filledWad >= perpl.targetWad) return { ...s, errors, perpl, phase: s.meridian!.filledWad === s.plan.sizeWad ? "CLOSED" : "CLOSED_PARTIAL", leg: freshLeg() };
  return { ...s, errors, perpl, phase: s.phase === "CLOSE_PERPL" ? "CLOSE_PERPL_RETRY" : "MANUAL", leg: freshLeg() };
}

export const isCloseTerminal = (s: CloseExecState): boolean => CLOSE_TERMINAL.includes(s.phase);
