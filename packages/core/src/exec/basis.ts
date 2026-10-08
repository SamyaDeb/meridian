// Two-leg basis OPEN, exactly per MOBILE_PLAN N6:
//   PLAN → ensure collateral on both venues → LEG1_PERPL_IOC
//     ├ q1 = 0 → ABORTED
//     └ q1 > 0 → LEG2_MERIDIAN(size = q1, floored to the Meridian lot)
//           ├ q2 = q1 → (Lock? → LEG3_SWAP) → DONE
//           ├ q2 < q1 → UNWIND_PERPL(q1 − q2, reduce-only IOC) → PARTIAL_DONE
//           └ fail    → UNWIND_PERPL(q1) → ABORTED_UNWOUND
//     UNWIND fail (or short fill) → UNWIND_RETRY with 2× wider limit → MANUAL (one-tap close, push + in-app alert)
//   Lock failure never unwinds the hedge: DONE_LOCK_FAILED ("Lock failed, hedge open, floating rate applies").
// q2 = 0 without an error is treated as a failure (nothing hedged ⇒ unwind all, ABORTED_UNWOUND).
// Pure: nextBasisAction / reduceBasis; the adapters live in driver.ts.
import { ExecTransitionError, advanceLeg, floorTo, freshLeg, legAction, limitFrom, opposite, type LegAction, type LegEvent, type LegProgress, type LegSpec, type OrderSide } from "./leg";

export type BasisPhase = "COLLATERAL" | "LEG1_PERPL_IOC" | "LEG2_MERIDIAN" | "LEG3_SWAP" | "UNWIND_PERPL" | "UNWIND_RETRY" | "DONE" | "DONE_LOCK_FAILED" | "PARTIAL_DONE" | "ABORTED" | "ABORTED_UNWOUND" | "MANUAL";
export const BASIS_PHASES: readonly BasisPhase[] = ["COLLATERAL", "LEG1_PERPL_IOC", "LEG2_MERIDIAN", "LEG3_SWAP", "UNWIND_PERPL", "UNWIND_RETRY", "DONE", "DONE_LOCK_FAILED", "PARTIAL_DONE", "ABORTED", "ABORTED_UNWOUND", "MANUAL"];
export const BASIS_TERMINAL: readonly BasisPhase[] = ["DONE", "DONE_LOCK_FAILED", "PARTIAL_DONE", "ABORTED", "ABORTED_UNWOUND", "MANUAL"];

export type BasisExecPlan = {
  /** Perpl leg side (the venue with higher funding is sold) and Meridian the opposite */
  perplSide: OrderSide;
  sizeWad: bigint;
  perplLimitPriceWad: bigint;
  meridianLimitPriceWad: bigint;
  meridianLotWad: bigint;
  perplStepWad: bigint;
  /** collateral to have on each venue before LEG1 (WAD); the adapter tops up / checks */
  perplCollateralWad: bigint;
  meridianCollateralWad: bigint;
  /** unwind limit = leg-1 average ± this; the retry doubles it */
  unwindSlippageBps: bigint;
  /** optional fixed-rate lock (route/lock.ts): swap side, size cap, worst price (1 + APR) */
  lock?: { side: OrderSide; maxSizeWad: bigint; limitPriceWad: bigint; lotWad: bigint };
};

export type UnwindReason = "partial" | "meridian-failed";

export type BasisExecState = {
  v: 1;
  kind: "basis";
  id: string;
  phase: BasisPhase;
  plan: BasisExecPlan;
  leg: LegProgress;
  q1?: { filledWad: bigint; avgPriceWad?: bigint };
  q2?: { filledWad: bigint; avgPriceWad?: bigint };
  lock?: { filledWad: bigint; avgPriceWad?: bigint } | { error: string };
  unwind?: { reason: UnwindReason; targetWad: bigint; filledWad: bigint; attempt: 1 | 2; refPriceWad: bigint };
  errors: string[];
};

export type BasisEvent = { type: "COLLATERAL_OK" } | { type: "COLLATERAL_FAILED"; error: string } | LegEvent;
export type BasisAction = { type: "ensure-collateral"; perplWad: bigint; meridianWad: bigint } | (LegAction & { phase: BasisPhase }) | { type: "none"; phase: BasisPhase };

