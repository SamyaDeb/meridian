// N7 Close all on core's two-leg close machine (fakes, no network): plan from the positions, Meridian first then Perpl
// for exactly what closed, the four outcomes stated exactly, persistence + resume from every phase, the stale rq floor
// never adopted, one order at a time across both executors.
import { reduceClose, startClose, type LegSpec } from "@meridian/core/exec";
import { keccak256, type Hex } from "viem";
import { CloseAllExecutor, closeAllKey, closeAllOutcome, closeAllStore, decodeCloseAll, encodeCloseAll, planBasisClose, planSingleCloses, type CloseAllMarkets, type CloseAllRecord, type CloseLegHooks } from "../../features/trade/exec/closeAll";
import type { Receipt } from "../../features/trade/exec/receipt";
import type { PositionView } from "../../features/trade/positions/views";

const WAD = 10n ** 18n;
const ME = "0x00000000000000000000000000000000000000aa";
const RAW = "0x02f8" as Hex; // an opaque signed-tx stand-in; only its keccak is used as the ref

const view = (venue: "meridian" | "perpl", size: bigint): PositionView => ({ venue, label: venue === "meridian" ? "Meridian" : "Perpl", sizeWad: size * WAD, entryWad: 25n * 10n ** 15n, markWad: 26n * 10n ** 15n, pnlWad: 0n, fundingWad: 0n, liqWad: undefined, distanceBps: undefined, priceDp: venue === "meridian" ? 4 : 5, stepWad: WAD });
const MK: CloseAllMarkets = {
  meridian: { bestBidWad: 26n * 10n ** 15n, bestAskWad: 27n * 10n ** 15n, tickSizeWad: 10n ** 14n },
  perpl: { bestBidWad: 2600n * 10n ** 13n, bestAskWad: 2610n * 10n ** 13n, priceDecimals: 5, sizeDecimals: 0 },
};
const PAIR = [view("meridian", -100n), view("perpl", 100n)]; // short Meridian, long Perpl

function memKv() {
  const map = new Map<string, string>();
  return { map, kv: { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => void map.set(k, v), del: async (k: string) => void map.delete(k) } };
}

type Script = { meridian?: { filled?: bigint; fail?: string }; perpl?: { filled?: bigint; fail?: string }[] };

/** Fake venues: prepare records what was asked; confirm answers from the script. */
function fakeLegs(script: Script, calls: LegSpec[], opts: { findSent?: string; throwOnBuild?: boolean } = {}) {
  let perplTry = 0;
  return (h: CloseLegHooks) => {
    if (opts.throwOnBuild) throw new Error("Perpl isn't available right now");
    return {
      legs: {
        prepare: async (leg: LegSpec) => {
          calls.push(leg);
          if (leg.venue === "meridian") {
            await h.saveRaw(RAW, 7);
            return keccak256(RAW);
          }
          await h.saveRqFloor(41);
          return `${42 + perplTry}:999`;
        },
        send: async () => undefined,
        confirm: async (leg: LegSpec) => {
          if (leg.venue === "meridian") return script.meridian?.fail ? { failed: script.meridian.fail } : { filledWad: script.meridian?.filled ?? leg.sizeWad, avgPriceWad: 26n * 10n ** 15n };
          const s = script.perpl?.[perplTry++] ?? {};
          return s.fail ? { failed: s.fail } : { filledWad: s.filled ?? leg.sizeWad };
        },
      },
      findSentPerpl: async () => opts.findSent,
      perplOrderId: () => 777,
    };
  };
}

function exec(script: Script, o: { busy?: boolean; findSent?: string; throwOnBuild?: boolean; kv?: ReturnType<typeof memKv> } = {}) {
  const kv = o.kv ?? memKv();
  const calls: LegSpec[] = [];
  const receipts: Receipt[] = [];
  const after = jest.fn();
  const ex = new CloseAllExecutor({ store: closeAllStore(kv.kv, 10143, ME), legs: fakeLegs(script, calls, o), busy: () => o.busy ?? false, explorerBase: "https://explorer.invalid", sleep: async () => undefined, onReceipt: (r) => receipts.push(r), afterTrade: after, now: () => 1000, maxConfirmTries: 2, findTries: 1 });
  return { ex, calls, receipts, after, kv };
}

const META = { chainId: 10143, address: ME, meridianPriceDp: 4, perplPriceDp: 5, meridianStepWad: WAD };
const plan = () => {
  const p = planBasisClose(PAIR, MK);
  if ("error" in p) throw new Error(p.error);
  return p;
};

