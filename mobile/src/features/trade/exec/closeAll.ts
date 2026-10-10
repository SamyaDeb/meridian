// Close all (MOBILE_PLAN N7 §2, research §5.2): a basis pair (one Meridian + one Perpl position, equal and opposite)
// closes through core's two-leg close machine (exec/close + driver.runClose): Meridian reduce-only first (its fill is
// certain onchain), then Perpl reduce-only IOC for EXACTLY what Meridian closed, a Perpl shortfall retried once at 2×
// slippage, else MANUAL. So the pair never holds more one-sided exposure than the Perpl shortfall, and that is named.
// Persisted after every event (one record per chain + wallet, SecureStore, non-secret: sides, sizes, a signed tx, rq
// numbers) and resumed on launch with the same rules as a single trade (runTrade.ts):
//   CLOSE_MERIDIAN, no ref → the signed raw tx (re-broadcast, idempotent by nonce), else FAILED ⇒ ABORTED (nothing sent)
//   CLOSE_PERPL*,   no ref → the order sent after the recorded rq floor, else FAILED ⇒ the retry / MANUAL path
// The rq floor is cleared on every phase change, so a resume can never adopt the previous Perpl attempt's order.
import { deserializeExec, isCloseTerminal, reduceClose, runClose, serializeExec, startClose, type CloseExecPlan, type CloseExecState, type LegAdapter } from "@meridian/core/exec";
import { parseBig, stringifyBig } from "@meridian/core/util";
import { keccak256, type Hex } from "viem";
import { Store } from "../../../live/store";
import type { KV } from "../../../auth/credentialStore";
import { planClose, CLOSE_SLIPPAGE_BPS } from "../positions/close";
import type { PositionView } from "../positions/views";
import { priceText, sizeText } from "../ticket/quote";
import { plainTradeError } from "./errors";
import type { Receipt } from "./receipt";
import { NOT_SENT } from "./runTrade";

// ── plan ──

export type CloseAllMarkets = {
  meridian: { bestBidWad: bigint | undefined; bestAskWad: bigint | undefined; tickSizeWad: bigint | undefined };
  perpl: { bestBidWad: bigint | undefined; bestAskWad: bigint | undefined; priceDecimals: number; sizeDecimals: number };
};

export type BasisClosePlan = { plan: CloseExecPlan; meridian: PositionView; perpl: PositionView; summary: string };

/** The two-leg plan for an equal and opposite Meridian + Perpl pair; an error in plain words if a book is empty. */
export function planBasisClose(views: readonly PositionView[], mk: CloseAllMarkets): BasisClosePlan | { error: string } {
  const m = views.find((v) => v.venue === "meridian");
  const p = views.find((v) => v.venue === "perpl");
  if (!m || !p || m.sizeWad !== -p.sizeWad) return { error: "These positions aren't a hedged pair." };
  const mc = planClose({ venue: "meridian", sizeWad: m.sizeWad, bestBidWad: mk.meridian.bestBidWad, bestAskWad: mk.meridian.bestAskWad, priceStepWad: mk.meridian.tickSizeWad ?? 1n });
  if ("error" in mc) return mc;
  const perplSide = p.sizeWad > 0n ? "sell" : "buy";
  const ref = perplSide === "sell" ? mk.perpl.bestBidWad : mk.perpl.bestAskWad;
  if (ref === undefined) return { error: `No ${perplSide === "sell" ? "bids" : "asks"} on Perpl right now, so the hedge can't be closed at a fair price. Try again in a moment.` };
  const size = mc.sizeWad;
  return {
    plan: { meridianSide: mc.side, perplSide, sizeWad: size, meridianLimitPriceWad: mc.limitPriceWad, perplRefPriceWad: ref, perplSlippageBps: CLOSE_SLIPPAGE_BPS, perplStepWad: 10n ** BigInt(18 - mk.perpl.sizeDecimals) },
    meridian: m,
    perpl: p,
    summary: `Close the basis trade: ${m.sizeWad > 0n ? "long" : "short"} ${sizeText(size, m.stepWad)} MON on Meridian first, then the Perpl ${p.sizeWad > 0n ? "long" : "short"} for exactly what closed`,
  };
}

// ── record ──

export type CloseAllMeta = {
  chainId: number;
  address: string;
  createdAtMs: number;
  summary: string;
  meridianPriceDp: number;
  perplPriceDp: number;
  meridianStepWad: bigint;
  /** the Meridian leg's signed tx (resume) */
  meridian?: { raw?: Hex; nonce?: number };
  /** the Perpl attempt's rq floor (resume); cleared on every phase change */
  perpl?: { rqFloor?: number };
};