export function startBasis(id: string, plan: BasisExecPlan): BasisExecState {
  if (plan.sizeWad <= 0n) throw new RangeError("basis size must be positive");
  if (plan.sizeWad % plan.meridianLotWad !== 0n || plan.sizeWad % plan.perplStepWad !== 0n) throw new RangeError("basis size must be on both venues' steps (route/basis planBasis)");
  return { v: 1, kind: "basis", id, phase: "COLLATERAL", plan, leg: freshLeg(), errors: [] };
}

export const meridianSide = (p: BasisExecPlan): OrderSide => opposite(p.perplSide);

/** Swap size: min(hedged size, lock cap) floored to the swap lot. */
const lockSize = (s: BasisExecState): bigint => {
  const l = s.plan.lock!;
  const q2 = s.q2!.filledWad;
  return floorTo(q2 < l.maxSizeWad ? q2 : l.maxSizeWad, l.lotWad);
};

function legSpec(s: BasisExecState): LegSpec | undefined {
  const p = s.plan;
  switch (s.phase) {
    case "LEG1_PERPL_IOC":
      return { venue: "perpl", side: p.perplSide, sizeWad: p.sizeWad, limitPriceWad: p.perplLimitPriceWad, reduceOnly: false, key: `${s.id}:leg1` };
    case "LEG2_MERIDIAN":
      return { venue: "meridian", side: meridianSide(p), sizeWad: floorTo(s.q1!.filledWad, p.meridianLotWad), limitPriceWad: p.meridianLimitPriceWad, reduceOnly: false, key: `${s.id}:leg2` };
    case "LEG3_SWAP":
      return { venue: "swap", side: p.lock!.side, sizeWad: lockSize(s), limitPriceWad: p.lock!.limitPriceWad, reduceOnly: false, key: `${s.id}:leg3` };
    case "UNWIND_PERPL":
    case "UNWIND_RETRY": {
      const u = s.unwind!;
      const side = opposite(p.perplSide);
      const slip = u.attempt === 1 ? p.unwindSlippageBps : 2n * p.unwindSlippageBps;
      return { venue: "perpl", side, sizeWad: u.targetWad - u.filledWad, limitPriceWad: limitFrom(u.refPriceWad, side, slip), reduceOnly: true, key: `${s.id}:unwind${u.attempt}` };
    }
    default:
      return undefined;
  }
}

export function nextBasisAction(s: BasisExecState): BasisAction {
  if (s.phase === "COLLATERAL") return { type: "ensure-collateral", perplWad: s.plan.perplCollateralWad, meridianWad: s.plan.meridianCollateralWad };
  const spec = legSpec(s);
  return spec ? { ...legAction(spec, s.leg), phase: s.phase } : { type: "none", phase: s.phase };
}

const fill = (e: { filledWad: bigint; avgPriceWad?: bigint }) => ({ filledWad: e.filledWad, ...(e.avgPriceWad !== undefined ? { avgPriceWad: e.avgPriceWad } : {}) });

function toUnwind(s: BasisExecState, reason: UnwindReason, targetWad: bigint): BasisExecState {
  const target = floorTo(targetWad, s.plan.perplStepWad);
  if (target === 0n) return { ...s, phase: reason === "partial" ? "PARTIAL_DONE" : "ABORTED_UNWOUND", leg: freshLeg() };
  // the unwind price reference is the leg-1 average (fallback: the leg-1 limit, the worst it could have been)
  const ref = s.q1?.avgPriceWad ?? s.plan.perplLimitPriceWad;
  return { ...s, phase: "UNWIND_PERPL", leg: freshLeg(), unwind: { reason, targetWad: target, filledWad: 0n, attempt: 1, refPriceWad: ref } };
}

const unwoundPhase = (r: UnwindReason): BasisPhase => (r === "partial" ? "PARTIAL_DONE" : "ABORTED_UNWOUND");

