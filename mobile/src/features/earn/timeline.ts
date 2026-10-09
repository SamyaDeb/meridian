// The Earn receipt timeline (MOBILE_PLAN N6 UI): every leg of a run — sent → filled / partly filled / failed / unwound —
// with its Perpl order id or Meridian tx link, and the outcome in plain words. Pure: built from the persisted run (core
// state + per-leg notes), so the same timeline renders live, after a resume, and from a MANUAL alert after a relaunch.
import { isBasisTerminal, isCloseTerminal, meridianSide, opposite, type BasisExecState, type BasisPhase, type ClosePhase, type CloseExecState, type OrderSide } from "@meridian/core/exec";
import type { Hex } from "viem";
import { WAD } from "@meridian/core/util";
import { formatValue } from "../../ui/format";
import { plainTradeError } from "../trade/exec/errors";
import { priceText, sizeText } from "../trade/ticket/quote";
import type { EarnRecord, LegNote } from "./record";

export type StepStatus = "waiting" | "active" | "filled" | "partial" | "failed" | "skipped";

export type TimelineStep = {
  key: string;
  title: string;
  detail: string;
  status: StepStatus;
  orderId?: number;
  txHash?: Hex;
  txUrl?: string;
};

export type Outcome = "running" | "success" | "partial" | "flat" | "action";

export type EarnTimeline = {
  kind: "open" | "close";
  phase: BasisPhase | ClosePhase;
  outcome: Outcome;
  headline: string;
  body: string;
  steps: TimelineStep[];
  /** one-sided MON left that needs the one-tap close (MANUAL) */
  leftover?: { venue: "perpl"; side: OrderSide; sizeWad: bigint };
};

/** the newest error without core's "PHASE: " prefix, in plain words */
const lastReason = (errors: readonly string[]) => plainTradeError(errors.at(-1)?.replace(/^[A-Z0-9_]+: /, ""));

const venueName = (v: "perpl" | "meridian") => (v === "perpl" ? "Perpl" : "Meridian");
const sideWord = (s: OrderSide, reduce: boolean) => (reduce ? (s === "buy" ? "Buy back" : "Sell") : s === "buy" ? "Long" : "Short");

function stepOf(o: { key: string; venue: "perpl" | "meridian"; side: OrderSide; reduce: boolean; sizeWad: bigint; stepWad: bigint; priceDp: number; note: LegNote | undefined; active: boolean; ended: boolean; explorerBase: string | undefined; title?: string }): TimelineStep {
  const n = o.note;
  const size = `${sizeText(o.sizeWad, o.stepWad)} MON`;
  const title = o.title ?? `${sideWord(o.side, o.reduce)} ${size} on ${venueName(o.venue)}`;
  let status: StepStatus = o.active ? "active" : o.ended ? "skipped" : "waiting";
  let detail = o.active ? (n?.ref ? "Sent, waiting for the fill…" : "Sending…") : "Not sent";
  if (n?.error !== undefined) {
    status = "failed";
    detail = plainTradeError(n.error);
  } else if (n?.filledWad !== undefined) {
    status = n.filledWad === 0n ? "failed" : n.filledWad < o.sizeWad ? "partial" : "filled";
    detail = n.filledWad === 0n ? "Nothing filled" : `Filled ${sizeText(n.filledWad, o.stepWad)} MON${n.avgPriceWad !== undefined ? ` at ${priceText(n.avgPriceWad, o.priceDp)}` : ""}`;
  }
  const txHash = o.venue === "meridian" && n?.ref?.startsWith("0x") ? (n.ref as Hex) : undefined;
  return {
    key: o.key,
    title,
    detail,
    status,
    ...(n?.orderId !== undefined ? { orderId: n.orderId } : {}),
    ...(txHash ? { txHash, ...(o.explorerBase ? { txUrl: `${o.explorerBase.replace(/\/+$/, "")}/tx/${txHash}` } : {}) } : {}),
  };
}