export type CloseAllRecord = { v: 1; state: CloseExecState; meta: CloseAllMeta };

export const closeAllKey = (chainId: number, address: string) => `meridian.trade.closeall.${chainId}.${address.toLowerCase()}`;

export const encodeCloseAll = (r: CloseAllRecord): string => stringifyBig({ v: 1, exec: serializeExec(r.state), meta: r.meta });

export function decodeCloseAll(text: string | null | undefined): CloseAllRecord | undefined {
  if (!text) return undefined;
  try {
    const o = parseBig(text) as { v?: unknown; exec?: unknown; meta?: unknown };
    if (o.v !== 1 || typeof o.exec !== "string" || typeof o.meta !== "object" || o.meta === null) return undefined;
    const state = deserializeExec(o.exec);
    if (state.kind !== "close") return undefined;
    const meta = o.meta as CloseAllMeta;
    if (typeof meta.address !== "string" || typeof meta.chainId !== "number" || typeof meta.meridianStepWad !== "bigint") return undefined;
    return { v: 1, state, meta };
  } catch {
    return undefined;
  }
}

export type CloseAllStore = { load(): Promise<CloseAllRecord | undefined>; save(r: CloseAllRecord): Promise<void>; clear(): Promise<void> };

export function closeAllStore(kv: KV, chainId: number, address: string): CloseAllStore {
  const key = closeAllKey(chainId, address);
  return { load: async () => decodeCloseAll(await kv.get(key)), save: (r) => kv.set(key, encodeCloseAll(r)), clear: () => kv.del(key) };
}

// ── outcome ──

export type CloseAllOutcome = { ok: boolean; title: string; detail: string };

/** What happened, in plain words, from the terminal state (the user's exposure stated exactly). */
export function closeAllOutcome(s: CloseExecState, stepWad: bigint): CloseAllOutcome {
  const mon = (w: bigint) => `${sizeText(w, stepWad)} MON`;
  const mFilled = s.meridian?.filledWad ?? 0n;
  const why = s.errors.length ? plainTradeError(s.errors[s.errors.length - 1]!.replace(/^[A-Z_]+: /, "")) : undefined;
  switch (s.phase) {
    case "CLOSED":
      return { ok: true, title: "Basis trade closed", detail: `Meridian closed ${mon(mFilled)}, then Perpl closed ${mon(s.perpl.filledWad)}. Nothing is left open.` };
    case "CLOSED_PARTIAL": {
      const leftM = s.plan.sizeWad - mFilled;
      const leftP = s.plan.sizeWad - s.perpl.filledWad;
      const left =
        leftM === leftP
          ? `${mon(leftM)} stays open on both, still hedged.`
          : `${mon(leftM)} stays open on Meridian and ${mon(leftP)} on Perpl: ${mon(leftP - leftM)} of the Perpl side is unhedged because Perpl trades whole lots.`;
      return { ok: true, title: "Partly closed", detail: `Meridian's book only took ${mon(mFilled)} of ${mon(s.plan.sizeWad)}; Perpl closed ${mon(s.perpl.filledWad)}. ${left} Try Close all again when the book refills.` };
    }
    case "ABORTED":
      return { ok: false, title: "Nothing closed", detail: `${why ? `${why} ` : ""}Meridian didn't fill, so Perpl wasn't touched. Both positions are as they were.` };
    case "MANUAL":
      return { ok: false, title: "Perpl needs a manual close", detail: `Meridian closed ${mon(mFilled)}, but Perpl closed only ${mon(s.perpl.filledWad)} of ${mon(s.perpl.targetWad)} after a retry${why ? ` (${why})` : ""}. ${mon(s.perpl.targetWad - s.perpl.filledWad)} is still open on Perpl alone, unhedged: close it from its card now.` };
    default:
      return { ok: false, title: "Still closing…", detail: "The close is still being checked. It resumes if the app restarts." };
  }
}

// ── executor ──

export type CloseLegHooks = {
  saveRaw: (raw: Hex, nonce: number) => Promise<void>;
  loadRaw: () => { raw?: Hex; nonce?: number };
  saveRqFloor: (rq: number | undefined) => Promise<void>;
};

/** One adapter for both venues (dispatch on leg.venue) + what the receipts need afterwards. */
export type CloseLegs = {
  legs: LegAdapter;
  findSentPerpl: (rqFloor: number, side: "buy" | "sell", reduceOnly: boolean) => Promise<string | undefined>;
  perplOrderId: () => number | undefined;
};

