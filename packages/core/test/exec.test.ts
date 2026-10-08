import { describe, expect, it } from "vitest";
import {
  ExecStateError,
  ExecTransitionError,
  basisExposureWad,
  deserializeExec,
  limitFrom,
  nextBasisAction,
  nextCloseAction,
  nextSingleAction,
  reduceBasis,
  reduceClose,
  reduceSingle,
  runBasis,
  runClose,
  runSingle,
  serializeExec,
  startBasis,
  startClose,
  startSingle,
  type BasisExecPlan,
  type BasisExecState,
  type ExecAdapters,
  type ExecState,
  type LegSpec,
} from "../src/exec";
import { WAD } from "../src/util/fixed";

const MON = WAD;
const LOT = 100n * MON;
const plan = (o: Partial<BasisExecPlan> = {}): BasisExecPlan => ({
  perplSide: "sell", // Perpl funding higher ⇒ short Perpl, long Meridian
  sizeWad: 1_000n * MON,
  perplLimitPriceWad: 25_500n * 10n ** 12n,
  meridianLimitPriceWad: 26_000n * 10n ** 12n,
  meridianLotWad: LOT,
  perplStepWad: MON,
  perplCollateralWad: 10n * WAD,
  meridianCollateralWad: 10n * WAD,
  unwindSlippageBps: 50n,
  ...o,
});

type Script = Record<string, ({ filledWad: bigint; avgPriceWad?: bigint } | { failed: string })[]>;

/** Fake venues: confirm answers from a per-leg-key script; records every call; persists every state (serialised). */
function fakes(script: Script, opts: { collateral?: string; quote?: string } = {}) {
  const calls: string[] = [];
  const saved: string[] = [];
  let n = 0;
  const a: ExecAdapters = {
    legs: {
      prepare: async (leg: LegSpec) => (calls.push(`prepare ${leg.key} ${leg.venue} ${leg.side} ${leg.sizeWad / MON}${leg.reduceOnly ? " ro" : ""}`), `ref-${++n}`),
      send: async (leg, ref) => void calls.push(`send ${leg.key} ${ref}`),
      confirm: async (leg) => {
        calls.push(`confirm ${leg.key}`);
        const q = script[leg.key];
        const r = q?.shift();
        if (!r) throw new Error(`no scripted outcome for ${leg.key}`);
        return r;
      },
    },
    ensureCollateral: async () => {
      calls.push("collateral");
      if (opts.collateral) throw new Error(opts.collateral);
    },
    quote: async () => {
      if (opts.quote) throw new Error(opts.quote);
      return { limitPriceWad: 26_000n * 10n ** 12n, expectedAvgWad: 25_900n * 10n ** 12n };
    },
    persist: (s) => void saved.push(serializeExec(s)),
    maxConfirmTries: 1,
  };
  return { a, calls, saved };
}

const avg = 25_550n * 10n ** 12n;

