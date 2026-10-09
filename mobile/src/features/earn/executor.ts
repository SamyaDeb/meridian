// Runs Earn's two-leg trades for one unlocked wallet: core runBasis (open: Perpl IOC first, then Meridian for exactly
// the filled size, auto-unwind) and runClose (Meridian first, then Perpl for exactly what closed), with the N5 venue
// legs keyed per leg, the run persisted after every event (record.ts), the receipt timeline published live, and on
// launch / unlock a run an app kill left open resumed to a terminal phase. One run at a time.
//
// Resume rule (never "unknown", never a surprise order): a FIRST leg that wasn't sent before the kill is cancelled
// (open: LEG1 / collateral ⇒ ABORTED; close: the Meridian leg ⇒ ABORTED, nothing changed); any LATER leg always runs to
// its end, because exposure is open (hedge, unwind, Perpl close). A leg whose identity was recorded resumes on it:
// Meridian re-broadcasts the persisted signed tx (idempotent by nonce), Perpl finds the order sent after the recorded
// rq floor in its order history.
import {
  nextBasisAction,
  nextCloseAction,
  reduceBasis,
  reduceClose,
  runBasis,
  runClose,
  startBasis,
  startClose,
  type BasisExecPlan,
  type CloseExecPlan,
  type ExecAdapters,
  type LegAdapter,
  type LegEvent,
  type LegSpec,
  type OrderSide,
  advanceLeg,
  freshLeg,
  legAction,
} from "@meridian/core/exec";
import { keccak256 } from "viem";
import { Store } from "../../live/store";
import { plainTradeError } from "../trade/exec/errors";
import { applyRun, FLAT, reduceNaked, type EarnMeta, type EarnPosition, type EarnRecord, type EarnRecordStore, type EarnRun, type LegNote, type PositionStore } from "./record";
import { buildTimeline, type EarnTimeline } from "./timeline";

export const NOT_SENT_FIRST = "The app closed before the first order was sent. Nothing was placed.";

/** The writer of a run record: leg notes and state events go through it, in order. */
export class EarnSession {
  private q: Promise<void> = Promise.resolve();
  constructor(
    public rec: EarnRecord,
    private readonly store: Pick<EarnRecordStore, "save">,
    private readonly onSave: (r: EarnRecord) => void = () => undefined,
  ) {}
  private write(): Promise<void> {
    const snap = this.rec;
    this.onSave(snap);
    this.q = this.q.then(() => this.store.save(snap));
    return this.q;
  }
  saveState(state: EarnRun): Promise<void> {
    this.rec = { ...this.rec, state };
    return this.write();
  }
  note(key: string): LegNote {
    return this.rec.meta.legs[key] ?? {};
  }
  patchMeta(patch: Partial<EarnMeta>): Promise<void> {
    this.rec = { ...this.rec, meta: { ...this.rec.meta, ...patch } };
    return this.write();
  }
  patchLeg(key: string, patch: Partial<LegNote>): Promise<void> {
    this.rec = { ...this.rec, meta: { ...this.rec.meta, legs: { ...this.rec.meta.legs, [key]: { ...this.note(key), ...patch } } } };
    return this.write();
  }
}

/** One venue leg for one key (N5 adapters): notes go to the session under that key. */
export type KeyedLeg = { legs: LegAdapter; findSent?: (rqFloor: number, side: "buy" | "sell", reduceOnly: boolean) => Promise<string | undefined>; orderId?: () => number | undefined };
export type LegFactory = (leg: LegSpec, io: { note: () => LegNote; patch: (p: Partial<LegNote>) => Promise<void>; meta: EarnMeta }) => KeyedLeg;

/** `resumed`: the run was picked up after an app kill (the Earn screen offers its receipt) */
export type EarnExecState = { running: boolean; timeline: EarnTimeline | undefined; error: string | undefined; resumed?: boolean };

