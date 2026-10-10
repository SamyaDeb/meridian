// Close all with Earn + Lock (MOBILE_PLAN N6 + N7 integration). Which positions belong together comes from the Earn
// record, never from sizes alone, and a fixed-rate lock is never left without its hedge:
//  - an open Earn pair (record: perplSide + sizeWad > 0) closes through the Earn executor, exactly as the Earn screen
//    closes it (closePair.ts): the lock bought / sold back first, in full, else nothing else is sent; then Meridian, then
//    Perpl for exactly what closed. The executor folds the run into the record (applyRun, by run id), so the record
//    matches the venues afterwards.
//  - positions outside the Earn pair keep N7's path (exec/closeAll.ts): an equal and opposite pair on the two-leg close
//    machine, anything else one by one, Meridian first. They are only sent once the Earn pair closed in full.
//  - a lock with no Earn record, a lock that doesn't match the record, or a record the venues don't hold: refused with
//    the reason and where to close it. Nothing is guessed and nothing is sent.
// A one-sided Earn leftover (record.naked) closed here shrinks in the record as it does from the Earn screen.
import type { CloseExecState } from "@meridian/core/exec";
import { abs } from "@meridian/core/util";
import { plainTradeError } from "../trade/exec/errors";
import { planBasisClose, planSingleCloses, type BasisClosePlan, type CloseAllMarkets, type CloseAllOutcome, type SingleClose } from "../trade/exec/closeAll";
import type { Receipt } from "../trade/exec/receipt";
import { earnPairHeld, earnPairWant, isBasisPair, type PositionView } from "../trade/positions/views";
import { sizeText } from "../trade/ticket/quote";
import { LOCK_UNKNOWN, lockOf, lockSideOf, planEarnPairClose, type EarnPairClose, type PairCloseInputs } from "./closePair";
import type { EarnExecutor } from "./executor";
import type { EarnPosition } from "./record";
import type { EarnTimeline } from "./timeline";

const MON = (w: bigint, step: bigint) => `${sizeText(abs(w), step)} MON`;

export const EARN_LOADING = "Reading your Earn position…";
export const lockNoRecord = (lockWad: bigint, step: bigint) =>
  `You hold a fixed-rate lock on ${MON(lockWad, step)} of Meridian's funding, but this phone has no Earn position for it, so Close all won't guess which positions it fixes and sends nothing. Close the fixed-rate lock first (Settings → Open full terminal → Fix), then Close all again.`;
export const lockMismatch = (lockWad: bigint, pairWad: bigint, step: bigint) =>
  `Your fixed-rate lock (${MON(lockWad, step)}) doesn't match your Earn position (${MON(pairWad, step)} each side), so Close all sends nothing. Close the fixed-rate lock on Earn first: its Close buys the lock back before both legs.`;
export const pairNotHeld = (pairWad: bigint, step: bigint) =>
  `Your Earn position (${MON(pairWad, step)} each side) isn't fully open on both venues any more, so Close all sends nothing. Close it on Earn, which closes what's still open on both.`;

/** N7's path for positions that aren't (or are outside) the Earn pair. */
export type RestRoute = { kind: "basis"; plan: BasisClosePlan } | { kind: "singles"; list: SingleClose[] } | { kind: "error"; error: string };

export type CloseAllRoute =
  | { kind: "wait"; reason: string }
  | { kind: "refused"; error: string }
  | { kind: "empty" }
  | { kind: "earn"; earn: Extract<EarnPairClose, { ok: true }>; rest: RestRoute | undefined; restViews: PositionView[]; summary: string }
  | { kind: "plain"; rest: RestRoute; restViews: PositionView[] };

export type CloseAllInput = {
  views: readonly PositionView[];
  mk: CloseAllMarkets;
  /** the Earn record; undefined while it's being read, null when Earn isn't available on this network */
  earnPos: EarnPosition | undefined | null;
  inputs: PairCloseInputs;
  /** the funding-swap market is deployed (a lock can exist) */
  swapMarket: boolean;
};