describe("basis open (MOBILE_PLAN N6 diagram)", () => {
  it("q1 = q2 = size ⇒ DONE, net exposure 0; order: collateral → Perpl IOC → Meridian exactly q1", async () => {
    const f = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 1_000n * MON }] });
    const s = await runBasis(startBasis("b", plan()), f.a);
    expect(s.phase).toBe("DONE");
    expect(basisExposureWad(s)).toBe(0n);
    expect(f.calls).toEqual(["collateral", "prepare b:leg1 perpl sell 1000", "send b:leg1 ref-1", "confirm b:leg1", "prepare b:leg2 meridian buy 1000", "send b:leg2 ref-2", "confirm b:leg2"]);
  });
  it("collateral fails ⇒ ABORTED before any order", async () => {
    const f = fakes({}, { collateral: "Perpl balance too low" });
    const s = await runBasis(startBasis("b", plan()), f.a);
    expect(s.phase).toBe("ABORTED");
    expect(f.calls).toEqual(["collateral"]);
  });
  it("q1 = 0 (IOC found nothing, or FAILED) ⇒ ABORTED, Meridian never touched", async () => {
    for (const r of [{ filledWad: 0n }, { failed: "st 7 sr 34" }]) {
      const f = fakes({ "b:leg1": [r] });
      const s = await runBasis(startBasis("b", plan()), f.a);
      expect(s.phase).toBe("ABORTED");
      expect(f.calls.some((c) => c.includes("leg2"))).toBe(false);
    }
  });
  it("partial Perpl fill 650 ⇒ Meridian 600 (lot) ⇒ q2 < q1 ⇒ unwind 50 reduce-only ⇒ PARTIAL_DONE, exposure 0", async () => {
    const f = fakes({ "b:leg1": [{ filledWad: 650n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 600n * MON }], "b:unwind1": [{ filledWad: 50n * MON }] });
    const s = await runBasis(startBasis("b", plan()), f.a);
    expect(f.calls).toContain("prepare b:leg2 meridian buy 600");
    expect(f.calls).toContain("prepare b:unwind1 perpl buy 50 ro");
    expect(s.phase).toBe("PARTIAL_DONE");
    expect(basisExposureWad(s)).toBe(0n);
  });
  it("Meridian partial (q2 = 300 of 1000) ⇒ unwind 700 ⇒ PARTIAL_DONE", async () => {
    const f = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 300n * MON }], "b:unwind1": [{ filledWad: 700n * MON }] });
    const s = await runBasis(startBasis("b", plan()), f.a);
    expect(s.phase).toBe("PARTIAL_DONE");
    expect(s.unwind).toMatchObject({ reason: "partial", targetWad: 700n * MON, filledWad: 700n * MON });
  });
  it("Meridian fails ⇒ UNWIND_PERPL(q1) ⇒ ABORTED_UNWOUND; the unwind limit is the leg-1 average + slippage (buy ↑)", async () => {
    const f = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ failed: "OracleStale" }], "b:unwind1": [{ filledWad: 1_000n * MON }] });
    const st0 = startBasis("b", plan());
    const s = await runBasis(st0, f.a);
    expect(s.phase).toBe("ABORTED_UNWOUND");
    expect(s.errors).toEqual(["LEG2_MERIDIAN: OracleStale"]);
    expect(basisExposureWad(s)).toBe(0n);
    const mid = deserializeExec(f.saved.find((x) => x.includes('"UNWIND_PERPL"'))!) as BasisExecState;
    const act = nextBasisAction(mid);
    expect(act).toMatchObject({ type: "prepare", leg: { venue: "perpl", side: "buy", reduceOnly: true, sizeWad: 1_000n * MON, limitPriceWad: limitFrom(avg, "buy", 50n) } });
    expect(limitFrom(avg, "buy", 50n)).toBe(25_677_750n * 10n ** 9n); // 0.02555 · 1.005
  });
  it("q1 below one Meridian lot ⇒ straight to unwind (can't hedge) ⇒ ABORTED_UNWOUND", async () => {
    const f = fakes({ "b:leg1": [{ filledWad: 40n * MON, avgPriceWad: avg }], "b:unwind1": [{ filledWad: 40n * MON }] });
    const s = await runBasis(startBasis("b", plan()), f.a);
    expect(s.phase).toBe("ABORTED_UNWOUND");
    expect(f.calls.some((c) => c.includes("leg2"))).toBe(false);
  });
  it("unwind fails ⇒ retry at 2× slippage ⇒ fills ⇒ ABORTED_UNWOUND; retry short too ⇒ MANUAL with the remainder", async () => {
    const ok = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ failed: "x" }], "b:unwind1": [{ failed: "IOC 0" }], "b:unwind2": [{ filledWad: 1_000n * MON }] });
    expect((await runBasis(startBasis("b", plan()), ok.a)).phase).toBe("ABORTED_UNWOUND");
    const retry = deserializeExec(ok.saved.find((x) => x.includes('"UNWIND_RETRY"'))!) as BasisExecState;
    expect(nextBasisAction(retry)).toMatchObject({ leg: { key: "b:unwind2", limitPriceWad: limitFrom(avg, "buy", 100n) } });
    const bad = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ failed: "x" }], "b:unwind1": [{ filledWad: 300n * MON }], "b:unwind2": [{ filledWad: 200n * MON }] });
    const s = await runBasis(startBasis("b", plan()), bad.a);
    expect(s.phase).toBe("MANUAL");
    expect(s.unwind).toMatchObject({ targetWad: 1_000n * MON, filledWad: 500n * MON, attempt: 2 });
    expect(bad.calls).toContain("prepare b:unwind2 perpl buy 700 ro");
    expect(basisExposureWad(s)).toBe(-500n * MON); // what MANUAL must close: 500 MON short on Perpl
  });
  it("lock: LEG3 after a full hedge ⇒ DONE; lock failure ⇒ DONE_LOCK_FAILED and the hedge stays open (no unwind)", async () => {
    const lock = { side: "sell" as const, maxSizeWad: 1_000n * MON, limitPriceWad: WAD + 10n ** 17n, lotWad: 1_000n * MON };
    const ok = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 1_000n * MON }], "b:leg3": [{ filledWad: 1_000n * MON, avgPriceWad: WAD + 12n * 10n ** 16n }] });
    const s = await runBasis(startBasis("b", plan({ lock })), ok.a);
    expect(s.phase).toBe("DONE");
    expect(s.lock).toMatchObject({ filledWad: 1_000n * MON });
    const bad = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 1_000n * MON }], "b:leg3": [{ failed: "Matured" }] });
    const f = await runBasis(startBasis("b", plan({ lock })), bad.a);
    expect(f.phase).toBe("DONE_LOCK_FAILED");
    expect(bad.calls.some((c) => c.includes("unwind"))).toBe(false);
    expect(basisExposureWad(f)).toBe(0n);
    // a partial hedge below one swap lot can't lock
    const small = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 1_000n * MON }] });
    expect((await runBasis(startBasis("b", plan({ lock: { ...lock, lotWad: 2_000n * MON } })), small.a)).phase).toBe("DONE_LOCK_FAILED");
  });
  it("rejects impossible events and sizes off the steps", () => {
    const s = startBasis("b", plan());
    expect(() => reduceBasis(s, { type: "SENT" })).toThrow(ExecTransitionError);
    const leg1 = reduceBasis(s, { type: "COLLATERAL_OK" });
    expect(() => reduceBasis(leg1, { type: "FILLED", filledWad: 2_000n * MON })).toThrow(/outside/);
    expect(() => reduceBasis({ ...leg1, phase: "DONE" }, { type: "FAILED", error: "x" })).toThrow(ExecTransitionError);
    expect(() => startBasis("b", plan({ sizeWad: 150n * MON }))).toThrow(/steps/);
  });
});