describe("plan", () => {
  it("closing sides are the opposite of each leg; Meridian limit from its best ask + 2 % rounded up to the tick; Perpl ref = its best bid", () => {
    const p = plan().plan;
    expect(p).toMatchObject({ meridianSide: "buy", perplSide: "sell", sizeWad: 100n * WAD, perplRefPriceWad: 2600n * 10n ** 13n, perplSlippageBps: 200n, perplStepWad: WAD });
    expect(p.meridianLimitPriceWad).toBe(276n * 10n ** 14n); // 0.027 × 1.02 = 0.02754 → up to the 0.0001 tick (a buy, against the user): 0.0276
    expect(plan().summary).toBe("Close the basis trade: short 100 MON on Meridian first, then the Perpl long for exactly what closed");
  });
  it("an empty side of either book ⇒ a plain error, nothing planned", () => {
    expect(planBasisClose(PAIR, { ...MK, perpl: { ...MK.perpl, bestBidWad: undefined } })).toEqual({ error: expect.stringMatching(/No bids on Perpl/) });
    expect(planBasisClose(PAIR, { ...MK, meridian: { ...MK.meridian, bestAskWad: undefined } })).toEqual({ error: expect.stringMatching(/No asks on Meridian/) });
    expect(planBasisClose([view("meridian", -100n), view("perpl", 90n)], MK)).toEqual({ error: expect.stringMatching(/hedged pair/) });
  });
  it("unrelated positions: one close each, Meridian first", () => {
    const l = planSingleCloses([view("perpl", 5n), view("meridian", 3n)], MK);
    if ("error" in l) throw new Error(l.error);
    expect(l.map((c) => [c.venue, c.side, c.sizeWad])).toEqual([
      ["meridian", "sell", 3n * WAD],
      ["perpl", "sell", 5n * WAD],
    ]);
    expect(l[0]!.summary).toBe("Close long 3 MON on Meridian · worst price $0.0254");
  });
});