export type EarnExecutorDeps = {
  chainId: number;
  address: string;
  runs: EarnRecordStore;
  positions: PositionStore;
  /** builds the venue leg for a key; throws when the venue isn't ready (a fresh run says why, a resume waits) */
  legFor: LegFactory;
  /** before the first leg: each venue's need (WAD) + the Lock's swap-market collateral (0 without a Lock) */
  ensureCollateral: (perplWad: bigint, meridianWad: bigint, lockWad: bigint) => Promise<void>;
  head: () => bigint | undefined;
  explorerBase: string | undefined;
  sleep: (ms: number) => Promise<void>;
  /** __DEV__ builds: wraps each venue leg (force the Meridian open leg to fail; the failure lands in the leg's note) */
  wrapLegs?: (legs: LegAdapter, meta: EarnMeta) => LegAdapter;
  /** venue state to re-read after a run */
  afterRun?: () => void;
  now?: () => number;
  maxConfirmTries?: number;
  findTries?: number;
};

export type RunMeta = Pick<EarnMeta, "summary" | "perplPriceDp" | "meridianPriceDp" | "leverage100"> & { devFailMeridian?: boolean; lockCollateralWad?: bigint };

/** Close with a Lock: the swap position to buy / sell back first (reduce-only, whole swap lots, worst price). */
export type SwapCloseOrder = { side: OrderSide; sizeWad: bigint; limitPriceWad: bigint };

export class EarnExecutor {
  readonly store = new Store<EarnExecState>({ running: false, timeline: undefined, error: undefined });
  readonly position = new Store<EarnPosition>(FLAT);
  private running = false;

  constructor(private readonly d: EarnExecutorDeps) {}

  get busy(): boolean {
    return this.running;
  }

  async loadPosition(): Promise<EarnPosition> {
    const p = await this.d.positions.load();
    this.position.set(p);
    return p;
  }

  /** Open: the plan the user held to confirm (Earn quote → core BasisExecPlan). */
  async open(plan: BasisExecPlan, meta: RunMeta): Promise<EarnTimeline | undefined> {
    const now = (this.d.now ?? Date.now)();
    return this.run(this.fresh(startBasis(`e${now}`, plan), meta, now), false);
  }

  /**
   * Close the hedged pair: Meridian first, then Perpl for exactly what closed. With a Lock, the swap is closed FIRST
   * (reduce-only); if it doesn't close in full, nothing else is sent (the pair stays hedged at the floating rate).
   */
  async close(plan: CloseExecPlan, meta: RunMeta, swap?: SwapCloseOrder): Promise<EarnTimeline | undefined> {
    const now = (this.d.now ?? Date.now)();
    const id = `c${now}`;
    const rec = this.fresh(startClose(id, plan), meta, now);
    if (swap) rec.meta.swapClose = { leg: { venue: "swap", side: swap.side, sizeWad: swap.sizeWad, limitPriceWad: swap.limitPriceWad, reduceOnly: true, key: `${id}:swap-close` }, progress: freshLeg() };
    return this.run(rec, false);
  }

  /** Launch / unlock: a run from before an app kill continues to a terminal phase. */
  async resume(): Promise<EarnTimeline | undefined> {
    if (this.running) return undefined;
    await this.loadPosition();
    const rec = await this.d.runs.load();
    if (!rec) return undefined;
    return this.run(rec, true);
  }

  /** A one-tap manual close of the leftover filled `filledWad` (the Trade executor ran it). */
  async noteManualClose(filledWad: bigint): Promise<void> {
    const p = reduceNaked(await this.d.positions.load(), filledWad);
    await this.d.positions.save(p);
    this.position.set(p);
  }

  /** The progress / receipt view closed after a result. */
  reset(): void {
    if (!this.running) this.store.set({ running: false, timeline: undefined, error: undefined });
  }

  private fresh(state: EarnRun, m: RunMeta, now: number): EarnRecord {
    if (this.running) throw new Error("Another Earn order is still going through");
    const head = this.d.head();
    const meta: EarnMeta = { chainId: this.d.chainId, address: this.d.address, createdAtMs: now, summary: m.summary, perplPriceDp: m.perplPriceDp, meridianPriceDp: m.meridianPriceDp, leverage100: m.leverage100, legs: {}, ...(head !== undefined ? { sentAtBlock: head } : {}), ...(m.devFailMeridian ? { devFailMeridian: true } : {}), ...(m.lockCollateralWad ? { lockCollateralWad: m.lockCollateralWad } : {}) };
    return { v: 1, state, meta };
  }

