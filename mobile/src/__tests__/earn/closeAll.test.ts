// Close all with Earn + Lock (N6 + N7 integration), on the REAL Earn executor + N5 legs over venue fakes (no network):
// an Earn pair closes as the Earn screen closes it (the lock first, then Meridian, then Perpl) and leaves the Earn record
// FLAT; a lock that doesn't close stops everything; a lock without a record (or one that doesn't match) is refused with
// the reason; an app kill at every persisted snapshot resumes to a terminal phase with the record matching the venues
// and the lock never left without its hedge; a fallback pair with no Earn record keeps N7's two-leg close.
import type { BookLevel } from "@meridian/core/route";
import type { CloseExecState } from "@meridian/core/exec";
import { EARN_LOADING, lockMismatch, lockNoRecord, pairNotHeld, planCloseAll, runCloseAll, type CloseAllInput, type CloseAllRoute, type CloseAllRunDeps } from "../../features/earn/closeAll";
import { tryReadMeridianDeployment } from "@meridian/core/meridian";
import meridian10143 from "../../../../deployments/10143.json";
import { LOCK_UNKNOWN, planEarnPairClose, swapMarketDeployed } from "../../features/earn/closePair";
import { earnRecordStore, encodeEarnRecord, FLAT, positionStore, type EarnPosition, type EarnRecord } from "../../features/earn/record";
import type { EarnVenueInput } from "../../features/earn/plan";
import type { SwapState } from "../../features/earn/data/swap";
import type { AccountsState } from "../../features/trade/data/accounts";
import { planBasisClose, type CloseAllMarkets } from "../../features/trade/exec/closeAll";
import type { Receipt } from "../../features/trade/exec/receipt";
import type { PositionView } from "../../features/trade/positions/views";
import { ALL, executor, LOT, ME, memKv, META, PLAN, SWAP_LOT, venueNet, shownLeftover, WAD, world, type Venues, type World } from "./execFixtures";

const RUN_KEY = `meridian.earn.run.10143.${ME.toLowerCase()}`;
// 1,000 MON pair (one swap lot): long Perpl / short Meridian ⇒ the lock SELLS the swap (receives fixed)
const LPLAN = { ...PLAN, sizeWad: 1_000n * WAD, lock: { side: "sell" as const, maxSizeWad: 1_000n * WAD, limitPriceWad: 111n * 10n ** 16n, lotWad: SWAP_LOT } };
const LMETA = { ...META, lockCollateralWad: 7n * WAD };

// synthetic books deep enough for any close here (the fakes fill by script, not by price)
const lv = (px: bigint): BookLevel[] => [{ priceWad: px, sizeWad: 100_000n * WAD }];
const M_BIDS = lv(25_800n * 10n ** 12n);
const M_ASKS = lv(25_900n * 10n ** 12n);
const P_BIDS = lv(2_580n * 10n ** 13n);
const P_ASKS = lv(2_590n * 10n ** 13n);
const MK: CloseAllMarkets = {
  meridian: { bestBidWad: M_BIDS[0]!.priceWad, bestAskWad: M_ASKS[0]!.priceWad, tickSizeWad: 10n ** 12n },
  perpl: { bestBidWad: P_BIDS[0]!.priceWad, bestAskWad: P_ASKS[0]!.priceWad, priceDecimals: 5, sizeDecimals: 0 },
};
const venueIn = (o: Partial<EarnVenueInput>): EarnVenueInput => ({ aprWad: 0n, takerFeeWad: 5n * 10n ** 14n, stepWad: undefined, priceStepWad: undefined, priceDp: 5, bids: undefined, asks: undefined, markWad: undefined, freeWad: 0n, walletWad: 0n, ready: true, ...o });