function restOf(views: readonly PositionView[], mk: CloseAllMarkets): RestRoute {
  if (isBasisPair(views)) {
    const p = planBasisClose(views, mk);
    return "error" in p ? { kind: "error", error: p.error } : { kind: "basis", plan: p };
  }
  const l = planSingleCloses(views, mk);
  return "error" in l ? { kind: "error", error: l.error } : { kind: "singles", list: l };
}

/** Which way Close all goes, from the live positions, the Earn record and the wallet's lock (pure). */
export function planCloseAll(i: CloseAllInput): CloseAllRoute {
  const step = i.inputs.perpl.stepWad ?? 10n ** 18n;
  const lock = lockOf(i.inputs, i.swapMarket);
  if (!lock.known) return { kind: "wait", reason: LOCK_UNKNOWN };
  if (i.earnPos === undefined) return { kind: "wait", reason: EARN_LOADING };
  const pair = i.earnPos && i.earnPos.perplSide && i.earnPos.sizeWad > 0n ? { perplSide: i.earnPos.perplSide, sizeWad: i.earnPos.sizeWad } : undefined;
  if (lock.sizeWad !== 0n && !pair) return { kind: "refused", error: lockNoRecord(lock.sizeWad, step) };
  if (!pair) return i.views.length === 0 ? { kind: "empty" } : { kind: "plain", rest: restOf(i.views, i.mk), restViews: [...i.views] };

  const S = pair.sizeWad;
  if (lock.sizeWad !== 0n) {
    const wantSign = lockSideOf(pair.perplSide) === "sell" ? -1n : 1n;
    if ((lock.sizeWad > 0n ? 1n : -1n) !== wantSign || abs(lock.sizeWad) > S) return { kind: "refused", error: lockMismatch(lock.sizeWad, S, step) };
  }
  if (!earnPairHeld(i.views, pair)) return { kind: "refused", error: pairNotHeld(S, step) };

  const ec = planEarnPairClose(pair, i.inputs, i.swapMarket);
  if (!ec.ok) return { kind: "refused", error: ec.error };
  if (ec.sizeWad !== S) return { kind: "refused", error: pairNotHeld(S, step) };
  const want = earnPairWant(pair);
  const restViews = i.views.map((v) => ({ ...v, sizeWad: v.sizeWad - want[v.venue] })).filter((v) => v.sizeWad !== 0n);
  const summary = `${ec.swap ? `Close the fixed-rate lock (${MON(ec.swap.sizeWad, 10n ** 18n)}) first, then the` : "Close the"} Earn position: ${MON(S, step)} on Meridian first, then the same on Perpl`;
  return { kind: "earn", earn: ec, rest: restViews.length ? restOf(restViews, i.mk) : undefined, restViews, summary };
}

// ── run ──

export type CloseAllRunDeps = {
  earn: Pick<EarnExecutor, "close" | "noteManualClose" | "position" | "store"> | undefined;
  /** N7's two-leg close (CloseAllExecutor.start with this wallet's meta); the final state names what each venue closed */
  basis: (p: BasisClosePlan) => Promise<{ outcome: CloseAllOutcome | undefined; state: CloseExecState | undefined }>;
  /** one reduce-only order through the Trade executor */
  single: (c: SingleClose) => Promise<Receipt | undefined>;
};

export type CloseAllResult = CloseAllOutcome & { earn?: EarnTimeline };

const errText = (e: unknown) => plainTradeError(e instanceof Error ? e.message : String(e));

/**
 * After N7's path closed `filledWad` of `venue`'s position outside the Earn pair (`restWad`, signed): the Earn leftover
 * on that venue can be at most what's still open there, on its side.
 */