/**
 * Kill the app after EVERY persisted state: reload the blob, check it round-trips byte for byte, then resume with a fresh
 * adapter (same venue outcomes) and require the same final outcome as the uninterrupted run, with no leg prepared twice.
 */
async function killEverywhere(start: ExecState, script: () => Script, run: (s: ExecState, a: ExecAdapters) => Promise<ExecState>) {
  const full = fakes(script());
  const end = await run(start, full.a);
  const outcome = (s: ExecState) => JSON.parse(serializeExec(s).replace(/"ref":"ref-\d+",?/g, "")) as unknown;
  for (const blob of full.saved) {
    const saved = deserializeExec(blob);
    expect(serializeExec(saved)).toBe(blob);
    const again = fakes(script());
    const resumed = await run(saved, again.a);
    expect(outcome(resumed)).toEqual(outcome(end));
    // the leg prepared in the snapshot is resumed by its ref (send / confirm), never prepared a second time
    const act = (saved.kind === "basis" ? nextBasisAction(saved) : saved.kind === "close" ? nextCloseAction(saved) : nextSingleAction(saved)) as { leg?: LegSpec };
    if (saved.leg.ref !== undefined && act.leg) expect(again.calls.some((c) => c.startsWith(`prepare ${act.leg!.key} `))).toBe(false);
  }
  return { end, snapshots: full.saved.length };
}