/** What the phone would read from the venues right now (positions, the wallet's swap account). */
function readVenues(w: World, o: { swapKnown?: boolean } = {}) {
  const mSize = w.ch.net;
  const pSize = BigInt(w.px.net) * WAD;
  const view = (venue: "meridian" | "perpl", sizeWad: bigint): PositionView => ({ venue, label: venue === "meridian" ? "Meridian" : "Perpl", sizeWad, entryWad: 0n, markWad: undefined, pnlWad: 0n, fundingWad: 0n, liqWad: undefined, distanceBps: undefined, priceDp: venue === "meridian" ? 6 : 5, stepWad: venue === "meridian" ? LOT : WAD });
  const views = [...(mSize !== 0n ? [view("meridian", mSize)] : []), ...(pSize !== 0n ? [view("perpl", pSize)] : [])];
  const accounts = { atBlock: 1n, meridian: { sizeWad: mSize }, perpl: { position: pSize !== 0n ? { side: pSize > 0n ? "Long" : "Short", sizeWad: pSize > 0n ? pSize : -pSize } : undefined }, perplMargins: undefined, error: undefined } as unknown as AccountsState;
  const swap = {
    bookKnown: true,
    bids: lv(111n * 10n ** 16n),
    asks: lv(113n * 10n ** 16n),
    tickSizeWad: 10n ** 14n,
    lotSizeWad: SWAP_LOT,
    account: o.swapKnown === false ? undefined : { collateralWad: 7n * WAD, sizeWad: w.ch.swapNet, kWad: 0n, avgFixedAprWad: 12n * 10n ** 16n },
  } as unknown as SwapState;
  return {
    views,
    inputs: {
      accounts,
      meridian: venueIn({ bids: M_BIDS, asks: M_ASKS, stepWad: LOT, priceStepWad: 10n ** 12n }),
      perpl: venueIn({ bids: P_BIDS, asks: P_ASKS, stepWad: WAD, priceStepWad: 10n ** 13n }),
      swap,
      perplPriceDp: 5,
      meridianPriceDp: 6,
    },
  };
}

const input = (w: World, earnPos: CloseAllInput["earnPos"], o: { swapKnown?: boolean; swapMarket?: boolean } = {}): CloseAllInput => {
  const r = readVenues(w, o);
  return { views: r.views, mk: MK, earnPos, inputs: r.inputs, swapMarket: o.swapMarket ?? true };
};

/** N7's two paths as spies (the Trade executor / CloseAllExecutor are covered in trade/closeAll.test.ts). */
function n7(w: World) {
  const singles: { venue: string; side: string; sizeWad: bigint }[] = [];
  const basis: unknown[] = [];
  const deps = (earn: CloseAllRunDeps["earn"]): CloseAllRunDeps => ({
    earn,
    basis: async (p) => {
      basis.push(p);
      w.ch.net += p.plan.meridianSide === "buy" ? p.plan.sizeWad : -p.plan.sizeWad;
      w.px.net += Number((p.plan.perplSide === "buy" ? p.plan.sizeWad : -p.plan.sizeWad) / WAD);
      const state = { meridian: { filledWad: p.plan.sizeWad }, perpl: { targetWad: p.plan.sizeWad, filledWad: p.plan.sizeWad } } as unknown as CloseExecState;
      return { outcome: { ok: true, title: "Basis trade closed", detail: "both" }, state };
    },
    single: async (c) => {
      singles.push({ venue: c.venue, side: c.side, sizeWad: c.sizeWad });
      if (c.venue === "perpl") w.px.net += Number((c.side === "buy" ? c.sizeWad : -c.sizeWad) / WAD);
      else w.ch.net += c.side === "buy" ? c.sizeWad : -c.sizeWad;
      return { ok: true, filledWad: c.sizeWad } as Receipt;
    },
  });
  return { singles, basis, deps };
}

const flat = (p: EarnPosition) => [p.sizeWad, p.perplSide, p.naked];

async function openedWithLock(v: Venues = ALL) {
  const w = world(v);
  const kv = memKv();
  const ex = executor(() => w, kv.kv);
  expect((await ex.open(LPLAN, LMETA))!.phase).toBe("DONE");
  expect(w.ch.swapNet).toBe(-1_000n * WAD);
  return { w, kv, ex };
}

