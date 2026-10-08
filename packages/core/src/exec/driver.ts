// Drives a machine with injected adapters: action → adapter call → event → reducer → persist → repeat, until terminal.
// The app's adapters wrap PerplTrading (ioc / rq), the Meridian OrderBook writes (viem walletClient, gas ×1.2) and the
// collateral checks; tests pass fakes. Adapter exceptions become FAILED events only where that is safe: a throw before
// `send` means nothing went out; a throw while confirming is retried (the outcome is unknown, never assumed).
import { isBasisTerminal, nextBasisAction, reduceBasis, type BasisEvent, type BasisExecState } from "./basis";
import { isCloseTerminal, nextCloseAction, reduceClose, type CloseExecState } from "./close";
import type { LegEvent, LegSpec } from "./leg";
import { isSingleTerminal, nextSingleAction, reduceSingle, type SingleEvent, type SingleState } from "./single";

export type LegAdapter = {
  /** fix the order identity without sending (Perpl rq, signed tx hash) */
  prepare(leg: LegSpec): Promise<string>;
  /** (re)send a prepared order; idempotent */
  send(leg: LegSpec, ref: string): Promise<void>;
  /** definitive outcome of `ref`; throw if not known yet (the driver retries) */
  confirm(leg: LegSpec, ref: string): Promise<{ filledWad: bigint; avgPriceWad?: bigint } | { failed: string }>;
};

export type ExecAdapters = {
  legs: LegAdapter;
  quote?(order: SingleState["order"]): Promise<{ limitPriceWad: bigint; expectedAvgWad?: bigint }>;
  ensureCollateral?(perplWad: bigint, meridianWad: bigint): Promise<void>;
  persist(state: SingleState | BasisExecState | CloseExecState): Promise<void> | void;
  /** wait between confirm retries (default 1 s through the adapter's own timer) */
  sleep?(ms: number): Promise<void>;
  maxConfirmTries?: number;
};

async function runLeg(a: ExecAdapters, act: { type: "prepare" | "send" | "confirm"; leg: LegSpec; ref?: string }): Promise<LegEvent> {
  if (act.type === "prepare") {
    try {
      return { type: "PREPARED", ref: await a.legs.prepare(act.leg) };
    } catch (e) {
      return { type: "FAILED", error: `prepare: ${String(e instanceof Error ? e.message : e)}` };
    }
  }
  if (act.type === "send") {
    try {
      await a.legs.send(act.leg, act.ref!);
    } catch {
      // a send that threw may still have reached the venue: confirm decides (refs are idempotent), never FAILED here
    }
    return { type: "SENT" };
  }
  const tries = a.maxConfirmTries ?? 30;
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await a.legs.confirm(act.leg, act.ref!);
      return "failed" in r ? { type: "FAILED", error: r.failed } : { type: "FILLED", filledWad: r.filledWad, ...(r.avgPriceWad !== undefined ? { avgPriceWad: r.avgPriceWad } : {}) };
    } catch (e) {
      last = String(e instanceof Error ? e.message : e);
      if (a.sleep) await a.sleep(1_000);
    }
  }
  throw new Error(`confirm ${act.ref}: outcome still unknown after ${tries} tries (${last}); state kept for resume`);
}

/** Runs a single-leg trade from any persisted state to DONE / FAILED. */
export async function runSingle(s0: SingleState, a: ExecAdapters): Promise<SingleState> {
  let s = s0;
  while (!isSingleTerminal(s)) {
    const act = nextSingleAction(s);
    let e: SingleEvent;
    if (act.type === "quote") {
      try {
        e = { type: "QUOTED", ...(await a.quote!(act.order)) };
      } catch (x) {
        e = { type: "QUOTE_FAILED", error: String(x instanceof Error ? x.message : x) };
      }
    } else if (act.type === "none") break;
    else e = await runLeg(a, act);
    s = reduceSingle(s, e);
    await a.persist(s);
  }
  return s;
}

/** Runs a basis open from any persisted state to a terminal phase. */
export async function runBasis(s0: BasisExecState, a: ExecAdapters): Promise<BasisExecState> {
  let s = s0;
  while (!isBasisTerminal(s)) {
    const act = nextBasisAction(s);
    let e: BasisEvent;
    if (act.type === "ensure-collateral") {
      try {
        await a.ensureCollateral!(act.perplWad, act.meridianWad);
        e = { type: "COLLATERAL_OK" };
      } catch (x) {
        e = { type: "COLLATERAL_FAILED", error: String(x instanceof Error ? x.message : x) };
      }
    } else if (act.type === "none") break;
    else e = await runLeg(a, act);
    s = reduceBasis(s, e);
    await a.persist(s);
  }
  return s;
}

/** Runs a basis close from any persisted state to a terminal phase. */
export async function runClose(s0: CloseExecState, a: ExecAdapters): Promise<CloseExecState> {
  let s = s0;
  while (!isCloseTerminal(s)) {
    const act = nextCloseAction(s);
    if (act.type === "none") break;
    s = reduceClose(s, await runLeg(a, act));
    await a.persist(s);
  }
  return s;
}