export type CloseAllDeps = {
  store: CloseAllStore;
  legs: (h: CloseLegHooks) => CloseLegs;
  /** another executor (Trade ticket / single close, Earn) is running: why, in plain words (exec/orderLock.ts) */
  blocked: () => string | undefined;
  explorerBase: string | undefined;
  sleep: (ms: number) => Promise<void>;
  onReceipt?: (r: Receipt) => void;
  afterTrade: () => void;
  now?: () => number;
  maxConfirmTries?: number;
  findTries?: number;
};

export type CloseAllState = { phase: "idle" | "running" | "done"; outcome: CloseAllOutcome | undefined; state: CloseExecState | undefined };

export class CloseAllExecutor {
  readonly store = new Store<CloseAllState>({ phase: "idle", outcome: undefined, state: undefined });
  private running = false;

  constructor(private readonly d: CloseAllDeps) {}

  get busy(): boolean {
    return this.running;
  }

  async start(p: BasisClosePlan, meta: Omit<CloseAllMeta, "createdAtMs" | "summary">): Promise<CloseAllOutcome | undefined> {
    if (this.running) throw new Error("Close all is already going through");
    const why = this.d.blocked();
    if (why) throw new Error(why);
    const now = (this.d.now ?? Date.now)();
    const rec: CloseAllRecord = { v: 1, state: startClose(`c${now}`, p.plan), meta: { ...meta, createdAtMs: now, summary: p.summary } };
    return this.run(rec, false);
  }

  /** Launch / unlock: a close an app kill left open runs to a terminal phase. */
  async resume(): Promise<CloseAllOutcome | undefined> {
    if (this.running) return undefined;
    const rec = await this.d.store.load();
    if (!rec) return undefined;
    if (isCloseTerminal(rec.state)) {
      await this.d.store.clear();
      return undefined;
    }
    if (this.running || this.d.blocked()) return undefined; // one order at a time: picked up on the next resume
    return this.run(rec, true);
  }

  reset(): void {
    if (!this.running) this.store.set({ phase: "idle", outcome: undefined, state: undefined });
  }

  private async run(rec0: CloseAllRecord, resumed: boolean): Promise<CloseAllOutcome | undefined> {
    let rec = rec0;
    let q: Promise<void> = Promise.resolve();
    const write = (): Promise<void> => {
      const snap = rec;
      q = q.then(() => this.d.store.save(snap));
      return q;
    };
    const hooks: CloseLegHooks = {
      saveRaw: (raw, nonce) => {
        rec = { ...rec, meta: { ...rec.meta, meridian: { raw, nonce } } };
        return write();
      },
      loadRaw: () => rec.meta.meridian ?? {},
      saveRqFloor: (rq) => {
        rec = { ...rec, meta: { ...rec.meta, perpl: rq !== undefined ? { rqFloor: rq } : {} } };
        return write();
      },
    };
    let legs: CloseLegs;
    try {
      legs = this.d.legs(hooks);
    } catch (e) {
      // a venue isn't ready (socket, market statics): a fresh close says why (nothing was sent or saved); an open
      // record waits for the next resume()
      if (resumed) return undefined;
      throw e;
    }
    this.running = true;
    this.store.set({ phase: "running", outcome: undefined, state: rec.state });
    try {
      if (resumed) {
        const st = await this.resolveOnResume(rec, legs);
        rec = { ...rec, state: st, meta: st.phase !== rec.state.phase ? { ...rec.meta, perpl: {} } : rec.meta };
      }
      await write();
      const final = await runClose(rec.state, {
        legs: legs.legs,
        persist: (s) => {
          const st = s as CloseExecState;
          const moved = st.phase !== rec.state.phase;
          rec = { ...rec, state: st, meta: moved ? { ...rec.meta, perpl: {} } : rec.meta };
          this.store.update({ state: st });
          return write();
        },
        sleep: this.d.sleep,
        maxConfirmTries: this.d.maxConfirmTries ?? 40,
      });
      rec = { ...rec, state: final };
      const outcome = closeAllOutcome(final, rec.meta.meridianStepWad);
      for (const r of this.receipts(rec, legs)) this.d.onReceipt?.(r);
      await q;
      await this.d.store.clear();
      this.store.set({ phase: "done", outcome, state: final });
      this.d.afterTrade();
      return outcome;
    } catch (e) {
      // outcome not known yet (confirm retries ran out, venue not ready): the record stays for the next resume
      const msg = plainTradeError(e instanceof Error ? e.message : String(e));
      this.store.set({ phase: "done", outcome: { ok: false, title: "Still checking the close", detail: `${msg} Nothing is lost: it continues when the app restarts.` }, state: rec.state });
      return undefined;
    } finally {
      this.running = false;
    }
  }