export function reduceBasis(s: BasisExecState, e: BasisEvent): BasisExecState {
  const bad = () => new ExecTransitionError(`basis ${s.id}: ${e.type} in ${s.phase}`);
  if (BASIS_TERMINAL.includes(s.phase)) throw bad();
  if (s.phase === "COLLATERAL") {
    if (e.type === "COLLATERAL_OK") return { ...s, phase: "LEG1_PERPL_IOC", leg: freshLeg() };
    if (e.type === "COLLATERAL_FAILED") return { ...s, phase: "ABORTED", errors: [...s.errors, e.error] };
    throw bad();
  }
  if (e.type === "COLLATERAL_OK" || e.type === "COLLATERAL_FAILED") throw bad();
  if (e.type === "PREPARED" || e.type === "SENT") return { ...s, leg: advanceLeg(s.leg, e) };
  const spec = legSpec(s)!;
  if (e.type === "FILLED" && (e.filledWad < 0n || e.filledWad > spec.sizeWad)) throw new ExecTransitionError(`basis ${s.id}: ${s.phase} filled ${e.filledWad} outside [0, ${spec.sizeWad}]`);
  const errors = e.type === "FAILED" ? [...s.errors, `${s.phase}: ${e.error}`] : s.errors;
  switch (s.phase) {
    case "LEG1_PERPL_IOC": {
      const q1 = e.type === "FILLED" ? e.filledWad : 0n;
      if (q1 === 0n) return { ...s, phase: "ABORTED", errors, q1: { filledWad: 0n } };
      const next = { ...s, errors, q1: fill(e as { filledWad: bigint; avgPriceWad?: bigint }), leg: freshLeg() };
      // LEG2 size = q1 on the Meridian lot; a q1 below one lot can't be hedged ⇒ unwind all of it
      return floorTo(q1, s.plan.meridianLotWad) === 0n ? toUnwind({ ...next, errors: [...errors, "leg-1 fill below one Meridian lot"] }, "meridian-failed", q1) : { ...next, phase: "LEG2_MERIDIAN" };
    }
    case "LEG2_MERIDIAN": {
      const q1 = s.q1!.filledWad;
      if (e.type === "FAILED" || e.filledWad === 0n) return toUnwind({ ...s, errors, q2: { filledWad: 0n } }, "meridian-failed", q1);
      const q2 = fill(e);
      const st = { ...s, errors, q2 };
      if (q2.filledWad < q1) return toUnwind(st, "partial", q1 - q2.filledWad);
      if (!s.plan.lock) return { ...st, phase: "DONE", leg: freshLeg() };
      if (lockSize(st) === 0n) return { ...st, phase: "DONE_LOCK_FAILED", lock: { error: "hedge below one swap lot" }, leg: freshLeg() };
      return { ...st, phase: "LEG3_SWAP", leg: freshLeg() };
    }
    case "LEG3_SWAP":
      // never unwinds the hedge
      if (e.type === "FAILED" || e.filledWad === 0n) return { ...s, errors, phase: "DONE_LOCK_FAILED", lock: { error: e.type === "FAILED" ? e.error : "nothing filled" }, leg: freshLeg() };
      return { ...s, phase: "DONE", lock: fill(e), leg: freshLeg() };
    case "UNWIND_PERPL":
    case "UNWIND_RETRY": {
      const u = s.unwind!;
      const filled = u.filledWad + (e.type === "FILLED" ? e.filledWad : 0n);
      const nu = { ...u, filledWad: filled };
      if (filled >= u.targetWad) return { ...s, errors, unwind: nu, phase: unwoundPhase(u.reason), leg: freshLeg() };
      if (s.phase === "UNWIND_PERPL") return { ...s, errors, unwind: { ...nu, attempt: 2 }, phase: "UNWIND_RETRY", leg: freshLeg() };
      return { ...s, errors, unwind: nu, phase: "MANUAL", leg: freshLeg() };
    }
    default:
      throw bad();
  }
}

export const isBasisTerminal = (s: BasisExecState): boolean => BASIS_TERMINAL.includes(s.phase);

/** Net MON exposure after the run (Perpl signed + Meridian signed); 0 on DONE / ABORTED / ABORTED_UNWOUND / PARTIAL_DONE. */
export function basisExposureWad(s: BasisExecState): bigint {
  const sg = (side: OrderSide) => (side === "buy" ? 1n : -1n);
  const perpl = sg(s.plan.perplSide) * ((s.q1?.filledWad ?? 0n) - (s.unwind?.filledWad ?? 0n));
  const meridian = sg(meridianSide(s.plan)) * (s.q2?.filledWad ?? 0n);
  return perpl + meridian;
}