  private async run(rec0: EarnRecord, resumed: boolean): Promise<EarnTimeline | undefined> {
    if (this.running) throw new Error("Another Earn order is still going through");
    this.running = true;
    const publish = (r: EarnRecord) => this.store.set({ running: true, timeline: buildTimeline(r, this.d.explorerBase), error: undefined });
    const ses = new EarnSession(rec0, this.d.runs, publish);
    const cache = new Map<string, KeyedLeg>();
    const inst = (leg: LegSpec): KeyedLeg => {
      let k = cache.get(leg.key);
      if (!k) {
        k = this.d.legFor(leg, { note: () => ses.note(leg.key), patch: (p) => ses.patchLeg(leg.key, p), meta: ses.rec.meta });
        if (this.d.wrapLegs) k = { ...k, legs: this.d.wrapLegs(k.legs, ses.rec.meta) };
        cache.set(leg.key, k);
      }
      return k;
    };
    const keyed: LegAdapter = {
      async prepare(leg) {
        try {
          const ref = await inst(leg).legs.prepare(leg);
          await ses.patchLeg(leg.key, { ref });
          return ref;
        } catch (e) {
          await ses.patchLeg(leg.key, { error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      },
      send: (leg, ref) => inst(leg).legs.send(leg, ref),
      async confirm(leg, ref) {
        const k = inst(leg);
        const r = await k.legs.confirm(leg, ref);
        const oid = k.orderId?.();
        await ses.patchLeg(leg.key, { ...("failed" in r ? { error: r.failed } : { filledWad: r.filledWad, ...(r.avgPriceWad !== undefined ? { avgPriceWad: r.avgPriceWad } : {}) }), ...(oid !== undefined ? { orderId: oid } : {}) });
        return r;
      },
    };
    publish(ses.rec);
    try {
      let state: EarnRun = ses.rec.state;
      const sc = ses.rec.meta.swapClose;
      if (state.kind === "close" && sc && sc.filledWad === undefined && sc.error === undefined) {
        // close with a Lock: the swap first; anything short of a full close stops here (CLOSE_MERIDIAN → ABORTED)
        const err = await this.runSwapClose(ses, keyed, resumed);
        if (err !== undefined) state = reduceClose(state, { type: "FAILED", error: err });
      } else if (state.kind === "close" && sc?.error !== undefined && state.phase === "CLOSE_MERIDIAN") state = reduceClose(state, { type: "FAILED", error: sc.error });
      else if (resumed) state = await this.resolveOnResume(ses, inst);
      await ses.saveState(state);
      const lockWad = ses.rec.meta.lockCollateralWad ?? 0n;
      const a: ExecAdapters = { legs: keyed, ensureCollateral: (p, m) => this.d.ensureCollateral(p, m, lockWad), persist: (s) => ses.saveState(s as EarnRun), sleep: this.d.sleep, maxConfirmTries: this.d.maxConfirmTries ?? 40 };
      state = state.kind === "basis" ? await runBasis(state, a) : await runClose(state, a);
      await ses.saveState(state);
      // fold into the position BEFORE clearing the run (idempotent by id: a kill in between can't count it twice)
      const pos = applyRun(await this.d.positions.load(), state);
      await this.d.positions.save(pos);
      this.position.set(pos);
      await this.d.runs.clear();
      const timeline = buildTimeline(ses.rec, this.d.explorerBase);
      this.store.set({ running: false, timeline, error: undefined, ...(resumed ? { resumed: true } : {}) });
      this.d.afterRun?.();
      return timeline;
    } catch (e) {
      // the outcome of a sent leg isn't known yet (confirm retries ran out) or a venue isn't ready: the run stays
      // stored; resume() picks it up again
      this.store.set({ running: false, timeline: buildTimeline(ses.rec, this.d.explorerBase), error: `Still checking: ${plainTradeError(e instanceof Error ? e.message : String(e))}` });
      return undefined;
    } finally {
      this.running = false;
    }
  }

  /** The Lock's swap close (meta.swapClose), resume-safe through the leg protocol; returns an error when it didn't close in full. */
  private async runSwapClose(ses: EarnSession, legs: LegAdapter, resumed: boolean): Promise<string | undefined> {
    const save = (patch: Partial<NonNullable<EarnMeta["swapClose"]>>) => ses.patchMeta({ swapClose: { ...ses.rec.meta.swapClose!, ...patch } });
    let sc = ses.rec.meta.swapClose!;
    if (resumed && sc.progress.ref === undefined) {
      // a signed swap tx stored before the kill is re-broadcast; otherwise it never went out
      const raw = ses.note(sc.leg.key).raw;
      if (!raw) {
        await save({ error: NOT_SENT_FIRST });
        return NOT_SENT_FIRST;
      }
      await save({ progress: advanceLeg(sc.progress, { type: "PREPARED", ref: keccak256(raw) }) });
    }
    for (;;) {
      sc = ses.rec.meta.swapClose!;
      const act = legAction(sc.leg, sc.progress);
      if (act.type === "prepare") {
        try {
          await save({ progress: advanceLeg(sc.progress, { type: "PREPARED", ref: await legs.prepare(sc.leg) }) });
        } catch (e) {
          const error = plainTradeError(e instanceof Error ? e.message : String(e));
          await save({ error });
          return error;
        }
      } else if (act.type === "send") {
        await legs.send(sc.leg, act.ref).catch(() => undefined); // confirm decides (idempotent by nonce)
        await save({ progress: advanceLeg(sc.progress, { type: "SENT" }) });
      } else {
        let r: Awaited<ReturnType<LegAdapter["confirm"]>> | undefined;
        let last = "";
        for (let i = 0; i < (this.d.maxConfirmTries ?? 40) && !r; i++) {
          try {
            r = await legs.confirm(sc.leg, act.ref);
          } catch (e) {
            last = e instanceof Error ? e.message : String(e);
            await this.d.sleep(1_000);
          }
        }
        if (!r) throw new Error(`confirm ${act.ref}: outcome still unknown (${last}); state kept for resume`);
        if ("failed" in r) {
          const error = `Couldn't close the fixed-rate lock first, so nothing else was sent: ${plainTradeError(r.failed)}`;
          await save({ error });
          return error;
        }
        await save({ filledWad: r.filledWad });
        return r.filledWad < sc.leg.sizeWad ? "The fixed-rate lock closed only partly, so the pair was left open (still hedged). Close again to finish." : undefined;
      }
    }
  }

  private async resolveOnResume(ses: EarnSession, inst: (leg: LegSpec) => KeyedLeg): Promise<EarnRun> {
    const s = ses.rec.state;
    if (s.kind === "basis" && s.phase === "COLLATERAL") return reduceBasis(s, { type: "COLLATERAL_FAILED", error: NOT_SENT_FIRST });
    const act = s.kind === "basis" ? nextBasisAction(s) : nextCloseAction(s);
    if (act.type !== "prepare") return s;
    const first = act.phase === "LEG1_PERPL_IOC" || act.phase === "CLOSE_MERIDIAN";
    const apply = (st: EarnRun, e: LegEvent): EarnRun => (st.kind === "basis" ? reduceBasis(st, e) : reduceClose(st, e));
    const note = ses.note(act.leg.key);
    if (act.leg.venue !== "perpl") {
      // Meridian / swap: a signed tx stored before the kill
      if (note.raw) return apply(s, { type: "PREPARED", ref: keccak256(note.raw) });
      // nothing was broadcast (send comes after the signed tx is stored)
      return first ? apply(s, { type: "FAILED", error: NOT_SENT_FIRST }) : s;
    }
    if (note.rqFloor === undefined) return first ? apply(s, { type: "FAILED", error: NOT_SENT_FIRST }) : s;
    const k = inst(act.leg);
    for (let i = 0; k.findSent && i < (this.d.findTries ?? 10); i++) {
      try {
        const ref = await k.findSent(note.rqFloor, act.leg.side, act.leg.reduceOnly);
        if (ref) {
          await ses.patchLeg(act.leg.key, { ref });
          return apply(apply(s, { type: "PREPARED", ref }), { type: "SENT" });
        }
      } catch {
        // REST hiccup: look again
      }
      await this.d.sleep(1_000);
    }
    // Perpl never saw it: a first leg is cancelled; a later leg counts as failed (its retry / manual path follows)
    await ses.patchLeg(act.leg.key, { error: "Perpl has no record of this order. Nothing filled." });
    return apply(s, { type: "FAILED", error: first ? NOT_SENT_FIRST : "Perpl has no record of this order. Nothing filled." });
  }
}

/** The latest finished run's timeline (the receipt modal shows it; cleared when dismissed). */
export const earnReceiptStore = new Store<EarnTimeline | undefined>(undefined);
