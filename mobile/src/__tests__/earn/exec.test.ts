// Earn's two-leg executor with venue fakes (no network) driving the REAL N5 leg adapters (Perpl IOC + order history,
// Meridian sign → persist raw → broadcast → receipt): plan → every terminal phase (DONE, PARTIAL_DONE, ABORTED,
// ABORTED_UNWOUND, MANUAL; close CLOSED / CLOSED_PARTIAL / MANUAL), the unwind retry at 2× slippage, the dev forced
// failure, and an app kill at EVERY persisted snapshot — killed right after the save (early) and right before the next
// save with every venue side effect in between already done (late) — resumed by a fresh executor with nothing in
// memory: it always reaches a terminal phase, never re-sends an order, and the venues' real net MON exposure always
// equals what the app shows as the one-sided leftover (zero or an alert, never silent).
import { opposite, startBasis, type BasisExecPlan, type CloseExecPlan } from "@meridian/core/exec";
import { NOT_SENT_FIRST } from "../../features/earn/executor";
import { DEV_FAIL_ERROR } from "../../features/earn/devFail";
import { applyRun, decodeEarnRecord, earnRecordStore, encodeEarnRecord, FLAT, positionStore, type EarnRecord } from "../../features/earn/record";
import { ALL, executor, LOT, ME, memKv, META, PLAN, SWAP_LOT, venueNet, shownLeftover, WAD, world, type Venues, type World } from "./execFixtures";