const asRun = (r: CloseAllRoute) => {
  if (r.kind !== "earn" && r.kind !== "plain") throw new Error(`route ${r.kind}: ${"error" in r ? r.error : "reason" in r ? r.reason : ""}`);
  return r;
};

describe("plan: the Earn record decides the pairing, never sizes alone", () => {
  it("an open Earn pair with a lock ⇒ the Earn route: lock bought back in full first, then the pair at its recorded size", async () => {
    const { w, ex } = await openedWithLock();
    const r = asRun(planCloseAll(input(w, ex.position.get())));
    expect(r.kind).toBe("earn");
    if (r.kind !== "earn") return;
    expect(r.earn.swap).toEqual({ side: "buy", sizeWad: 1_000n * WAD, limitPriceWad: expect.any(BigInt) });
    expect(r.earn.plan).toMatchObject({ meridianSide: "buy", perplSide: "sell", sizeWad: 1_000n * WAD });
    expect(r.rest).toBeUndefined();
    expect(r.summary).toBe("Close the fixed-rate lock (1,000 MON) first, then the Earn position: 1,000 MON on Meridian first, then the same on Perpl");
  });

  it("the same plan and lock order the Earn screen builds (shared helper)", async () => {
    const { w, ex } = await openedWithLock();
    const i = input(w, ex.position.get());
    const r = planCloseAll(i);
    const screen = planEarnPairClose(ex.position.get(), i.inputs, true);
    expect(r.kind === "earn" && screen.ok ? [r.earn.plan, r.earn.swap, r.earn.meta] : undefined).toEqual(screen.ok ? [screen.plan, screen.swap, screen.meta] : "x");
  });

  it("positions outside the Earn pair keep N7's path (here: a manual Meridian short on top ⇒ one single close after the pair)", async () => {
    const { w, ex } = await openedWithLock();
    w.ch.net -= 200n * WAD;
    const r = planCloseAll(input(w, ex.position.get()));
    expect(r.kind === "earn" ? [r.rest?.kind, r.restViews.map((v) => [v.venue, v.sizeWad])] : r).toEqual(["singles", [["meridian", -200n * WAD]]]);
  });

  it("a lock with no Earn record ⇒ refused, with where to close it", () => {
    const w = world();
    w.ch.swapNet = -1_000n * WAD;
    w.ch.net = -1_000n * WAD;
    w.px.net = 1_000; // a pair that looks hedged by size alone
    expect(planCloseAll(input(w, FLAT))).toEqual({ kind: "refused", error: lockNoRecord(-1_000n * WAD, WAD) });
    expect(lockNoRecord(-1_000n * WAD, WAD)).toMatch(/no Earn position for it.*sends nothing.*Close the fixed-rate lock first/);
    // even with nothing else open
    const lone = world();
    lone.ch.swapNet = 1_000n * WAD;
    expect(planCloseAll(input(lone, FLAT)).kind).toBe("refused");
  });

  it("a lock that doesn't match the record (bigger, or the wrong side) ⇒ refused: close the fixed-rate lock on Earn first", async () => {
    const { w, ex } = await openedWithLock();
    w.ch.swapNet = -2_000n * WAD;
    expect(planCloseAll(input(w, ex.position.get()))).toEqual({ kind: "refused", error: lockMismatch(-2_000n * WAD, 1_000n * WAD, WAD) });
    w.ch.swapNet = 1_000n * WAD;
    expect(planCloseAll(input(w, ex.position.get()))).toEqual({ kind: "refused", error: lockMismatch(1_000n * WAD, 1_000n * WAD, WAD) });
    expect(lockMismatch(1n, 1n, WAD)).toMatch(/Close the fixed-rate lock on Earn first/);
  });

  it("a record the venues don't hold any more ⇒ refused (never closes a guess)", async () => {
    const { w, ex } = await openedWithLock();
    w.ch.net += 300n * WAD; // 300 of the Meridian short closed by hand
    expect(planCloseAll(input(w, ex.position.get()))).toEqual({ kind: "refused", error: pairNotHeld(1_000n * WAD, WAD) });
  });

  it("waits while the lock or the record is still being read", async () => {
    const { w, ex } = await openedWithLock();
    expect(planCloseAll(input(w, ex.position.get(), { swapKnown: false }))).toEqual({ kind: "wait", reason: LOCK_UNKNOWN });
    expect(planCloseAll(input(w, undefined))).toEqual({ kind: "wait", reason: EARN_LOADING });
  });

  it("a fallback pair with no Earn record and no lock keeps N7's two-leg close, unchanged", () => {
    const w = world();
    w.ch.net = -300n * WAD;
    w.px.net = 300;
    const i = input(w, FLAT);
    const r = planCloseAll(i);
    expect(r).toEqual({ kind: "plain", rest: { kind: "basis", plan: planBasisClose(i.views, MK) }, restViews: i.views });
    // no swap market on this network ⇒ no lock to wait for
    expect(planCloseAll({ ...i, swapMarket: false, inputs: { ...i.inputs, swap: undefined } }).kind).toBe("plain");
    expect(planCloseAll(input(world(), null))).toEqual({ kind: "empty" });
  });
});