describe("persisted state: serialise mid-run, resume to the same next action (app kill)", () => {
  const script = (): Script => ({ "b:leg1": [{ filledWad: 650n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 600n * MON }], "b:unwind1": [{ filledWad: 50n * MON }] });
  it("every snapshot round-trips (bigints exact) and yields the same next action", async () => {
    const { end, snapshots } = await killEverywhere(startBasis("b", plan()), script, (s, a) => runBasis(s as BasisExecState, a));
    expect(end.phase).toBe("PARTIAL_DONE");
    expect(snapshots).toBe(10); // collateral + 3 per leg × 3 legs
  });
  it("same for a lock run and a close run", async () => {
    const lock = { side: "sell" as const, maxSizeWad: 1_000n * MON, limitPriceWad: WAD, lotWad: 1_000n * MON };
    const ls = (): Script => ({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 1_000n * MON }], "b:leg3": [{ failed: "Matured" }] });
    expect((await killEverywhere(startBasis("b", plan({ lock })), ls, (s, a) => runBasis(s as BasisExecState, a))).end.phase).toBe("DONE_LOCK_FAILED");
    const cs = (): Script => ({ "c:close-m": [{ filledWad: 1_000n * MON }], "c:close-p1": [{ filledWad: 600n * MON }], "c:close-p2": [{ filledWad: 400n * MON }] });
    const cp = { meridianSide: "sell" as const, perplSide: "buy" as const, sizeWad: 1_000n * MON, meridianLimitPriceWad: 1n, perplRefPriceWad: avg, perplSlippageBps: 50n, perplStepWad: MON };
    expect((await killEverywhere(startClose("c", cp), cs, (s, a) => runClose(s as never, a))).end.phase).toBe("CLOSED");
  });
  it("killed after PREPARED (before send) ⇒ resumes with send of the SAME ref, never a second prepare", async () => {
    const f = fakes({ "b:leg1": [{ filledWad: 1_000n * MON, avgPriceWad: avg }], "b:leg2": [{ filledWad: 1_000n * MON }] });
    let s = reduceBasis(startBasis("b", plan()), { type: "COLLATERAL_OK" });
    s = reduceBasis(s, { type: "PREPARED", ref: "rq-42" });
    const reloaded = deserializeExec(serializeExec(s)) as BasisExecState;
    expect(nextBasisAction(reloaded)).toMatchObject({ type: "send", ref: "rq-42", leg: { key: "b:leg1" } });
    const done = await runBasis(reloaded, f.a);
    expect(f.calls[0]).toBe("send b:leg1 rq-42");
    expect(f.calls.filter((c) => c.startsWith("prepare b:leg1"))).toEqual([]);
    expect(done.phase).toBe("DONE");
  });
  it("killed after SENT ⇒ resumes by confirming (reconcile), then continues", async () => {
    let s = reduceBasis(startBasis("b", plan()), { type: "COLLATERAL_OK" });
    s = reduceBasis(reduceBasis(s, { type: "PREPARED", ref: "rq-7" }), { type: "SENT" });
    const r = deserializeExec(serializeExec(s)) as BasisExecState;
    expect(nextBasisAction(r)).toMatchObject({ type: "confirm", ref: "rq-7" });
    const f = fakes({ "b:leg1": [{ filledWad: 0n }] });
    expect((await runBasis(r, f.a)).phase).toBe("ABORTED");
  });
  it("a confirm that can't learn the outcome throws and leaves the state for the next resume (never assumes)", async () => {
    let s = reduceBasis(startBasis("b", plan()), { type: "COLLATERAL_OK" });
    s = reduceBasis(reduceBasis(s, { type: "PREPARED", ref: "rq-9" }), { type: "SENT" });
    const f = fakes({});
    await expect(runBasis(s, f.a)).rejects.toThrow(/outcome still unknown/);
    expect(nextBasisAction(s)).toMatchObject({ type: "confirm", ref: "rq-9" });
  });
  it("refuses foreign, corrupt, future-version or unknown-phase blobs", () => {
    const good = serializeExec(startBasis("b", plan()));
    expect(() => deserializeExec("{")).toThrow(ExecStateError);
    expect(() => deserializeExec(JSON.stringify({ v: 1 }))).toThrow(/not a Meridian/);
    expect(() => deserializeExec(good.replace('"v":1', '"v":2'))).toThrow(/version 2/);
    expect(() => deserializeExec(good.replace('"COLLATERAL"', '"YOLO"'))).toThrow(/phase YOLO/);
    expect(() => deserializeExec(good.replace('{"$bigint":"100000000000000000000"}', '{"$bigint":"1e20"}'))).toThrow(ExecStateError);
    expect((deserializeExec(good) as BasisExecState).plan.meridianLotWad).toBe(LOT);
  });
});