describe("executor", () => {
  it("CLOSED: Meridian first, then Perpl for exactly what closed; receipts for both legs; record cleared", async () => {
    const { ex, calls, receipts, after, kv } = exec({});
    const o = await ex.start(plan(), META);
    expect(calls.map((c) => [c.venue, c.side, c.sizeWad, c.reduceOnly])).toEqual([
      ["meridian", "buy", 100n * WAD, true],
      ["perpl", "sell", 100n * WAD, true],
    ]);
    expect(o).toEqual({ ok: true, title: "Basis trade closed", detail: "Meridian closed 100 MON, then Perpl closed 100 MON. Nothing is left open." });
    expect(receipts.map((r) => [r.venue, r.side, r.reduceOnly, r.filledWad, r.orderId])).toEqual([
      ["meridian", "short", true, 100n * WAD, undefined],
      ["perpl", "long", true, 100n * WAD, 777],
    ]);
    expect(receipts[0]!.txHash).toBe(keccak256(RAW));
    expect(kv.map.size).toBe(0);
    expect(after).toHaveBeenCalledTimes(1);
    expect(ex.store.get().phase).toBe("done");
  });

  it("CLOSED_PARTIAL: a thin Meridian book ⇒ Perpl closes the same, still hedged", async () => {
    const { ex, calls } = exec({ meridian: { filled: 60n * WAD } });
    const o = await ex.start(plan(), META);
    expect(calls[1]!.sizeWad).toBe(60n * WAD);
    expect(o).toEqual({ ok: true, title: "Partly closed", detail: "Meridian's book only took 60 MON of 100 MON; Perpl closed 60 MON. 40 MON stays open on both, still hedged. Try Close all again when the book refills." });
  });

  it("CLOSED_PARTIAL with a finer Meridian lot (0.1) than Perpl's (1): Perpl floors to its lot and the unhedged rest is named", async () => {
    const { ex, calls } = exec({ meridian: { filled: 60n * WAD + WAD / 2n } });
    const o = await ex.start(plan(), { ...META, meridianStepWad: WAD / 10n });
    expect(calls[1]!.sizeWad).toBe(60n * WAD);
    expect(o!.detail).toBe("Meridian's book only took 60.5 MON of 100.0 MON; Perpl closed 60.0 MON. 39.5 MON stays open on Meridian and 40.0 MON on Perpl: 0.5 MON of the Perpl side is unhedged because Perpl trades whole lots. Try Close all again when the book refills.");
  });

  it("ABORTED: Meridian doesn't fill ⇒ Perpl is never touched", async () => {
    const { ex, calls, receipts } = exec({ meridian: { fail: "SlippageExceeded" } });
    const o = await ex.start(plan(), META);
    expect(calls.map((c) => c.venue)).toEqual(["meridian"]);
    expect(o!.ok).toBe(false);
    expect(o!.title).toBe("Nothing closed");
    expect(o!.detail).toMatch(/Perpl wasn't touched/);
    expect(receipts).toEqual([]);
  });

  it("MANUAL: Perpl short twice (retry at 2× slippage) ⇒ the exact unhedged size is named", async () => {
    const { ex, calls } = exec({ perpl: [{ filled: 40n * WAD }, { filled: 10n * WAD }] });
    const o = await ex.start(plan(), META);
    const perpl = calls.filter((c) => c.venue === "perpl");
    expect(perpl.map((c) => c.sizeWad)).toEqual([100n * WAD, 60n * WAD]);
    expect(perpl[1]!.limitPriceWad < perpl[0]!.limitPriceWad).toBe(true); // a sell with more room
    expect(o).toEqual({ ok: false, title: "Perpl needs a manual close", detail: "Meridian closed 100 MON, but Perpl closed only 50 MON of 100 MON after a retry. 50 MON is still open on Perpl alone, unhedged: close it from its card now." });
  });

  it("one order at a time: refused while the single-order executor is busy", async () => {
    const { ex, calls } = exec({}, { busy: true });
    await expect(ex.start(plan(), META)).rejects.toThrow(/Another order/);
    expect(calls).toEqual([]);
  });

  it("a venue that isn't ready ⇒ a fresh close fails plainly; nothing is saved", async () => {
    const { ex, kv } = exec({}, { throwOnBuild: true });
    await expect(ex.start(plan(), META)).rejects.toThrow(/Perpl isn't available/);
    expect(kv.map.size).toBe(0);
    expect(ex.busy).toBe(false);
  });
});

describe("resume after a kill", () => {
  const saved = (kv: ReturnType<typeof memKv>, rec: CloseAllRecord) => kv.kv.set(closeAllKey(10143, ME), encodeCloseAll(rec));
  const base = (): CloseAllRecord => ({ v: 1, state: startClose("c1", plan().plan), meta: { ...META, createdAtMs: 1, summary: "s" } });

  it("CLOSE_MERIDIAN with the signed tx saved ⇒ re-broadcast + confirm (no second order), then Perpl", async () => {
    const kv = memKv();
    await saved(kv, { ...base(), meta: { ...base().meta, meridian: { raw: RAW, nonce: 7 } } });
    const { ex, calls } = exec({}, { kv });
    const o = await ex.resume();
    expect(calls.map((c) => c.venue)).toEqual(["perpl"]); // Meridian wasn't prepared (signed) again
    expect(o!.title).toBe("Basis trade closed");
  });

  it("CLOSE_MERIDIAN with nothing signed ⇒ ABORTED, nothing sent", async () => {
    const kv = memKv();
    await saved(kv, base());
    const { ex, calls } = exec({}, { kv });
    const o = await ex.resume();
    expect(calls).toEqual([]);
    expect(o!.title).toBe("Nothing closed");
  });

  it("CLOSE_PERPL with an rq floor ⇒ the order sent after it is adopted (no second Perpl order)", async () => {
    const kv = memKv();
    let st = reduceClose(base().state, { type: "PREPARED", ref: keccak256(RAW) });
    st = reduceClose(st, { type: "SENT" });
    st = reduceClose(st, { type: "FILLED", filledWad: 100n * WAD });
    await saved(kv, { ...base(), state: st, meta: { ...base().meta, perpl: { rqFloor: 41 } } });
    const { ex, calls } = exec({}, { kv, findSent: "42:0" });
    const o = await ex.resume();
    expect(calls).toEqual([]);
    expect(o!.title).toBe("Basis trade closed");
  });

  it("CLOSE_PERPL without an rq floor ⇒ not sent ⇒ the retry sends it (the hedge must close)", async () => {
    const kv = memKv();
    let st = reduceClose(base().state, { type: "PREPARED", ref: keccak256(RAW) });
    st = reduceClose(reduceClose(st, { type: "SENT" }), { type: "FILLED", filledWad: 100n * WAD });
    await saved(kv, { ...base(), state: st });
    const { ex, calls } = exec({}, { kv });
    const o = await ex.resume();
    expect(calls.map((c) => [c.venue, c.key])).toEqual([["perpl", "c1:close-p2"]]);
    expect(o!.title).toBe("Basis trade closed");
  });

  it("the rq floor is cleared when the phase moves on (a stale floor would adopt the previous attempt's order)", async () => {
    const kv = memKv();
    const { ex } = exec({ perpl: [{ fail: "nothing at your price" }, {}] }, { kv });
    const writes: (CloseAllRecord | undefined)[] = [];
    const orig = kv.kv.set;
    kv.kv.set = async (k: string, v: string) => {
      writes.push(decodeCloseAll(v));
      return orig(k, v);
    };
    await ex.start(plan(), META);
    const retryFirst = writes.find((w) => w?.state.phase === "CLOSE_PERPL_RETRY");
    expect(retryFirst!.meta.perpl).toEqual({});
  });

  it("garbage or a foreign record never drives an order", () => {
    expect(decodeCloseAll("{nope")).toBeUndefined();
    expect(decodeCloseAll(JSON.stringify({ v: 2 }))).toBeUndefined();
  });
});

it("outcome text for a state still in flight", () => {
  expect(closeAllOutcome(startClose("x", plan().plan), WAD).title).toBe("Still closing…");
});