describe("run", () => {
  it("Earn pair with a lock: swap first, then Meridian, then Perpl ⇒ flat everywhere, the Earn record is FLAT", async () => {
    const { w, ex, kv } = await openedWithLock();
    const minedBefore = w.ch.mined.size;
    const iocsBefore = w.px.iocs.length;
    const { deps, singles, basis } = n7(w);
    const res = await runCloseAll(asRun(planCloseAll(input(w, ex.position.get()))), deps(ex));
    expect(res).toMatchObject({ ok: true });
    expect(res.earn!.steps.map((s) => [s.key, s.status])).toEqual([["swap-close", "filled"], ["close-m", "filled"], ["close-p1", "filled"]]);
    // order on the venues: the swap tx, then the Meridian tx, then the Perpl IOC
    const sent = [...w.ch.mined.values()].slice(minedBefore).map((m) => m.to.toLowerCase());
    expect(sent).toEqual(["0x00000000000000000000000000000000000005b0", "0xcfb0169ff1957c347285bb10ab83e33f3c2bb207"]); // the swap book, then Meridian's
    expect(w.px.iocs.slice(iocsBefore)).toEqual([expect.objectContaining({ side: "sell", reduceOnly: true, sizeLns: 1000 })]);
    expect([w.ch.swapNet, w.ch.net, w.px.net]).toEqual([0n, 0n, 0]);
    expect(flat(await positionStore(kv.kv, 10143, ME).load())).toEqual([0n, undefined, undefined]);
    expect(flat(ex.position.get())).toEqual([0n, undefined, undefined]);
    expect([singles, basis]).toEqual([[], []]);
  });

  it("then the rest (outside the pair) on N7's path, only after the pair closed in full", async () => {
    const { w, ex } = await openedWithLock();
    w.ch.net -= 200n * WAD;
    const { deps, singles } = n7(w);
    const res = await runCloseAll(asRun(planCloseAll(input(w, ex.position.get()))), deps(ex));
    expect(res).toMatchObject({ ok: true, title: "Everything closed" });
    expect(res.detail).toMatch(/^Earn position closed \(the fixed-rate lock first\)\. Closed on Meridian/);
    expect(singles).toEqual([{ venue: "meridian", side: "buy", sizeWad: 200n * WAD }]);
    expect([w.ch.swapNet, w.ch.net, w.px.net]).toEqual([0n, 0n, 0]);
  });

  it("the lock doesn't close ⇒ nothing else is sent (no perp leg, no other position); the record still says hedged, as the venues do", async () => {
    const { w, ex, kv } = await openedWithLock({ ...ALL, swapFill: (o) => (o.reduceOnly ? "revert" : o.lots) });
    w.ch.net -= 200n * WAD; // something outside the pair, too
    const before = { iocs: w.px.iocs.length, mined: w.ch.mined.size };
    const { deps, singles, basis } = n7(w);
    const res = await runCloseAll(asRun(planCloseAll(input(w, ex.position.get()))), deps(ex));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/^Couldn't close the fixed-rate lock first, so nothing else was sent.*Your other positions weren't touched\.$/);
    expect(w.px.iocs.length).toBe(before.iocs);
    expect(w.ch.mined.size).toBe(before.mined + 1); // only the reverted swap tx
    expect([singles, basis]).toEqual([[], []]);
    expect(w.ch.swapNet).toBe(-1_000n * WAD);
    expect((await positionStore(kv.kv, 10143, ME).load()).sizeWad).toBe(1_000n * WAD);
  });

  it("refused routes send nothing and store nothing (a kill there leaves nothing to resume)", async () => {
    const w = world();
    w.ch.swapNet = -1_000n * WAD;
    const kv = memKv();
    const r = planCloseAll(input(w, FLAT));
    expect(r.kind).toBe("refused");
    expect(kv.m.size).toBe(0);
    expect(await executor(() => w, kv.kv).resume()).toBeUndefined();
    expect([w.ch.mined.size, w.px.iocs.length]).toEqual([0, 0]);
  });

  it("an Earn leftover (MANUAL) closed by Close all's single close shrinks in the record, as from the Earn screen", async () => {
    const w = world({ perplFill: (p) => (p.reduceOnly ? 0 : p.sizeLns), meridianFill: () => "revert" });
    const kv = memKv();
    const ex = executor(() => w, kv.kv);
    expect((await ex.open(PLAN, META))!.phase).toBe("MANUAL");
    expect(ex.position.get().naked).toEqual({ venue: "perpl", side: "buy", sizeWad: 300n * WAD });
    const { deps, singles } = n7(w);
    const r = asRun(planCloseAll(input(w, ex.position.get(), { swapMarket: false })));
    expect(r.kind).toBe("plain");
    await runCloseAll(r, deps(ex));
    expect(singles).toEqual([{ venue: "perpl", side: "sell", sizeWad: 300n * WAD }]);
    expect(ex.position.get().naked).toBeUndefined();
    expect((await positionStore(kv.kv, 10143, ME).load()).naked).toBeUndefined();
  });

  it("a fallback pair with no Earn record runs N7's two-leg close (the Earn executor is never asked)", async () => {
    const w = world();
    w.ch.net = -300n * WAD;
    w.px.net = 300;
    const kv = memKv();
    const ex = executor(() => w, kv.kv);
    const close = jest.spyOn(ex, "close");
    const { deps, basis } = n7(w);
    const res = await runCloseAll(asRun(planCloseAll(input(w, FLAT))), deps(ex));
    expect(res).toEqual({ ok: true, title: "Basis trade closed", detail: "both" });
    expect(basis).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("kill at every persisted snapshot of Close all's Earn run → resume (fresh executor, nothing in memory)", () => {
  for (const [name, v, ends] of [
    ["lock closes", ALL, /^(CLOSED|ABORTED)$/],
    ["lock won't close", { ...ALL, swapFill: (o: { reduceOnly: boolean; lots: bigint }) => (o.reduceOnly ? ("revert" as const) : o.lots) }, /^ABORTED$/],
  ] as const) {
    it(`${name}: terminal, nothing sent twice, the lock never left without its hedge, the record matches the venues`, async () => {
      const w0 = world(v as Venues);
      const { kv, m } = memKv();
      await executor(() => w0, kv).open(LPLAN, LMETA);
      const caps: { rec: string; w: World; kv: Map<string, string> }[] = [];
      const runs = earnRecordStore(kv, 10143, ME);
      const spy = { ...runs, save: async (r: EarnRecord) => { caps.push({ rec: encodeEarnRecord(r), w: { px: w0.px.clone(), ch: w0.ch.clone(), coll: { calls: 0 } }, kv: new Map(m) }); await runs.save(r); } };
      const ref = executor(() => w0, kv, { runs: spy });
      await ref.loadPosition();
      const { deps } = n7(w0);
      await runCloseAll(asRun(planCloseAll(input(w0, ref.position.get()))), deps(ref));
      const endW = { px: w0.px.clone(), ch: w0.ch.clone() };
      expect(caps.length).toBeGreaterThan(2);
      for (let k = 0; k < caps.length; k++) {
        for (const late of [false, true]) {
          const at = late ? (caps[k + 1]?.w ?? { ...endW, coll: { calls: 0 } }) : caps[k]!.w;
          const w: World = { px: at.px.clone(), ch: at.ch.clone(), coll: { calls: 0 } };
          const store = memKv(caps[k]!.kv);
          store.m.set(RUN_KEY, caps[k]!.rec);
          const ex = executor(() => w, store.kv);
          const t = await ex.resume();
          const where = `${name} snapshot ${k} ${late ? "late" : "early"}`;
          expect([where, t?.phase]).toEqual([where, expect.stringMatching(ends)]);
          expect([where, w.px.iocs.length <= endW.px.iocs.length, w.ch.mined.size <= endW.ch.mined.size]).toEqual([where, true, true]);
          const pos = await positionStore(store.kv, 10143, ME).load();
          // the lock is open only while the pair it fixes is
          expect([where, w.ch.swapNet !== 0n && pos.sizeWad === 0n]).toEqual([where, false]);
          // the record matches the venues: the hedged size is what Meridian holds, any one-sided rest is the leftover
          expect([where, -w.ch.net]).toEqual([where, pos.sizeWad]);
          expect([where, venueNet(w)]).toEqual([where, await shownLeftover(store.kv)]);
          if (t?.phase === "CLOSED") expect([where, flat(pos), w.ch.swapNet]).toEqual([where, [0n, undefined, undefined], 0n]);
          // and Close all, tapped again, routes from the record that's left (never a stale pair)
          const again = planCloseAll(input(w, pos));
          expect([where, again.kind]).toEqual([where, pos.sizeWad > 0n ? "earn" : "empty"]);
        }
      }
    });
  }
});

describe("N8 D4.1: the lock's market comes from config, not from the swap reader", () => {
  it("swapMarketDeployed reads deployments/<chain>.json (FundingSwapMarket + SwapOrderBook)", () => {
    expect(swapMarketDeployed(tryReadMeridianDeployment(meridian10143, 10143))).toBe(true);
    const noSwap = JSON.parse(JSON.stringify(meridian10143)) as { contracts: Record<string, unknown> };
    delete noSwap.contracts.SwapOrderBook;
    expect(swapMarketDeployed(tryReadMeridianDeployment(noSwap, 10143))).toBe(false);
    // mainnet before N9: no deployments/143.json
    expect(swapMarketDeployed(tryReadMeridianDeployment(undefined, 143))).toBe(false);
  });

  it("market deployed, reader not created yet (inputs.swap undefined) ⇒ Close all and the Earn close WAIT, never treat the lock as 0", () => {
    const w = world();
    w.ch.net = -300n * WAD;
    w.px.net = 300;
    const pos: EarnPosition = { v: 1, perplSide: "buy", sizeWad: 300n * WAD, naked: undefined, applied: [] };
    const i = input(w, pos);
    const swapMarket = swapMarketDeployed(tryReadMeridianDeployment(meridian10143, 10143));
    const noReader = { ...i.inputs, swap: undefined };
    expect(planCloseAll({ ...i, swapMarket, inputs: noReader })).toEqual({ kind: "wait", reason: LOCK_UNKNOWN });
    expect(planEarnPairClose(pos, noReader, swapMarket)).toEqual({ ok: false, error: LOCK_UNKNOWN });
  });
});
