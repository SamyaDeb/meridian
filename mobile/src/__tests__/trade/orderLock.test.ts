// One order at a time across the Trade executor (ticket, single close, Earn's leftover close), Close all and Earn
// (exec/orderLock.ts), with the REAL executors on gated fakes (no network): while any one runs, every other entry point
// refuses with a plain line; resume after an unlock runs single → Close all → Earn, one at a time, awaited.
import { startBasis, startClose, type LegAdapter, type LegSpec } from "@meridian/core/exec";
import { keccak256, type Hex } from "viem";
import { EarnExecutor } from "../../features/earn/executor";
import { earnRecordStore, encodeEarnRecord, positionStore } from "../../features/earn/record";
import { CloseAllExecutor, closeAllStore, encodeCloseAll, planBasisClose } from "../../features/trade/exec/closeAll";
import { TradeExecutor } from "../../features/trade/exec/executor";
import { BUSY_TEXT, OrderLock, type OrderKind } from "../../features/trade/exec/orderLock";
import { recordStore } from "../../features/trade/exec/record";
import type { PositionView } from "../../features/trade/positions/views";

const WAD = 10n ** 18n;
const ME = "0x00000000000000000000000000000000000000aa";
const RAW = "0x02f8" as Hex;

function memKv() {
  const m = new Map<string, string>();
  return { m, kv: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), del: async (k: string) => void m.delete(k) } };
}

/** Legs that fill in full once the gate opens (confirm waits on it). */
function gatedLegs() {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const sent: LegSpec[] = [];
  const legs: LegAdapter = {
    prepare: async (leg) => (sent.push(leg), leg.venue === "perpl" ? "42:1" : keccak256(RAW)),
    send: async () => undefined,
    confirm: async (leg) => (await gate, { filledWad: leg.sizeWad, avgPriceWad: 26n * 10n ** 15n }),
  };
  return { legs, sent, open: () => open() };
}

function world() {
  const lock = new OrderLock();
  const kv = memKv();
  const g = { single: gatedLegs(), closeAll: gatedLegs(), earn: gatedLegs() };
  const single = new TradeExecutor({ store: recordStore(kv.kv, 10143, ME), venueRun: () => ({ legs: g.single.legs, facts: async () => ({}) }), head: () => 1n, explorerBase: undefined, collateralDecimals: 6, sleep: async () => undefined, afterTrade: () => undefined, blocked: () => lock.blocked("single") });
  const closeAll = new CloseAllExecutor({ store: closeAllStore(kv.kv, 10143, ME), legs: () => ({ legs: g.closeAll.legs, findSentPerpl: async () => undefined, perplOrderId: () => undefined }), blocked: () => lock.blocked("closeAll"), explorerBase: undefined, sleep: async () => undefined, afterTrade: () => undefined });
  const earn = new EarnExecutor({ chainId: 10143, address: ME, runs: earnRecordStore(kv.kv, 10143, ME), positions: positionStore(kv.kv, 10143, ME), legFor: () => ({ legs: g.earn.legs }), ensureCollateral: async () => undefined, head: () => 1n, explorerBase: undefined, sleep: async () => undefined, blocked: () => lock.blocked("earn") });
  lock.register("single", { busy: () => single.busy, resume: () => single.resume() });
  lock.register("closeAll", { busy: () => closeAll.busy, resume: () => closeAll.resume() });
  lock.register("earn", { busy: () => earn.busy, resume: () => earn.resume() });
  return { lock, kv, g, single, closeAll, earn };
}

const view = (venue: "meridian" | "perpl", size: bigint): PositionView => ({ venue, label: venue, sizeWad: size * WAD, entryWad: 0n, markWad: undefined, pnlWad: 0n, fundingWad: 0n, liqWad: undefined, distanceBps: undefined, priceDp: 4, stepWad: WAD });
const basis = () => {
  const p = planBasisClose([view("meridian", -100n), view("perpl", 100n)], { meridian: { bestBidWad: 26n * 10n ** 15n, bestAskWad: 27n * 10n ** 15n, tickSizeWad: 10n ** 14n }, perpl: { bestBidWad: 26n * 10n ** 15n, bestAskWad: 27n * 10n ** 15n, priceDecimals: 5, sizeDecimals: 0 } });
  if ("error" in p) throw new Error(p.error);
  return p;
};
const BASIS_META = { chainId: 10143, address: ME, meridianPriceDp: 4, perplPriceDp: 5, meridianStepWad: WAD };
const EARN_PLAN = { perplSide: "buy" as const, sizeWad: 100n * WAD, perplLimitPriceWad: 27n * 10n ** 15n, meridianLimitPriceWad: 25n * 10n ** 15n, meridianLotWad: WAD, perplStepWad: WAD, perplCollateralWad: WAD, meridianCollateralWad: WAD, unwindSlippageBps: 100n };
const EARN_META = { summary: "earn", perplPriceDp: 5, meridianPriceDp: 4, leverage100: 200 };
const CLOSE_PLAN = { meridianSide: "buy" as const, perplSide: "sell" as const, sizeWad: 100n * WAD, meridianLimitPriceWad: 27n * 10n ** 15n, perplRefPriceWad: 26n * 10n ** 15n, perplSlippageBps: 100n, perplStepWad: WAD };