describe("open: plan → each terminal phase", () => {
  it("DONE: Perpl fills, Meridian hedges exactly that size; position recorded; run cleared", async () => {
    const w = world();
    const { kv, m } = memKv();
    const t = await executor(() => w, kv).open(PLAN, META);
    expect(t!.phase).toBe("DONE");
    expect(t!.outcome).toBe("success");
    expect(t!.steps.map((s) => [s.key, s.status])).toEqual([["collateral", "filled"], ["leg1", "filled"], ["leg2", "filled"]]);
    expect(t!.steps[1]!.orderId).toBe(9042);
    expect(t!.steps[2]!.txUrl).toMatch(/^https:\/\/testnet\.monadexplorer\.com\/tx\/0x[0-9a-f]{64}$/);
    expect(w.px.iocs).toHaveLength(1);
    expect(w.ch.mined.size).toBe(1);
    expect(venueNet(w)).toBe(0n);
    const pos = await positionStore(kv, 10143, ME).load();
    expect(pos).toMatchObject({ perplSide: "buy", sizeWad: 300n * WAD });
    expect(pos.naked).toBeUndefined();
    expect([...m.keys()].some((k) => k.startsWith("meridian.earn.run."))).toBe(false);
  });

  it("ABORTED: Perpl fills nothing ⇒ the Meridian leg is never sent", async () => {
    const w = world({ ...ALL, perplFill: () => 0 });
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(PLAN, META);
    expect(t!.phase).toBe("ABORTED");
    expect(t!.body).toMatch(/Perpl didn't fill at your price, so the Meridian leg wasn't sent/);
    expect(w.ch.estimates).toBe(0);
    const pos = await positionStore(kv, 10143, ME).load();
    expect(pos.sizeWad).toBe(0n);
    expect(pos.naked).toBeUndefined();
  });

  it("collateral failure (passkey cancelled) ⇒ ABORTED before any order", async () => {
    const w = world();
    w.coll.fail = "User cancelled the passkey prompt";
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(PLAN, META);
    expect(t!.phase).toBe("ABORTED");
    expect(t!.steps[0]!.status).toBe("failed");
    expect(t!.body).toBe("Cancelled. Nothing was sent.");
    expect(w.px.iocs).toHaveLength(0);
  });

  it("Perpl partial (250 of 300) ⇒ Meridian 200 (its lot) ⇒ the extra 50 on Perpl unwound ⇒ PARTIAL_DONE, hedged 200", async () => {
    const w = world({ ...ALL, perplFill: (p, n) => (n === 0 ? 250 : p.sizeLns) });
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(PLAN, META);
    expect(t!.phase).toBe("PARTIAL_DONE");
    expect(w.px.iocs.map((x) => [x.side, x.reduceOnly, x.sizeLns])).toEqual([["buy", false, 300], ["sell", true, 50]]);
    expect(venueNet(w)).toBe(0n);
    expect((await positionStore(kv, 10143, ME).load()).sizeWad).toBe(200n * WAD);
  });

  it("Meridian fills less than asked (100 of 300) ⇒ unwind 200 on Perpl ⇒ PARTIAL_DONE", async () => {
    const w = world({ ...ALL, meridianFill: () => 1n });
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(PLAN, META);
    expect(t!.phase).toBe("PARTIAL_DONE");
    expect(t!.steps.find((s) => s.key === "leg2")!.status).toBe("partial");
    expect(venueNet(w)).toBe(0n);
  });

  it("Meridian reverts ⇒ Perpl auto-unwound in full ⇒ ABORTED_UNWOUND (flat, in plain words)", async () => {
    const w = world({ ...ALL, meridianFill: () => "revert" });
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(PLAN, META);
    expect(t!.phase).toBe("ABORTED_UNWOUND");
    expect(t!.body).toMatch(/Meridian didn't fill, so the Perpl leg was closed again/);
    expect(w.px.iocs.map((x) => [x.side, x.reduceOnly, x.sizeLns])).toEqual([["buy", false, 300], ["sell", true, 300]]);
    expect(venueNet(w)).toBe(0n);
  });

  it("dev flag: the Meridian leg is forced to fail BEFORE sending ⇒ the Perpl leg is auto-unwound", async () => {
    const w = world();
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(PLAN, { ...META, devFailMeridian: true });
    expect(t!.phase).toBe("ABORTED_UNWOUND");
    expect(t!.steps.find((s) => s.key === "leg2")!.detail).toBe(DEV_FAIL_ERROR);
    expect(w.ch.estimates).toBe(0); // nothing signed or sent on Meridian
    expect(venueNet(w)).toBe(0n);
  });

  it("unwind retry: the first undo fills nothing ⇒ retried at 2× the slippage ⇒ ABORTED_UNWOUND", async () => {
    const w = world({ perplFill: (p, n) => (n === 1 ? 0 : p.sizeLns), meridianFill: () => "revert" });
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(PLAN, META);
    expect(t!.phase).toBe("ABORTED_UNWOUND");
    const [, u1, u2] = w.px.iocs;
    expect([u1!.reduceOnly, u2!.reduceOnly]).toEqual([true, true]);
    // sell limit from the leg-1 avg (0.02567): 1 % ⇒ 2541.33 → floor; 2 % ⇒ 2515.66 → floor (PNS, 5 dp)
    expect([u1!.limitPns, u2!.limitPns]).toEqual([2541, 2515]);
    expect(t!.steps.map((s) => s.key)).toEqual(["collateral", "leg1", "leg2", "unwind1", "unwind2"]);
    expect(venueNet(w)).toBe(0n);
  });

  it("MANUAL: both undos fail ⇒ alert with the exact leftover, recorded for the one-tap close (never silent)", async () => {
    const w = world({ perplFill: (p, n) => (n === 0 ? p.sizeLns : 0), meridianFill: () => "revert" });
    const { kv } = memKv();
    const ex = executor(() => w, kv);
    const t = await ex.open(PLAN, META);
    expect(t!.phase).toBe("MANUAL");
    expect(t!.outcome).toBe("action");
    expect(t!.leftover).toEqual({ venue: "perpl", side: "buy", sizeWad: 300n * WAD });
    expect(venueNet(w)).toBe(300n * WAD);
    expect(await shownLeftover(kv)).toBe(venueNet(w));
    expect(ex.position.get().naked).toEqual({ venue: "perpl", side: "buy", sizeWad: 300n * WAD });
    // the one-tap close filled it
    await ex.noteManualClose(300n * WAD);
    expect(ex.position.get().naked).toBeUndefined();
  });
});

describe("close: Meridian first, then Perpl for exactly what closed", () => {
  // the pair from PLAN: long 300 Perpl / short 300 Meridian ⇒ close buys on Meridian, sells on Perpl
  const CLOSE: CloseExecPlan = { meridianSide: "buy", perplSide: "sell", sizeWad: 300n * WAD, meridianLimitPriceWad: 26200n * 10n ** 12n, perplRefPriceWad: 2551n * 10n ** 13n, perplSlippageBps: 100n, perplStepWad: WAD };
  async function opened(v: Venues = ALL) {
    const w = world(v);
    const { kv } = memKv();
    const ex = executor(() => w, kv);
    await ex.open(PLAN, META);
    return { w, kv, ex };
  }
  it("CLOSED: flat on both venues, the position is gone", async () => {
    const { w, kv, ex } = await opened();
    const t = await ex.close(CLOSE, META);
    expect(t!.phase).toBe("CLOSED");
    expect(t!.body).toMatch(/You're flat/);
    expect(w.px.net).toBe(0);
    expect(w.ch.net).toBe(0n);
    const pos = await positionStore(kv, 10143, ME).load();
    expect([pos.sizeWad, pos.perplSide, pos.naked]).toEqual([0n, undefined, undefined]);
  });
  it("CLOSED_PARTIAL: Meridian closes 100 ⇒ Perpl closes exactly 100 ⇒ still hedged 200", async () => {
    const { w, kv, ex } = await opened({ ...ALL, meridianFill: (o) => (o.reduceOnly ? 1n : o.lots) });
    const t = await ex.close(CLOSE, META);
    expect(t!.phase).toBe("CLOSED_PARTIAL");
    expect(w.px.iocs.at(-1)).toMatchObject({ side: "sell", reduceOnly: true, sizeLns: 100 });
    expect(venueNet(w)).toBe(0n);
    expect((await positionStore(kv, 10143, ME).load()).sizeWad).toBe(200n * WAD);
  });
  it("MANUAL: Meridian closed but Perpl won't (twice) ⇒ the Perpl leftover is shown, matching the venues", async () => {
    const { w, kv, ex } = await opened({ perplFill: (p) => (p.reduceOnly ? 0 : p.sizeLns), meridianFill: (o) => o.lots });
    const t = await ex.close(CLOSE, META);
    expect(t!.phase).toBe("MANUAL");
    expect(t!.leftover).toEqual({ venue: "perpl", side: "buy", sizeWad: 300n * WAD });
    expect(await shownLeftover(kv)).toBe(venueNet(w));
  });
  it("ABORTED: Meridian closes nothing ⇒ Perpl never sent, hedge unchanged", async () => {
    const { w, kv, ex } = await opened({ perplFill: (p) => p.sizeLns, meridianFill: (o) => (o.reduceOnly ? "revert" : o.lots) });
    const before = w.px.iocs.length;
    const t = await ex.close(CLOSE, META);
    expect(t!.phase).toBe("ABORTED");
    expect(w.px.iocs.length).toBe(before);
    expect((await positionStore(kv, 10143, ME).load()).sizeWad).toBe(300n * WAD);
  });
});

describe("Lock: the swap leg after the hedge; the hedge never depends on it", () => {
  // 1,000 MON pair (one swap lot): long Perpl / short Meridian ⇒ sell the swap (receive fixed on Meridian's funding)
  const LPLAN: BasisExecPlan = { ...PLAN, sizeWad: 1_000n * WAD, lock: { side: "sell", maxSizeWad: 1_000n * WAD, limitPriceWad: 111n * 10n ** 16n, lotWad: SWAP_LOT } };
  const LMETA = { ...META, lockCollateralWad: 7n * WAD };

  it("DONE with the lock filled: the swap-market deposit rode the collateral step; the receipt names the fixed rate", async () => {
    const w = world();
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(LPLAN, LMETA);
    expect(t!.phase).toBe("DONE");
    expect(w.coll.lockWad).toBe(7n * WAD);
    expect(w.ch.swapNet).toBe(-1_000n * WAD);
    expect(venueNet(w)).toBe(0n);
    expect(t!.steps.map((x) => [x.key, x.status])).toEqual([["collateral", "filled"], ["leg1", "filled"], ["leg2", "filled"], ["leg3", "filled"]]);
    expect(t!.steps[3]!.detail).toBe("Filled at 12.00% fixed");
    expect(t!.body).toMatch(/Meridian's funding is fixed at 12\.00% on 1,000 MON until the swap matures/);
    expect((await positionStore(kv, 10143, ME).load()).sizeWad).toBe(1_000n * WAD);
  });

  it("the swap reverts ⇒ DONE_LOCK_FAILED: hedge open at the floating rate, nothing unwound", async () => {
    const w = world({ ...ALL, swapFill: () => "revert" });
    const { kv } = memKv();
    const t = await executor(() => w, kv).open(LPLAN, LMETA);
    expect(t!.phase).toBe("DONE_LOCK_FAILED");
    expect(t!.body).toBe("Lock failed, hedge open, floating rate applies.");
    expect(t!.steps.at(-1)).toMatchObject({ key: "leg3", status: "failed" });
    expect(w.px.iocs).toHaveLength(1); // no unwind
    expect(venueNet(w)).toBe(0n);
    expect((await positionStore(kv, 10143, ME).load()).sizeWad).toBe(1_000n * WAD);
  });

  const CLOSE1K: CloseExecPlan = { meridianSide: "buy", perplSide: "sell", sizeWad: 1_000n * WAD, meridianLimitPriceWad: 26200n * 10n ** 12n, perplRefPriceWad: 2551n * 10n ** 13n, perplSlippageBps: 100n, perplStepWad: WAD };
  const SWAP_BACK = { side: "buy" as const, sizeWad: 1_000n * WAD, limitPriceWad: 113n * 10n ** 16n };

  it("close with a lock: the swap is bought back FIRST (reduce-only), then Meridian, then Perpl ⇒ flat everywhere", async () => {
    const w = world();
    const { kv } = memKv();
    const ex = executor(() => w, kv);
    await ex.open(LPLAN, LMETA);
    const t = await ex.close(CLOSE1K, META, SWAP_BACK);
    expect(t!.phase).toBe("CLOSED");
    expect(w.ch.swapNet).toBe(0n);
    expect(venueNet(w)).toBe(0n);
    expect(w.px.net).toBe(0);
    expect(t!.steps.map((x) => [x.key, x.status])).toEqual([["swap-close", "filled"], ["close-m", "filled"], ["close-p1", "filled"]]);
  });

  it("the lock won't close ⇒ nothing else is sent: the pair stays hedged (never a swap without its hedge, never a hedge half-closed)", async () => {
    const w = world({ ...ALL, swapFill: (o) => (o.reduceOnly ? "revert" : o.lots) });
    const { kv } = memKv();
    const ex = executor(() => w, kv);
    await ex.open(LPLAN, LMETA);
    const before = { iocs: w.px.iocs.length, mined: w.ch.mined.size };
    const t = await ex.close(CLOSE1K, META, SWAP_BACK);
    expect(t!.phase).toBe("ABORTED");
    expect(t!.body).toMatch(/^Couldn't close the fixed-rate lock first, so nothing else was sent/);
    expect(w.px.iocs.length).toBe(before.iocs);
    expect(w.ch.mined.size).toBe(before.mined + 1); // only the reverted swap tx
    expect(w.ch.swapNet).toBe(-1_000n * WAD);
    expect((await positionStore(kv, 10143, ME).load()).sizeWad).toBe(1_000n * WAD);
  });

  for (const [name, run] of [
    ["open with lock", "open"],
    ["close with lock", "close"],
  ] as const) {
    it(`${name}: every snapshot, early and late kill ⇒ terminal, nothing sent twice, perp exposure = shown leftover, swap never left without its hedge`, async () => {
      const w0 = world();
      const { kv, m } = memKv();
      const pre = executor(() => w0, kv);
      if (run === "close") await pre.open(LPLAN, LMETA);
      const caps: { rec: string; w: World; kv: Map<string, string> }[] = [];
      const runs = earnRecordStore(kv, 10143, ME);
      const spy = { ...runs, save: async (r: EarnRecord) => { caps.push({ rec: encodeEarnRecord(r), w: { px: w0.px.clone(), ch: w0.ch.clone(), coll: { calls: 0 } }, kv: new Map(m) }); await runs.save(r); } };
      const ref = executor(() => w0, kv, { runs: spy });
      await (run === "open" ? ref.open(LPLAN, LMETA) : ref.close(CLOSE1K, META, SWAP_BACK));
      const endW = { px: w0.px.clone(), ch: w0.ch.clone(), coll: { calls: 0 } };
      for (let k = 0; k < caps.length; k++) {
        for (const late of [false, true]) {
          const at = late ? (caps[k + 1]?.w ?? endW) : caps[k]!.w;
          const w: World = { px: at.px.clone(), ch: at.ch.clone(), coll: { calls: 0 } };
          const store = memKv(caps[k]!.kv);
          store.m.set(`meridian.earn.run.10143.${ME.toLowerCase()}`, caps[k]!.rec);
          const t = await executor(() => w, store.kv).resume();
          const where = `${name} snapshot ${k} ${late ? "late" : "early"}`;
          expect([where, t?.phase]).toEqual([where, expect.stringMatching(/^(DONE|DONE_LOCK_FAILED|ABORTED|CLOSED)$/)]);
          expect([where, w.px.iocs.length <= endW.px.iocs.length, w.ch.mined.size <= endW.ch.mined.size]).toEqual([where, true, true]);
          expect([where, venueNet(w)]).toEqual([where, await shownLeftover(store.kv)]);
          // a swap is open only while the pair that it fixes is open
          const pos = await positionStore(store.kv, 10143, ME).load();
          expect([where, w.ch.swapNet !== 0n && pos.sizeWad === 0n]).toEqual([where, false]);
        }
      }
    });
  }
});

describe("kill at every persisted snapshot → resume (fresh executor, nothing in memory)", () => {
  type Scenario = { name: string; venues: Venues; run: "open" | "close"; dev?: boolean };
  const scenarios: Scenario[] = [
    { name: "open DONE", venues: ALL, run: "open" },
    { name: "open PARTIAL_DONE", venues: { ...ALL, meridianFill: (o) => (o.reduceOnly ? o.lots : 1n) }, run: "open" },
    { name: "open ABORTED_UNWOUND (revert)", venues: { ...ALL, meridianFill: () => "revert" }, run: "open" },
    { name: "open ABORTED_UNWOUND (dev flag)", venues: ALL, run: "open", dev: true },
    { name: "open via unwind retry", venues: { perplFill: (p, n) => (n === 1 ? 0 : p.sizeLns), meridianFill: () => "revert" }, run: "open" },
    { name: "open MANUAL", venues: { perplFill: (p) => (p.reduceOnly ? 0 : p.sizeLns), meridianFill: () => "revert" }, run: "open" },
    { name: "close CLOSED", venues: ALL, run: "close" },
    { name: "close CLOSED_PARTIAL", venues: { ...ALL, meridianFill: (o) => (o.reduceOnly ? 1n : o.lots) }, run: "close" },
  ];
  const CLOSE: CloseExecPlan = { meridianSide: "buy", perplSide: "sell", sizeWad: 300n * WAD, meridianLimitPriceWad: 26200n * 10n ** 12n, perplRefPriceWad: 2551n * 10n ** 13n, perplSlippageBps: 100n, perplStepWad: WAD };

  for (const sc of scenarios) {
    it(`${sc.name}: every snapshot, early and late kill, ends terminal, sends nothing twice, exposure never hidden`, async () => {
      // the reference run, capturing (record, venue state, position kv) at every save
      const w0 = world(sc.venues);
      const { kv, m } = memKv();
      const pre = executor(() => w0, kv);
      if (sc.run === "close") await pre.open(PLAN, META);
      const caps: { rec: string; w: World; kv: Map<string, string> }[] = [];
      const runs = earnRecordStore(kv, 10143, ME);
      const spy = { ...runs, save: async (r: EarnRecord) => { caps.push({ rec: encodeEarnRecord(r), w: { px: w0.px.clone(), ch: w0.ch.clone(), coll: { calls: 0 } }, kv: new Map(m) }); await runs.save(r); } };
      const ref = executor(() => w0, kv, { runs: spy });
      const final = sc.run === "open" ? await ref.open(PLAN, { ...META, ...(sc.dev ? { devFailMeridian: true } : {}) }) : await ref.close(CLOSE, META);
      expect(final).toBeDefined();
      const endW = { px: w0.px.clone(), ch: w0.ch.clone(), coll: { calls: 0 } };
      expect(caps.length).toBeGreaterThan(4);

      for (let k = 0; k < caps.length; k++) {
        for (const late of [false, true]) {
          const venueAt = late ? (caps[k + 1]?.w ?? endW) : caps[k]!.w;
          const w: World = { px: venueAt.px.clone(), ch: venueAt.ch.clone(), coll: { calls: 0 } };
          const store = memKv(caps[k]!.kv);
          store.m.set(`meridian.earn.run.10143.${ME.toLowerCase()}`, caps[k]!.rec);
          const ex = executor(() => w, store.kv);
          const rec = decodeEarnRecord(caps[k]!.rec)!;
          const t = await ex.resume();
          const where = `${sc.name} snapshot ${k} (${rec.state.phase}) ${late ? "late" : "early"}`;
          expect([where, t?.phase]).toEqual([where, expect.stringMatching(/^(DONE|PARTIAL_DONE|ABORTED|ABORTED_UNWOUND|MANUAL|CLOSED|CLOSED_PARTIAL)$/)]);
          // nothing re-sent: never more orders / transactions than the uninterrupted run
          expect([where, w.px.iocs.length <= endW.px.iocs.length, w.ch.mined.size <= endW.ch.mined.size]).toEqual([where, true, true]);
          // never a hidden naked leg: the venues' real net MON exposure = the one-sided leftover the app shows
          expect([where, venueNet(w)]).toEqual([where, await shownLeftover(store.kv)]);
          // the run record is gone after a terminal phase
          expect([where, store.m.has(`meridian.earn.run.10143.${ME.toLowerCase()}`)]).toEqual([where, false]);
          // resuming again does nothing
          expect(await executor(() => w, store.kv).resume()).toBeUndefined();
        }
      }
    });
  }

  it("a first leg not sent before the kill is cancelled, never sent on relaunch", async () => {
    const w = world();
    const { kv, m } = memKv();
    const s = { ...startBasis("e1", PLAN), phase: "LEG1_PERPL_IOC" as const };
    m.set(`meridian.earn.run.10143.${ME.toLowerCase()}`, encodeEarnRecord({ v: 1, state: s, meta: { chainId: 10143, address: ME, createdAtMs: 1, ...META, legs: {} } }));
    const t = await executor(() => w, kv).resume();
    expect(t!.phase).toBe("ABORTED");
    expect(t!.body).toBe(NOT_SENT_FIRST);
    expect(w.px.iocs).toHaveLength(0);
  });

  it("a hedge leg not sent before the kill IS sent on relaunch (exposure is open)", async () => {
    const w = world();
    await w.px.trading.ioc({ side: "buy", reduceOnly: false, sizeLns: 300, limitPns: 2593 }); // leg 1 filled before the kill
    const { kv, m } = memKv();
    const s = { ...startBasis("e1", PLAN), phase: "LEG2_MERIDIAN" as const, q1: { filledWad: 300n * WAD, avgPriceWad: 2567n * 10n ** 13n } };
    m.set(`meridian.earn.run.10143.${ME.toLowerCase()}`, encodeEarnRecord({ v: 1, state: s, meta: { chainId: 10143, address: ME, createdAtMs: 1, ...META, legs: {} } }));
    const ex = executor(() => w, kv);
    const t = await ex.resume();
    expect(t!.phase).toBe("DONE");
    expect(venueNet(w)).toBe(0n);
    expect(ex.store.get()).toMatchObject({ running: false, resumed: true }); // the Earn screen offers this receipt
  });
});

describe("records", () => {
  it("a corrupt or foreign run never drives an order", () => {
    expect(decodeEarnRecord("{nope")).toBeUndefined();
    expect(decodeEarnRecord(JSON.stringify({ v: 1, exec: "{}", meta: {} }))).toBeUndefined();
    expect(decodeEarnRecord(null)).toBeUndefined();
  });
  it("folding a terminal run into the position is idempotent by run id", () => {
    const s = { ...startBasis("e9", PLAN), phase: "DONE" as const, q1: { filledWad: 300n * WAD }, q2: { filledWad: 300n * WAD } };
    const once = applyRun(FLAT, s);
    expect(applyRun(once, s)).toBe(once);
    expect(once.sizeWad).toBe(300n * WAD);
  });
  it("opposite helper sanity for the close sides", () => {
    expect(opposite("buy")).toBe("sell");
  });
});
