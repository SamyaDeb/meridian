// Perpl IOC leg for the Trade screen, resume-safe (core exec/leg contract). Core PerplTrading assigns the rq when it
// sends, so `prepare` records the account's last rq (Account.lfr, types.md) BEFORE sending, sends, and returns
// `${rq}:${lb}`; `send` is a no-op. `confirm` takes the live outcome (mt 24) when this process sent the order, and
// otherwise (after a kill, a timeout, a dropped socket) reads signed REST order history (rest-endpoints.md
// /v1/trading/order-history) for that rq: a definitive status ⇒ FILLED / FAILED; not there once the order's last
// execution block `lb` + grace has passed ⇒ FAILED (Perpl never executed it); not there yet ⇒ throw (retry).
// Never "unknown". Fills (fee, block) are reconciled over REST afterwards (mt 25 can trail the outcome).
import type { LegAdapter } from "@meridian/core/exec";
import { explainOrder, lnsToWad, MT, PerplState, pnsToWad, wadToLns, type Fill, type Order, type PerplTrading, type PlaceResult, type SignedRest } from "@meridian/core/perpl";
import { limitPnsOf } from "../../../venues/perpl/ioc";

export type PerplMarketRef = { id: number; priceDecimals: number; sizeDecimals: number };

export type PerplLegDeps = {
  trading: () => PerplTrading | undefined;
  rest: () => SignedRest | undefined;
  market: PerplMarketRef;
  /** leverage ×100 (types.md OrderSpec.lv) */
  leverage100: number;
  /** Perpl's head block (heartbeats), for the lb + grace check */
  head: () => number | undefined;
  /** persist the last rq before sending (the trade record), so a kill mid-send can find the order */
  saveRqFloor: (rq: number | undefined) => Promise<void>;
  /** blocks after lb before "not in history" means "never executed" (websocket.md "Last execution block") */
  graceBlocks?: number;
};

export type PerplFillInfo = { orderId: number | undefined; feeCns: bigint; fillBlock: number | undefined };

export const parseRef = (ref: string): { rq: number; lb: number } => {
  const [rq, lb] = ref.split(":").map(Number);
  if (!Number.isSafeInteger(rq) || !Number.isSafeInteger(lb)) throw new Error(`bad Perpl order ref ${ref}`);
  return { rq: rq!, lb: lb! };
};

export function createPerplLeg(d: PerplLegDeps) {
  const live = new Map<string, Promise<PlaceResult>>();
  let orderId: number | undefined;
  const grace = d.graceBlocks ?? 10;

  /** definitive outcome of `rq` from REST order history; undefined = not there (yet) */
  async function lookup(rq: number): Promise<{ order: Order; failed: boolean } | undefined> {
    const rest = d.rest();
    if (!rest) throw new Error("Perpl isn't connected (unlock and stay in the app)");
    const page = (await rest.orderHistory(50)) as { d?: unknown[] };
    const st = new PerplState(d.market.id);
    for (const raw of page.d ?? []) st.apply({ mt: MT.orders, d: [raw] }, Date.now());
    return st.outcome(rq);
  }

  const asResult = (o: { order: Order; failed: boolean }) => {
    orderId = o.order.oid;
    if (o.failed && o.order.fs === 0) return { failed: explainOrder(o.order) };
    if (o.order.fs === 0) return { failed: "Nothing filled at your price." };
    return { filledWad: lnsToWad(o.order.fs, d.market.sizeDecimals), ...(o.order.fp > 0 ? { avgPriceWad: pnsToWad(o.order.fp, d.market.priceDecimals) } : {}) };
  };

  const legs: LegAdapter = {
    async prepare(leg) {
      const t = d.trading();
      if (!t) throw new Error("Perpl isn't connected yet. Stay on this screen a moment and try again.");
      const sizeLns = Number(wadToLns(leg.sizeWad, d.market.sizeDecimals));
      if (!Number.isSafeInteger(sizeLns) || sizeLns < 1) throw new Error("Size is below Perpl's minimum (1 MON)");
      await d.saveRqFloor(t.state.account?.lfr);
      const p = await t.ioc({ side: leg.side, reduceOnly: leg.reduceOnly, sizeLns, limitPns: limitPnsOf(leg.limitPriceWad, leg.side, d.market.priceDecimals), leverage: d.leverage100 });
      const ref = `${p.rq}:${p.lb}`;
      live.set(ref, p.outcome);
      return ref;
    },
    async send() {
      // sent by prepare (core assigns the rq at send time)
    },
    async confirm(_leg, ref) {
      const { rq, lb } = parseRef(ref);
      const p = live.get(ref);
      if (p) {
        const r = await p;
        if (r.kind === "outcome") return asResult(r.outcome);
        if (r.kind === "rejected") return { failed: `Perpl refused the order (code ${r.code}${r.error ? `: ${r.error}` : ""}). Nothing was placed.` };
        live.delete(ref); // unknown ⇒ fall through to order history
      }
      const found = await lookup(rq);
      if (found) return asResult(found);
      const head = d.head();
      if (lb > 0 && head !== undefined && head > lb + grace) return { failed: "Perpl didn't execute the order before it expired. Nothing filled." };
      throw new Error(`order ${rq} not in Perpl's history yet`);
    },
  };

  /** After a kill between "rq recorded" and "PREPARED persisted": the order we sent, found by rq > floor. */
  async function findSent(rqFloor: number, side: "buy" | "sell", reduceOnly: boolean): Promise<string | undefined> {
    const rest = d.rest();
    if (!rest) throw new Error("Perpl isn't connected");
    const page = (await rest.orderHistory(50)) as { d?: { rq?: unknown; mkt?: unknown; t?: unknown }[] };
    const want = reduceOnly ? (side === "buy" ? 4 : 3) : side === "buy" ? 1 : 2; // types.md OrderType
    const hit = (page.d ?? []).filter((o) => typeof o.rq === "number" && o.rq > rqFloor && o.mkt === d.market.id && o.t === want).sort((a, b) => (a.rq as number) - (b.rq as number))[0];
    return hit ? `${hit.rq as number}:0` : undefined;
  }

  /** GET /v1/trading/fills until the order's fills cover its filled size (fee + fill block for the receipt). */
  async function fills(filledWad: bigint, sleep: (ms: number) => Promise<void>, tries = 5): Promise<PerplFillInfo> {
    const rest = d.rest();
    const want = Number(wadToLns(filledWad, d.market.sizeDecimals));
    let got: Fill[] = [];
    for (let i = 0; rest && orderId !== undefined && i < tries; i++) {
      try {
        const page = (await rest.fills(50)) as { d?: Fill[] };
        got = (page.d ?? []).filter((f) => f.oid === orderId && f.mkt === d.market.id);
        if (got.reduce((a, f) => a + f.s, 0) >= want) break;
      } catch {
        // REST hiccup: try again
      }
      await sleep(1_000);
    }
    return { orderId, feeCns: got.reduce((a, f) => a + BigInt(f.f), 0n), fillBlock: got.map((f) => f.at?.b).filter((b): b is number => b !== undefined).sort((a, b) => b - a)[0] };
  }

  return { legs, findSent, fills, orderId: () => orderId };
}