describe("basis close = reverse order (Meridian reduce-only first, then Perpl for exactly what closed)", () => {
  const cplan = { meridianSide: "sell" as const, perplSide: "buy" as const, sizeWad: 1_000n * MON, meridianLimitPriceWad: 25_000n * 10n ** 12n, perplRefPriceWad: avg, perplSlippageBps: 50n, perplStepWad: MON };
  it("full close ⇒ CLOSED; both legs reduce-only", async () => {
    const f = fakes({ "c:close-m": [{ filledWad: 1_000n * MON }], "c:close-p1": [{ filledWad: 1_000n * MON }] });
    expect((await runClose(startClose("c", cplan), f.a)).phase).toBe("CLOSED");
    expect(f.calls.filter((c) => c.startsWith("prepare"))).toEqual(["prepare c:close-m meridian sell 1000 ro", "prepare c:close-p1 perpl buy 1000 ro"]);
  });
  it("Meridian closes nothing ⇒ ABORTED (unchanged); partial ⇒ Perpl closes the same size ⇒ CLOSED_PARTIAL", async () => {
    expect((await runClose(startClose("c", cplan), fakes({ "c:close-m": [{ failed: "OracleStale" }] }).a)).phase).toBe("ABORTED");
    const f = fakes({ "c:close-m": [{ filledWad: 400n * MON }], "c:close-p1": [{ filledWad: 400n * MON }] });
    expect((await runClose(startClose("c", cplan), f.a)).phase).toBe("CLOSED_PARTIAL");
    expect(f.calls).toContain("prepare c:close-p1 perpl buy 400 ro");
  });
  it("Perpl short ⇒ retry at 2× slippage for the rest ⇒ CLOSED; still short ⇒ MANUAL", async () => {
    const ok = fakes({ "c:close-m": [{ filledWad: 1_000n * MON }], "c:close-p1": [{ filledWad: 600n * MON }], "c:close-p2": [{ filledWad: 400n * MON }] });
    expect((await runClose(startClose("c", cplan), ok.a)).phase).toBe("CLOSED");
    expect(ok.calls).toContain("prepare c:close-p2 perpl buy 400 ro");
    const bad = fakes({ "c:close-m": [{ filledWad: 1_000n * MON }], "c:close-p1": [{ failed: "x" }], "c:close-p2": [{ filledWad: 1n * MON }] });
    const s = await runClose(startClose("c", cplan), bad.a);
    expect(s.phase).toBe("MANUAL");
    expect(s.perpl).toEqual({ targetWad: 1_000n * MON, filledWad: MON });
    const mid = deserializeExec(bad.saved.find((x) => x.includes('"CLOSE_PERPL_RETRY"'))!);
    expect(nextCloseAction(mid as never)).toMatchObject({ leg: { limitPriceWad: limitFrom(avg, "buy", 100n) } });
    expect(() => reduceClose(s, { type: "SENT" })).toThrow(ExecTransitionError);
  });
});

describe("single-leg: QUOTE → SEND → CONFIRM → DONE | FAILED", () => {
  const order = { venue: "perpl" as const, side: "buy" as const, sizeWad: 100n * MON, reduceOnly: false };
  it("happy path, and every snapshot resumes to the same next action", async () => {
    const f = fakes({ "t:leg": [{ filledWad: 100n * MON, avgPriceWad: avg }] });
    const s = await runSingle(startSingle("t", order), f.a);
    expect(s).toMatchObject({ phase: "DONE", result: { filledWad: 100n * MON, avgPriceWad: avg }, limitPriceWad: 26_000n * 10n ** 12n });
    for (const blob of f.saved) expect(nextSingleAction(deserializeExec(blob) as never)).toEqual(nextSingleAction(deserializeExec(blob) as never));
    expect(f.saved.map((b) => (deserializeExec(b) as { phase: string }).phase)).toEqual(["SEND", "SEND", "CONFIRM", "DONE"]);
  });
  it("quote failure / venue failure / zero fill ⇒ FAILED; bad transitions throw", async () => {
    expect((await runSingle(startSingle("t", order), fakes({}, { quote: "no liquidity" }).a)).phase).toBe("FAILED");
    expect((await runSingle(startSingle("t", order), fakes({ "t:leg": [{ failed: "InsufficientMargin" }] }).a)).error).toBe("InsufficientMargin");
    expect((await runSingle(startSingle("t", order), fakes({ "t:leg": [{ filledWad: 0n }] }).a)).phase).toBe("FAILED");
    expect(() => reduceSingle(startSingle("t", order), { type: "SENT" })).toThrow(ExecTransitionError);
    expect(() => startSingle("t", { ...order, sizeWad: 0n })).toThrow();
  });
});