function basisTimeline(s: BasisExecState, r: EarnRecord, explorerBase: string | undefined): EarnTimeline {
  const p = s.plan;
  const ended = isBasisTerminal(s);
  const leg = (k: string) => r.meta.legs[`${s.id}:${k}`];
  const steps: TimelineStep[] = [];
  const pStep = p.perplStepWad;
  const mStep = p.meridianLotWad;
  const collOk = s.phase !== "COLLATERAL" && !(s.phase === "ABORTED" && s.q1 === undefined);
  steps.push({ key: "collateral", title: "Collateral on both venues", detail: s.phase === "COLLATERAL" ? "Checking, adding AUSD where a venue is short…" : collOk ? "Ready" : lastReason(s.errors), status: s.phase === "COLLATERAL" ? "active" : collOk ? "filled" : "failed" });
  steps.push(stepOf({ key: "leg1", venue: "perpl", side: p.perplSide, reduce: false, sizeWad: p.sizeWad, stepWad: pStep, priceDp: r.meta.perplPriceDp, note: leg("leg1"), active: s.phase === "LEG1_PERPL_IOC", ended, explorerBase }));
  const q1 = s.q1?.filledWad;
  if (q1 !== undefined && q1 > 0n) {
    const size = (q1 / mStep) * mStep;
    if (size > 0n) steps.push(stepOf({ key: "leg2", venue: "meridian", side: meridianSide(p), reduce: false, sizeWad: size, stepWad: mStep, priceDp: r.meta.meridianPriceDp, note: leg("leg2"), active: s.phase === "LEG2_MERIDIAN", ended, explorerBase }));
  } else if (s.phase !== "COLLATERAL" && s.phase !== "LEG1_PERPL_IOC") {
    steps.push({ key: "leg2", title: `${sideWord(meridianSide(p), false)} on Meridian`, detail: "Not sent: nothing to hedge", status: "skipped" });
  } else {
    steps.push({ key: "leg2", title: `${sideWord(meridianSide(p), false)} ${sizeText(p.sizeWad, mStep)} MON on Meridian`, detail: "Waits for the Perpl fill", status: "waiting" });
  }
  if (p.lock && s.q2 && s.q2.filledWad > 0n) {
    // Lock: a swap on Meridian's funding (price = 1 + fixed APR); the hedge never depends on it
    const n = leg("leg3");
    const size = (s.q2.filledWad < p.lock.maxSizeWad ? s.q2.filledWad : p.lock.maxSizeWad) / p.lock.lotWad * p.lock.lotWad;
    const st = stepOf({ key: "leg3", venue: "meridian", side: p.lock.side, reduce: false, sizeWad: size, stepWad: p.lock.lotWad, priceDp: 4, note: n, active: s.phase === "LEG3_SWAP", ended, explorerBase, title: `Lock: ${p.lock.side === "sell" ? "receive" : "pay"} a fixed rate on ${sizeText(size, p.lock.lotWad)} MON` });
    steps.push(n?.avgPriceWad !== undefined && n.error === undefined ? { ...st, detail: `Filled at ${formatValue(n.avgPriceWad - WAD, "apr")} fixed` } : s.phase === "DONE_LOCK_FAILED" && !n ? { ...st, status: "failed", detail: s.lock && "error" in s.lock ? s.lock.error : "Not sent" } : st);
  }
  if (s.unwind) {
    const u = s.unwind;
    for (const attempt of [1, 2] as const) {
      const note = leg(`unwind${attempt}`);
      const active = (attempt === 1 && s.phase === "UNWIND_PERPL") || (attempt === 2 && s.phase === "UNWIND_RETRY");
      if (!note && !active) continue;
      steps.push(stepOf({ key: `unwind${attempt}`, venue: "perpl", side: opposite(p.perplSide), reduce: true, sizeWad: u.targetWad, stepWad: pStep, priceDp: r.meta.perplPriceDp, note, active, ended, explorerBase, title: `${attempt === 1 ? "Undo" : "Retry undo (wider price)"}: ${sideWord(opposite(p.perplSide), true).toLowerCase()} ${sizeText(u.targetWad, pStep)} MON on Perpl` }));
    }
  }
  const hedged = s.q2?.filledWad ?? 0n;
  const pairs = `${sideWord(p.perplSide, false)} on Perpl · ${sideWord(meridianSide(p), false)} on Meridian`;
  const leftover = s.unwind ? s.unwind.targetWad - s.unwind.filledWad : 0n;
  switch (s.phase) {
    case "DONE":
      return { kind: "open", phase: s.phase, outcome: "success", headline: "You're earning the gap", body: `Both legs filled: ${sizeText(hedged, mStep)} MON each side (${pairs}). Your MON price exposure is zero.${s.lock && "filledWad" in s.lock && s.lock.avgPriceWad !== undefined ? ` Meridian's funding is fixed at ${formatValue(s.lock.avgPriceWad - WAD, "apr")} on ${sizeText(s.lock.filledWad, p.lock!.lotWad)} MON until the swap matures.` : ""}`, steps };
    case "DONE_LOCK_FAILED":
      return { kind: "open", phase: s.phase, outcome: "success", headline: "Hedge open, lock failed", body: "Lock failed, hedge open, floating rate applies.", steps };
    case "PARTIAL_DONE":
      return { kind: "open", phase: s.phase, outcome: "partial", headline: "Partly filled, fully hedged", body: `${sizeText(hedged, mStep)} MON is hedged and earning. Meridian filled less than Perpl, so the extra ${sizeText(s.unwind?.filledWad ?? 0n, pStep)} MON on Perpl was closed again.`, steps };
    case "ABORTED":
      return { kind: "open", phase: s.phase, outcome: "flat", headline: "Nothing was opened", body: q1 === 0n && leg("leg1")?.ref !== undefined ? `Perpl didn't fill at your price, so the Meridian leg wasn't sent. Nothing changed on your account.` : lastReason(s.errors), steps };
    case "ABORTED_UNWOUND":
      return { kind: "open", phase: s.phase, outcome: "flat", headline: "Undone automatically", body: "Meridian didn't fill, so the Perpl leg was closed again. You're flat on both venues; only the trading fees were paid.", steps };
    case "MANUAL":
      return { kind: "open", phase: s.phase, outcome: "action", headline: "Action needed", body: `${sizeText(leftover, pStep)} MON on Perpl couldn't be closed automatically (tried twice, the second time at a wider price). Close it now with one tap.`, steps, leftover: { venue: "perpl", side: p.perplSide, sizeWad: leftover } };
    default:
      return { kind: "open", phase: s.phase, outcome: "running", headline: "Opening your position…", body: pairs, steps };
  }
}

function closeTimeline(s: CloseExecState, r: EarnRecord, explorerBase: string | undefined): EarnTimeline {
  const p = s.plan;
  const ended = isCloseTerminal(s);
  const leg = (k: string) => r.meta.legs[`${s.id}:${k}`];
  const step = p.perplStepWad;
  const sc = r.meta.swapClose;
  const steps: TimelineStep[] = [];
  if (sc) {
    const n = leg("swap-close");
    const st = stepOf({ key: "swap-close", venue: "meridian", side: sc.leg.side, reduce: true, sizeWad: sc.leg.sizeWad, stepWad: 1n, priceDp: 4, note: n, active: s.phase === "CLOSE_MERIDIAN" && sc.filledWad === undefined && sc.error === undefined, ended, explorerBase, title: "First: close the fixed-rate lock" });
    steps.push(sc.error !== undefined && !n?.error ? { ...st, status: "failed", detail: sc.error } : n?.avgPriceWad !== undefined ? { ...st, detail: `Closed at ${formatValue(n.avgPriceWad - WAD, "apr")}` } : st);
  }
  steps.push(stepOf({ key: "close-m", venue: "meridian", side: p.meridianSide, reduce: true, sizeWad: p.sizeWad, stepWad: step, priceDp: r.meta.meridianPriceDp, note: leg("close-m"), active: s.phase === "CLOSE_MERIDIAN" && (!sc || sc.filledWad !== undefined), ended, explorerBase }));
  for (const [k, ph] of [["close-p1", "CLOSE_PERPL"], ["close-p2", "CLOSE_PERPL_RETRY"]] as const) {
    const note = leg(k);
    const active = s.phase === ph;
    if (!note && !active) continue;
    steps.push(stepOf({ key: k, venue: "perpl", side: p.perplSide, reduce: true, sizeWad: s.perpl.targetWad, stepWad: step, priceDp: r.meta.perplPriceDp, note, active, ended, explorerBase, ...(k === "close-p2" ? { title: `Retry (wider price): ${sideWord(p.perplSide, true).toLowerCase()} ${sizeText(s.perpl.targetWad, step)} MON on Perpl` } : {}) }));
  }
  if (s.phase === "CLOSE_MERIDIAN") steps.push({ key: "close-p1", title: `${sideWord(p.perplSide, true)} ${sizeText(p.sizeWad, step)} MON on Perpl`, detail: "Waits for Meridian", status: "waiting" });
  else if (s.phase === "ABORTED") steps.push({ key: "close-p1", title: `${sideWord(p.perplSide, true)} on Perpl`, detail: "Not sent: Meridian closed nothing", status: "skipped" });
  const closed = s.meridian?.filledWad ?? 0n;
  const leftover = s.perpl.targetWad - s.perpl.filledWad;
  switch (s.phase) {
    case "CLOSED":
      return { kind: "close", phase: s.phase, outcome: "success", headline: "Closed on both venues", body: `Closed ${sizeText(closed, step)} MON on Meridian and on Perpl. You're flat.`, steps };
    case "CLOSED_PARTIAL":
      return { kind: "close", phase: s.phase, outcome: "partial", headline: "Partly closed, still hedged", body: `Closed ${sizeText(closed, step)} of ${sizeText(p.sizeWad, step)} MON on both venues. The rest stays open and hedged; close again to finish.`, steps };
    case "ABORTED":
      return { kind: "close", phase: s.phase, outcome: "flat", headline: sc?.filledWad !== undefined && sc.filledWad > 0n ? "Lock closed, pair still open" : "Nothing closed", body: sc?.error !== undefined ? `${sc.error}` : `${lastReason(s.errors)} Your hedge is unchanged${sc?.filledWad ? " (the fixed-rate lock was closed; the pair earns the floating rate)" : ""}.`, steps };
    case "MANUAL":
      return { kind: "close", phase: s.phase, outcome: "action", headline: "Action needed", body: `Meridian closed, but ${sizeText(leftover, step)} MON on Perpl is still open (tried twice). Close it now with one tap.`, steps, leftover: { venue: "perpl", side: opposite(p.perplSide), sizeWad: leftover } };
    default:
      return { kind: "close", phase: s.phase, outcome: "running", headline: "Closing your position…", body: "Meridian first, then Perpl for exactly what closed.", steps };
  }
}

export function buildTimeline(r: EarnRecord, explorerBase: string | undefined): EarnTimeline {
  return r.state.kind === "basis" ? basisTimeline(r.state, r, explorerBase) : closeTimeline(r.state, r, explorerBase);
}
