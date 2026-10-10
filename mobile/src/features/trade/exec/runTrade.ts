// One Trade-screen order through core's single-leg machine (exec/single + driver.runSingle), persisted after every
// event. The limit is fixed by the ticket (the worst price the user saw and held to confirm); the QUOTE step only runs
// the collateral preparation (Meridian permit deposit). Resume after a kill (MOBILE_PLAN N5 §5, "never unknown"):
//   QUOTE              → FAILED "closed before sending" (a deposit that landed stays on Meridian; no surprise order)
//   SEND, no ref       → Perpl: the order sent after the recorded rq floor, else FAILED; Meridian: the signed raw tx
//                        (re-broadcast, idempotent by nonce), else FAILED
//   SEND / CONFIRM     → continue: re-broadcast / read the outcome until definitive
import { reduceSingle, runSingle, startSingle, type LegAdapter, type SingleState } from "@meridian/core/exec";
import type { Venue } from "@meridian/core/route";
import { keccak256 } from "viem";
import type { RecordStore, TradeMeta, TradeRecord } from "./record";

export const NOT_SENT = "The app closed before the order was sent. Nothing was placed.";

export type TradeOrder = { id: string; venue: Venue; side: "buy" | "sell"; sizeWad: bigint; reduceOnly: boolean; limitPriceWad: bigint; expectedAvgWad?: bigint };

export function newTradeRecord(o: TradeOrder, meta: TradeMeta): TradeRecord {
  const s = startSingle(o.id, { venue: o.venue, side: o.side, sizeWad: o.sizeWad, reduceOnly: o.reduceOnly });
  return { v: 1, state: { ...s, limitPriceWad: o.limitPriceWad, ...(o.expectedAvgWad !== undefined ? { expectedAvgWad: o.expectedAvgWad } : {}) }, meta };
}

/** The one writer of a trade record: leg callbacks (rq floor, signed tx) and state events go through it, in order. */
export class TradeSession {
  private q: Promise<void> = Promise.resolve();
  constructor(
    public rec: TradeRecord,
    private readonly store: RecordStore,
  ) {}
  private write(): Promise<void> {
    const snap = this.rec;
    this.q = this.q.then(() => this.store.save(snap));
    return this.q;
  }
  saveState(state: SingleState): Promise<void> {
    this.rec = { ...this.rec, state };
    return this.write();
  }
  patchMeta(patch: Partial<TradeMeta>): Promise<void> {
    this.rec = { ...this.rec, meta: { ...this.rec.meta, ...patch } };
    return this.write();
  }
}

export type RunDeps = {
  session: TradeSession;
  legs: LegAdapter;
  /** before anything is sent (Meridian: permit deposit of the shortfall); a throw ⇒ FAILED, nothing sent */
  prepareCollateral?: () => Promise<void>;
  /** Perpl resume: the ref of the order sent after `rqFloor`, if Perpl has it */
  findSentPerpl?: (rqFloor: number, side: "buy" | "sell", reduceOnly: boolean) => Promise<string | undefined>;
  sleep: (ms: number) => Promise<void>;
  maxConfirmTries?: number;
  /** tries for findSentPerpl before concluding "not sent" (1 s apart) */
  findTries?: number;
};

/** Runs a fresh trade (resumed = false) or a persisted one (resumed = true) to DONE / FAILED. */
export async function runTrade(d: RunDeps, resumed: boolean): Promise<TradeRecord> {
  const ses = d.session;
  await ses.saveState(resumed ? await resolveOnResume(ses.rec, d) : ses.rec.state);
  const rec = ses.rec;

  const final = await runSingle(rec.state, {
    legs: d.legs,
    quote: async () => {
      if (resumed) throw new Error(NOT_SENT);
      await d.prepareCollateral?.();
      return { limitPriceWad: rec.state.limitPriceWad!, ...(rec.state.expectedAvgWad !== undefined ? { expectedAvgWad: rec.state.expectedAvgWad } : {}) };
    },
    persist: (s) => ses.saveState(s as SingleState),
    sleep: d.sleep,
    maxConfirmTries: d.maxConfirmTries ?? 40,
  });
  return { ...ses.rec, state: final };
}

async function resolveOnResume(rec: TradeRecord, d: RunDeps): Promise<SingleState> {
  const s = rec.state;
  if (s.phase !== "SEND" || s.leg.ref !== undefined) return s;
  if (rec.meta.venue === "meridian") {
    const raw = rec.meta.meridian?.raw;
    return raw ? reduceSingle(s, { type: "PREPARED", ref: keccak256(raw) }) : reduceSingle(s, { type: "FAILED", error: NOT_SENT });
  }
  const floor = rec.meta.perpl?.rqFloor;
  if (floor === undefined || !d.findSentPerpl) return reduceSingle(s, { type: "FAILED", error: NOT_SENT });
  for (let i = 0; i < (d.findTries ?? 10); i++) {
    try {
      const ref = await d.findSentPerpl(floor, s.order.side, s.order.reduceOnly);
      if (ref) return reduceSingle(reduceSingle(s, { type: "PREPARED", ref }), { type: "SENT" });
    } catch {
      // REST hiccup: look again
    }
    await d.sleep(1_000);
  }
  return reduceSingle(s, { type: "FAILED", error: NOT_SENT });
}

export const isOpenRecord = (r: TradeRecord | undefined): r is TradeRecord => r !== undefined && r.state.phase !== "DONE" && r.state.phase !== "FAILED";
