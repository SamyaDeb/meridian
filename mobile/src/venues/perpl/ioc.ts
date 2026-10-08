// One Perpl IOC through core's single-leg machine (exec/single + driver.runSingle): QUOTE (slippage-capped limit from
// the live book) → SEND → CONFIRM (first definitive mt 24 for the rq) → DONE | FAILED, then the fills reconciled over
// signed REST (mt 25 may arrive after the outcome; perpl-api skill §5). Used by the dev trade smoke (N4) and N5.
//
// Leg adapter note: core PerplTrading assigns the rq when it sends, so `prepare` sends and returns that rq and `send`
// is a no-op. The state is not persisted across an app kill here (dev smoke); N5 owns resume for the Trade screen.
import { limitFrom, runSingle, startSingle, type LegAdapter, type SingleState } from "@meridian/core/exec";
import { explainOrder, lnsToWad, pnsToWad, wadToPns, type Fill, type PerplTrading, type PlaceResult, type SignedRest } from "@meridian/core/perpl";
import { SMALLEST_LNS } from "./amounts";

export type IocMarket = { id: number; priceDecimals: number; sizeDecimals: number };

export type IocRequest = {
  side: "buy" | "sell";
  reduceOnly: boolean;
  /** size in LNS, ≥ one size unit */
  sizeLns: number;
  slippageBps: bigint;
  /** leverage ×100 (types.md OrderSpec.lv) */
  leverage: number;
};

export type IocFill = { oid: number; priceWad: bigint | undefined; sizeLns: number; feeCns: bigint; block: number | undefined; maker: boolean };

export type IocResult = {
  state: SingleState;
  rq: number | undefined;
  orderId: number | undefined;
  /** the limit sent, PNS */
  limitPns: number | undefined;
  filledLns: number;
  avgPriceWad: bigint | undefined;
  /** gross fee from the fills (collateral units; negative = rebate) */
  feeCns: bigint;
  fills: IocFill[];
  error: string | undefined;
};

export type IocDeps = {
  trading: PerplTrading;
  rest: SignedRest;
  market: IocMarket;
  /** best bid / ask WAD right now (the N2 market-data feed) */
  book: () => { bidWad: bigint | undefined; askWad: bigint | undefined };
  sleep: (ms: number) => Promise<void>;
  /** REST fill reconcile attempts after the outcome (default 5, 1 s apart) */
  fillTries?: number;
};

/** A buy's limit rounds up to the price step, a sell's down (never worse than the slippage cap). */
export const limitPnsOf = (limitWad: bigint, side: "buy" | "sell", priceDecimals: number): number => Number(wadToPns(limitWad, priceDecimals, side === "buy" ? "up" : "down"));

export async function runIoc(req: IocRequest, d: IocDeps): Promise<IocResult> {
  if (!Number.isSafeInteger(req.sizeLns) || req.sizeLns < SMALLEST_LNS) throw new RangeError("size below one lot");
  const placed = new Map<string, { rq: number; outcome: Promise<PlaceResult>; limitPns: number }>();
  let orderId: number | undefined;

  const legs: LegAdapter = {
    async prepare(leg) {
      const limitPns = limitPnsOf(leg.limitPriceWad, leg.side, d.market.priceDecimals);
      const p = await d.trading.ioc({ side: leg.side, reduceOnly: leg.reduceOnly, sizeLns: req.sizeLns, limitPns, leverage: req.leverage });
      placed.set(String(p.rq), { rq: p.rq, outcome: p.outcome, limitPns });
      return String(p.rq);
    },
    async send() {
      // sent by prepare (core assigns the rq at send time)
    },
    async confirm(_leg, ref) {
      const p = placed.get(ref);
      if (!p) return { failed: "order state lost (app restarted); check Perpl history" };
      const r = await p.outcome;
      if (r.kind === "rejected") return { failed: `Perpl refused the order (code ${r.code}${r.error ? `: ${r.error}` : ""})` };
      if (r.kind === "unknown") return { failed: `No answer from Perpl (${r.reason}). Check Portfolio before retrying.` };
      const o = r.outcome.order;
      orderId = o.oid;
      if (r.outcome.failed && o.fs === 0) return { failed: explainOrder(o) };
      return { filledWad: lnsToWad(o.fs, d.market.sizeDecimals), ...(o.fs > 0 && o.fp > 0 ? { avgPriceWad: pnsToWad(o.fp, d.market.priceDecimals) } : {}) };
    },
  };

  const s0 = startSingle(`smoke-${Date.now()}`, { venue: "perpl", side: req.side, sizeWad: lnsToWad(req.sizeLns, d.market.sizeDecimals), reduceOnly: req.reduceOnly });
  const state = await runSingle(s0, {
    legs,
    quote: async (order) => {
      const b = d.book();
      const ref = order.side === "buy" ? b.askWad : b.bidWad;
      if (ref === undefined) throw new Error(`No ${order.side === "buy" ? "asks" : "bids"} on Perpl right now`);
      return { limitPriceWad: limitFrom(ref, order.side, req.slippageBps), expectedAvgWad: ref };
    },
    persist: () => undefined,
    sleep: d.sleep,
    maxConfirmTries: 1,
  });

  const ref = state.leg.ref;
  const p = ref ? placed.get(ref) : undefined;
  const filledLns = state.result ? Number(state.result.filledWad / lnsToWad(1, d.market.sizeDecimals)) : 0;
  const fills = orderId !== undefined && filledLns > 0 ? await reconcileFills(d, orderId, filledLns) : [];
  return {
    state,
    rq: p?.rq,
    orderId,
    limitPns: p?.limitPns,
    filledLns,
    avgPriceWad: state.result?.avgPriceWad,
    feeCns: fills.reduce((a, f) => a + f.feeCns, 0n),
    fills,
    error: state.phase === "FAILED" ? state.error : undefined,
  };
}

/** GET /v1/trading/fills until the order's fills add up to its filled size (or tries run out). */
async function reconcileFills(d: IocDeps, oid: number, filledLns: number): Promise<IocFill[]> {
  const tries = d.fillTries ?? 5;
  let got: IocFill[] = [];
  for (let i = 0; i < tries; i++) {
    try {
      const page = (await d.rest.fills(50)) as { d?: Fill[] };
      got = (page.d ?? [])
        .filter((f) => f.oid === oid && f.mkt === d.market.id)
        .map((f) => ({ oid: f.oid, priceWad: f.p !== undefined ? pnsToWad(f.p, d.market.priceDecimals) : undefined, sizeLns: f.s, feeCns: BigInt(f.f), block: f.at?.b, maker: f.l === 1 }));
      if (got.reduce((a, f) => a + f.sizeLns, 0) >= filledLns) return got;
    } catch {
      // REST hiccup: try again
    }
    await d.sleep(1_000);
  }
  return got;
}