  private async resolveOnResume(rec: CloseAllRecord, legs: CloseLegs): Promise<CloseExecState> {
    const s = rec.state;
    if (s.leg.ref !== undefined) return s;
    if (s.phase === "CLOSE_MERIDIAN") {
      const raw = rec.meta.meridian?.raw;
      return raw ? reduceClose(s, { type: "PREPARED", ref: keccak256(raw) }) : reduceClose(s, { type: "FAILED", error: NOT_SENT });
    }
    const floor = rec.meta.perpl?.rqFloor;
    if (floor !== undefined) {
      for (let i = 0; i < (this.d.findTries ?? 10); i++) {
        try {
          const ref = await legs.findSentPerpl(floor, s.plan.perplSide, true);
          if (ref) return reduceClose(reduceClose(s, { type: "PREPARED", ref }), { type: "SENT" });
        } catch {
          // REST hiccup: look again
        }
        await this.d.sleep(1_000);
      }
    }
    return reduceClose(s, { type: "FAILED", error: NOT_SENT });
  }

  /** A receipt per leg that filled (Activity lists them; the Perpl one dedupes with its fills by order id). */
  private receipts(rec: CloseAllRecord, legs: CloseLegs): Receipt[] {
    const s = rec.state;
    const out: Receipt[] = [];
    const explorer = this.d.explorerBase?.replace(/\/+$/, "");
    const mFilled = s.meridian?.filledWad ?? 0n;
    // a closing buy closes a short (the receipt's side is the position's side, as useStartOrder)
    const posSide = (closing: "buy" | "sell") => (closing === "buy" ? "short" : "long") as Receipt["side"];
    if (mFilled > 0n) {
      const tx = rec.meta.meridian?.raw ? keccak256(rec.meta.meridian.raw) : undefined;
      out.push({ ok: true, venue: "meridian", side: posSide(s.plan.meridianSide), reduceOnly: true, summary: `Closed ${posSide(s.plan.meridianSide)} ${sizeText(mFilled, rec.meta.meridianStepWad)} MON on Meridian (basis close)`, filledWad: mFilled, stepWad: rec.meta.meridianStepWad, avgPriceWad: s.meridian?.avgPriceWad, priceDp: rec.meta.meridianPriceDp, feeWad: undefined, orderId: undefined, txHash: tx, explorerTxUrl: tx && explorer ? `${explorer}/tx/${tx}` : undefined, blocksToFill: undefined, error: undefined });
    }
    if (s.perpl.filledWad > 0n) {
      out.push({ ok: true, venue: "perpl", side: posSide(s.plan.perplSide), reduceOnly: true, summary: `Closed ${posSide(s.plan.perplSide)} ${sizeText(s.perpl.filledWad, s.plan.perplStepWad)} MON on Perpl (basis close)`, filledWad: s.perpl.filledWad, stepWad: s.plan.perplStepWad, avgPriceWad: undefined, priceDp: rec.meta.perplPriceDp, feeWad: undefined, orderId: legs.perplOrderId(), txHash: undefined, explorerTxUrl: undefined, blocksToFill: undefined, error: undefined });
    }
    return out;
  }
}

// ── unrelated positions ──

export type SingleClose = { venue: PositionView["venue"]; side: "buy" | "sell"; sizeWad: bigint; limitPriceWad: bigint; summary: string };

/** Positions that aren't a hedged pair close one by one, Meridian first; a book with no other side ⇒ that error. */
export function planSingleCloses(views: readonly PositionView[], mk: CloseAllMarkets): SingleClose[] | { error: string } {
  const out: SingleClose[] = [];
  for (const v of [...views].sort((a, b) => (a.venue === b.venue ? 0 : a.venue === "meridian" ? -1 : 1))) {
    const book = v.venue === "meridian" ? mk.meridian : mk.perpl;
    const step = v.venue === "meridian" ? (mk.meridian.tickSizeWad ?? 1n) : 10n ** BigInt(18 - mk.perpl.priceDecimals);
    const c = planClose({ venue: v.venue, sizeWad: v.sizeWad, bestBidWad: book.bestBidWad, bestAskWad: book.bestAskWad, priceStepWad: step });
    if ("error" in c) return c;
    out.push({ venue: v.venue, side: c.side, sizeWad: c.sizeWad, limitPriceWad: c.limitPriceWad, summary: `Close ${v.sizeWad > 0n ? "long" : "short"} ${sizeText(c.sizeWad, v.stepWad)} MON on ${v.label} · worst price ${priceText(c.limitPriceWad, v.priceDp)}` });
  }
  return out;
}
