// Runs Trade-screen orders for one unlocked wallet: builds the venue leg, persists every step (record.ts), turns the
// terminal state into a receipt, and on launch resumes a trade an app kill left open. One trade at a time.
import type { LegAdapter } from "@meridian/core/exec";
import type { Venue } from "@meridian/core/route";
import { Store } from "../../../live/store";
import { plainTradeError } from "./errors";
import { buildReceipt, receiptStore, type Receipt, type ReceiptFacts } from "./receipt";
import type { RecordStore, TradeMeta, TradeRecord } from "./record";
import { isOpenRecord, newTradeRecord, runTrade, TradeSession, type TradeOrder } from "./runTrade";

export type ExecPhase = "idle" | "preparing" | "sending" | "confirming" | "checking" | "done" | "failed";
export type ExecState = { phase: ExecPhase; venue: Venue | undefined; error: string | undefined; receipt: Receipt | undefined };

/** What a venue contributes to one run (built fresh per run, so a resumed run starts with nothing in memory). */
export type VenueRun = {
  legs: LegAdapter;
  prepareCollateral?: () => Promise<void>;
  findSentPerpl?: (rqFloor: number, side: "buy" | "sell", reduceOnly: boolean) => Promise<string | undefined>;
  /** after a terminal state: venue facts for the receipt (fills, tx, blocks) */
  facts: (rec: TradeRecord) => Promise<Partial<ReceiptFacts>>;
};

export type ExecutorDeps = {
  store: RecordStore;
  venueRun: (session: TradeSession, rec: TradeRecord) => VenueRun;
  head: () => bigint | undefined;
  explorerBase: string | undefined;
  collateralDecimals: number;
  sleep: (ms: number) => Promise<void>;
  /** accounts / Perpl state to re-read after a fill */
  afterTrade: () => void;
  /** another executor owns the venues (Close all, Earn: exec/orderLock.ts): why, in plain words */
  blocked?: () => string | undefined;
  /** every terminal receipt (Activity keeps them) */
  onReceipt?: (r: Receipt) => void;
  now?: () => number;
};

export class TradeExecutor {
  readonly store = new Store<ExecState>({ phase: "idle", venue: undefined, error: undefined, receipt: undefined });
  private running = false;

  constructor(private readonly d: ExecutorDeps) {}

  get busy(): boolean {
    return this.running;
  }

  /** A ticket the user held to confirm. Resolves with the receipt (also published to receiptStore). */
  async start(order: Omit<TradeOrder, "id">, meta: Omit<TradeMeta, "createdAtMs" | "sentAtBlock">): Promise<Receipt | undefined> {
    if (this.running) throw new Error("Another order is still going through");
    const why = this.d.blocked?.();
    if (why) throw new Error(why);
    const now = (this.d.now ?? Date.now)();
    const head = this.d.head();
    const rec = newTradeRecord({ ...order, id: `t${now}` }, { ...meta, createdAtMs: now, ...(head !== undefined ? { sentAtBlock: head } : {}) });
    return this.run(rec, false);
  }

  /** Launch / unlock: an open trade from before an app kill runs to DONE / FAILED. */
  async resume(): Promise<Receipt | undefined> {
    if (this.running) return undefined;
    const rec = await this.d.store.load();
    if (!rec) return undefined;
    if (!isOpenRecord(rec)) {
      await this.d.store.clear();
      return undefined;
    }
    // another executor is running: the record stays for the next resume (one order at a time)
    if (this.running || this.d.blocked?.()) return undefined;
    return this.run(rec, true);
  }

  private async run(rec: TradeRecord, resumed: boolean): Promise<Receipt | undefined> {
    const session = new TradeSession(rec, {
      load: this.d.store.load,
      clear: this.d.store.clear,
      save: async (r) => {
        await this.d.store.save(r);
        const p = r.state.phase;
        if (!resumed && (p === "SEND" || p === "CONFIRM")) this.store.update({ phase: p === "SEND" ? "sending" : "confirming" });
      },
    });
    let v: VenueRun;
    try {
      v = this.d.venueRun(session, rec);
    } catch (e) {
      // venue not ready (socket, market statics): a fresh order says why; an open record waits for the next resume()
      if (resumed) return undefined;
      throw e;
    }
    this.running = true;
    this.store.set({ phase: resumed ? "checking" : "preparing", venue: rec.meta.venue, error: undefined, receipt: undefined });
    try {
      const out = await runTrade({ session, legs: v.legs, ...(v.prepareCollateral ? { prepareCollateral: v.prepareCollateral } : {}), ...(v.findSentPerpl ? { findSentPerpl: v.findSentPerpl } : {}), sleep: this.d.sleep }, resumed);
      let facts: Partial<ReceiptFacts> = {};
      try {
        facts = await v.facts(out);
      } catch {
        // the fill stands; the receipt shows "—" for what couldn't be read
      }
      const receipt = buildReceipt(out.state, {
        venue: out.meta.venue,
        side: out.meta.side,
        summary: out.meta.summary,
        stepWad: out.meta.stepWad,
        priceDp: out.meta.priceDp,
        takerFeeWad: out.meta.takerFeeWad,
        explorerBase: this.d.explorerBase,
        sentAtBlock: out.meta.sentAtBlock,
        collateralDecimals: this.d.collateralDecimals,
        ...facts,
      });
      await this.d.store.clear();
      this.store.set({ phase: receipt.ok ? "done" : "failed", venue: out.meta.venue, error: receipt.error, receipt });
      receiptStore.set(receipt);
      this.d.onReceipt?.(receipt);
      this.d.afterTrade();
      return receipt;
    } catch (e) {
      // the outcome isn't known yet (confirm retries ran out): the record stays; resume() picks it up again
      this.store.set({ phase: "checking", venue: rec.meta.venue, error: `Still checking the order: ${plainTradeError(e instanceof Error ? e.message : String(e))}`, receipt: undefined });
      return undefined;
    } finally {
      this.running = false;
    }
  }

  /** The sheet closed after a result: back to idle (the receipt stays in receiptStore until dismissed). */
  reset(): void {
    if (!this.running) this.store.set({ phase: "idle", venue: undefined, error: undefined, receipt: undefined });
  }
}