async function shrinkLeftover(earn: CloseAllRunDeps["earn"], venue: "perpl" | "meridian", restWad: bigint, filledWad: bigint): Promise<void> {
  const naked = earn?.position.get().naked;
  if (!earn || !naked || naked.venue !== venue || filledWad <= 0n) return;
  if ((restWad > 0n) !== (naked.side === "buy")) return; // closing the other side doesn't touch the leftover
  const left = abs(restWad) - filledWad;
  const keep = left <= 0n ? 0n : left < naked.sizeWad ? left : naked.sizeWad;
  if (keep < naked.sizeWad) await earn.noteManualClose(naked.sizeWad - keep);
}

async function runRest(rest: RestRoute, views: readonly PositionView[], d: CloseAllRunDeps): Promise<CloseAllOutcome> {
  if (rest.kind === "error") return { ok: false, title: "Nothing closed", detail: rest.error };
  const restWad = (venue: "perpl" | "meridian") => views.find((v) => v.venue === venue)?.sizeWad ?? 0n;
  if (rest.kind === "basis") {
    let r: Awaited<ReturnType<CloseAllRunDeps["basis"]>>;
    try {
      r = await d.basis(rest.plan);
    } catch (e) {
      return { ok: false, title: "Nothing closed", detail: errText(e) };
    }
    const { outcome, state } = r;
    if (state) {
      await shrinkLeftover(d.earn, "meridian", restWad("meridian"), state.meridian?.filledWad ?? 0n);
      await shrinkLeftover(d.earn, "perpl", restWad("perpl"), state.perpl.filledWad);
    }
    return outcome ?? { ok: false, title: "Still checking the close", detail: "Nothing is lost: it continues when the app restarts." };
  }
  const closed: string[] = [];
  const name = (v: SingleClose["venue"]) => (v === "meridian" ? "Meridian" : "Perpl");
  for (const c of rest.list) {
    try {
      const r = await d.single(c);
      if (!r?.ok) throw new Error(r?.error ?? "Still checking the order…");
      await shrinkLeftover(d.earn, c.venue, restWad(c.venue), r.filledWad);
      closed.push(name(c.venue));
    } catch (e) {
      const left = rest.list.slice(closed.length).map((x) => name(x.venue));
      return { ok: false, title: closed.length ? "Partly closed" : "Nothing closed", detail: `${closed.length ? `Closed on ${closed.join(" and ")}. ` : ""}${errText(e)} Still open on ${left.join(" and ")}.` };
    }
  }
  return { ok: true, title: "Everything closed", detail: `Closed on ${closed.join(" and ")}. Nothing is left open.` };
}

/** Runs a planned route: the Earn pair first (lock → Meridian → Perpl); the rest only once it closed in full. */
export async function runCloseAll(route: Extract<CloseAllRoute, { kind: "earn" | "plain" }>, d: CloseAllRunDeps): Promise<CloseAllResult> {
  try {
    if (route.kind === "plain") return await runRest(route.rest, route.restViews, d);
    if (!d.earn) return { ok: false, title: "Nothing closed", detail: "Earn isn't ready yet. Try again in a moment." };
    const t = await d.earn.close(route.earn.plan, route.earn.meta, route.earn.swap);
    if (!t) return { ok: false, title: "Still checking the Earn close", detail: `${d.earn.store.get().error ?? "The orders are still being checked."} Nothing else was sent; it continues when the app restarts.` };
    if (t.phase !== "CLOSED") return { ok: false, title: t.headline, detail: `${t.body}${route.rest ? " Your other positions weren't touched." : ""}`, earn: t };
    if (!route.rest) return { ok: true, title: t.headline, detail: t.body, earn: t };
    const r = await runRest(route.rest, route.restViews, d);
    return { ok: r.ok, title: r.ok ? "Everything closed" : r.title, detail: `Earn position closed${route.earn.swap ? " (the fixed-rate lock first)" : ""}. ${r.detail}`, earn: t };
  } catch (e) {
    return { ok: false, title: "Nothing closed", detail: errText(e) };
  }
}