type W = ReturnType<typeof world>;
const starts: Record<OrderKind, (w: W) => Promise<unknown>> = {
  // the Trade ticket, a single close and Earn's one-tap leftover close all go through this executor
  single: (w) => w.single.start({ venue: "perpl", side: "sell", sizeWad: 10n * WAD, reduceOnly: true, limitPriceWad: 25n * 10n ** 15n }, { chainId: 10143, address: ME, venue: "perpl", side: "long", summary: "leftover", priceDp: 5, stepWad: WAD, takerFeeWad: 0n, leverage100: 200 }),
  closeAll: (w) => w.closeAll.start(basis(), BASIS_META),
  earn: (w) => w.earn.open(EARN_PLAN, EARN_META),
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("each executor blocks the other two while it runs", () => {
  for (const running of ["single", "closeAll", "earn"] as const) {
    it(`${running} running ⇒ the others refuse with "${BUSY_TEXT[running]}"; after it ends they go through`, async () => {
      const w = world();
      const first = starts[running](w);
      await flush();
      expect(w.lock.blocked(running)).toBeUndefined();
      for (const other of ["single", "closeAll", "earn"] as const) {
        if (other === running) continue;
        await expect(starts[other](w)).rejects.toThrow(BUSY_TEXT[running]);
        expect(w.g[other].sent).toEqual([]); // nothing sent
      }
      // Earn's close is an entry point too
      if (running !== "earn") await expect(w.earn.close(CLOSE_PLAN, EARN_META)).rejects.toThrow(BUSY_TEXT[running]);
      w.g[running].open();
      await first;
      for (const other of ["single", "closeAll", "earn"] as const) {
        if (other === running) continue;
        w.g[other].open();
        await expect(starts[other](w)).resolves.toBeDefined();
      }
    });
  }
});

describe("resume after an unlock", () => {
  it("single → Close all → Earn, one at a time, awaited (fake parties)", async () => {
    const lock = new OrderLock();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const party = (k: OrderKind, ms: number) => ({
      busy: () => false,
      resume: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        log.push(`${k}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${k}:end`);
        active--;
      },
    });
    // registered in a different order than they must run
    lock.register("earn", party("earn", 1));
    lock.register("closeAll", party("closeAll", 5));
    lock.register("single", party("single", 10));
    // two triggers (TradeProvider + EarnProvider effects) queue, never overlap
    await Promise.all([lock.resume(), lock.resume(["earn"])]);
    expect(log).toEqual(["single:start", "single:end", "closeAll:start", "closeAll:end", "earn:start", "earn:end", "earn:start", "earn:end"]);
    expect(maxActive).toBe(1);
  });

  it("a resume that throws doesn't stop the ones after it", async () => {
    const lock = new OrderLock();
    const log: string[] = [];
    lock.register("single", { busy: () => false, resume: async () => Promise.reject(new Error("venue not ready")) });
    lock.register("earn", { busy: () => false, resume: async () => void log.push("earn") });
    await lock.resume();
    expect(log).toEqual(["earn"]);
  });

  it("real executors: a stored Close all and a stored Earn run finish in order; an Earn run doesn't resume while a trade is running", async () => {
    const w = world();
    // a Close all killed after Meridian's tx was signed, and an Earn open killed after its Perpl leg was sent
    await w.kv.kv.set(`meridian.trade.closeall.10143.${ME.toLowerCase()}`, encodeCloseAll({ v: 1, state: startClose("c1", basis().plan), meta: { ...BASIS_META, createdAtMs: 1, summary: "s", meridian: { raw: RAW, nonce: 7 } } }));
    const s0 = { ...startBasis("e1", EARN_PLAN), phase: "LEG1_PERPL_IOC" as const };
    await w.kv.kv.set(`meridian.earn.run.10143.${ME.toLowerCase()}`, encodeEarnRecord({ v: 1, state: s0, meta: { chainId: 10143, address: ME, createdAtMs: 1, ...EARN_META, legs: { "e1:leg1": { rqFloor: 41 } } } }));
    // a fresh trade holds the lock: Earn's resume (e.g. from the Earn screen's focus) waits, its run stays stored
    const t = starts.single(w);
    await flush();
    expect(await w.earn.resume()).toBeUndefined();
    expect(w.kv.m.has(`meridian.earn.run.10143.${ME.toLowerCase()}`)).toBe(true);
    w.g.single.open();
    await t;
    // unlock: Close all first (its legs are gated: Earn must not start before it ends)
    const order: string[] = [];
    w.closeAll.store.subscribe(() => order.push(`closeAll:${w.closeAll.store.get().phase}`));
    w.earn.store.subscribe(() => order.push(`earn:${w.earn.store.get().running ? "running" : "idle"}`));
    const done = w.lock.resume();
    await flush();
    expect(w.earn.busy).toBe(false);
    expect(w.closeAll.busy).toBe(true);
    w.g.closeAll.open();
    w.g.earn.open();
    await done;
    const firstEarn = order.findIndex((x) => x.startsWith("earn:running"));
    const lastCloseAll = order.map((x) => x.startsWith("closeAll:")).lastIndexOf(true);
    expect(firstEarn).toBeGreaterThan(lastCloseAll);
    expect(w.kv.m.size).toBe(1); // both runs finished and cleared; only the Earn position record stays
  });
});
