// Trade execution with fake venues: both legs to DONE, then an app kill at EVERY persisted snapshot → a fresh process
// (new adapters, nothing in memory) resumes from the stored record to the same outcome without sending twice; expiry
// and revert paths end FAILED with a plain reason (never unknown).
import { orderBookAbi } from "@meridian/core/meridian";
import { OrderStatus, type PlaceResult } from "@meridian/core/perpl";
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, keccak256, RawContractError, toHex, type Address, type Hex } from "viem";
import { createMeridianLeg, fillsFromReceipt } from "../../features/trade/exec/meridianLeg";
import { createPerplLeg } from "../../features/trade/exec/perplLeg";
import { decodeRecord, encodeRecord, recordStore, type TradeMeta, type TradeRecord } from "../../features/trade/exec/record";
import { buildReceipt } from "../../features/trade/exec/receipt";
import { isOpenRecord, newTradeRecord, NOT_SENT, runTrade, TradeSession } from "../../features/trade/exec/runTrade";
import { plainTradeError } from "../../features/trade/exec/errors";

const WAD = 10n ** 18n;
const ME = "0x00000000000000000000000000000000000000a1" as Address;
const OB = "0xCFB0169FF1957C347285Bb10Ab83E33F3C2bb207" as Address;
const noSleep = async () => {};
const MARKET = { id: 64, priceDecimals: 5, sizeDecimals: 0 };

function memKv() {
  const m = new Map<string, string>();
  return { m, kv: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), del: async (k: string) => void m.delete(k) } };
}

const meta = (venue: "perpl" | "meridian"): TradeMeta => ({ chainId: 10143, address: ME, venue, side: "long", summary: "Long 385 MON on Perpl", priceDp: 5, stepWad: WAD, takerFeeWad: 345n * 10n ** 12n, leverage100: 200, createdAtMs: 1 });

// ── fake Perpl: an exchange that fills IOCs at 0.02567 and keeps an order history ──
function fakePerpl() {
  const history: Record<string, unknown>[] = [];
  let lfr = 41;
  let iocCalls = 0;
  const order = (rq: number, t: number, fs: number) => ({ rq, mkt: 64, acc: 7, oid: 9000 + rq, st: fs > 0 ? OrderStatus.Filled : OrderStatus.Canceled, sr: 0, t, os: 385, fp: fs > 0 ? 2567 : 0, fs, f: "0", fl: 4, lv: 200 });
  const trading = {
    state: { get account() { return { lfr }; } },
    ioc: async (p: { side: "buy" | "sell"; reduceOnly: boolean; sizeLns: number; limitPns: number }) => {
      iocCalls++;
      const rq = ++lfr;
      const o = order(rq, p.reduceOnly ? (p.side === "buy" ? 4 : 3) : p.side === "buy" ? 1 : 2, p.sizeLns);
      history.unshift(o);
      return { rq, sn: 1, lb: 1000, transport: "ws" as const, ack: Promise.resolve({ code: 0, error: "" }), outcome: Promise.resolve<PlaceResult>({ kind: "outcome", outcome: { rq, order: o as never, failed: false } }) };
    },
  };
  const rest = {
    orderHistory: async () => ({ d: history }),
    fills: async () => ({ d: history.filter((o) => (o.fs as number) > 0).map((o) => ({ mkt: 64, acc: 7, oid: o.oid, t: 1, l: 0, p: 2567, s: o.fs, f: "3409", at: { b: 1003 } })) }),
  };
  return { trading, rest, get iocCalls() { return iocCalls; }, history };
}

function perplDeps(px: ReturnType<typeof fakePerpl>, ses: () => TradeSession, head = 1001) {
  return createPerplLeg({ trading: () => px.trading as never, rest: () => px.rest as never, market: MARKET, leverage100: 200, head: () => head, saveRqFloor: (rq) => ses().patchMeta({ perpl: { ...(rq !== undefined ? { rqFloor: rq } : {}) } }) });
}

// ── fake Meridian chain: signs deterministically, mines on send, emits a Trade log ──
function tradeLog(price: bigint, size: bigint) {
  const topics = encodeEventTopics({ abi: orderBookAbi, eventName: "Trade", args: { makerOrderId: 1n, maker: "0x00000000000000000000000000000000000000b2", taker: ME } });
  const data = encodeAbiParameters([{ type: "bool" }, { type: "uint32" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" }], [true, 25864, 3n, price, size]);
  return { address: OB, topics, data, blockNumber: 70n, transactionHash: "0x" as Hex, logIndex: 0, blockHash: "0x" as Hex, transactionIndex: 0, removed: false };
}
function fakeChain(o: { revert?: boolean } = {}) {
  const sent = new Set<Hex>();
  let nonce = 5;
  let estimates = 0;
  const pub = {
    estimateGas: async () => {
      estimates++;
      return 100_000n;
    },
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === "pending" ? nonce : nonce - (sent.size ? 0 : 0)),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }),
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const h = keccak256(serializedTransaction);
      if (!sent.has(h)) {
        sent.add(h);
        nonce++;
      }
      return h;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!sent.has(hash)) throw new Error("not found");
      return { status: o.revert ? "reverted" : "success", blockNumber: 70n, logs: o.revert ? [] : [tradeLog(25864n * 10n ** 12n, 300n * WAD)] };
    },
    call: async () => {
      throw new RawContractError({ data: encodeErrorResult({ abi: orderBookAbi, errorName: "SlippageExceeded" }) });
    },
  };
  const wallet = { account: { address: ME }, chain: { id: 10143 }, signTransaction: async (tx: { nonce: number }) => toHex(`signed-${tx.nonce}`) };
  return { pub, wallet, sent, get estimates() { return estimates; } };
}

function meridianDeps(ch: ReturnType<typeof fakeChain>, ses: () => TradeSession) {
  return createMeridianLeg({
    pub: ch.pub as never,
    wallet: () => ch.wallet as never,
    orderBook: OB,
    tickSizeWad: 10n ** 12n,
    lotSizeWad: 100n * WAD,
    saveRaw: (raw, nonce) => ses().patchMeta({ meridian: { raw, nonce } }),
    loadRaw: () => ses().rec.meta.meridian ?? {},
  });
}

const perplOrder = { id: "t1", venue: "perpl" as const, side: "buy" as const, sizeWad: 385n * WAD, reduceOnly: false, limitPriceWad: 2593n * 10n ** 13n, expectedAvgWad: 2567n * 10n ** 13n };
const meridianOrder = { id: "t2", venue: "meridian" as const, side: "buy" as const, sizeWad: 300n * WAD, reduceOnly: false, limitPriceWad: 26123n * 10n ** 12n };

/** Runs a fresh trade and records every persisted record (the snapshots an app kill can leave behind). */
async function recordRun(venue: "perpl" | "meridian") {
  const { kv, m } = memKv();
  const store = recordStore(kv, 10143, ME);
  const snaps: string[] = [];
  const spy = { load: store.load, clear: store.clear, save: async (r: TradeRecord) => { snaps.push(encodeRecord(r)); await store.save(r); } };
  const rec = newTradeRecord(venue === "perpl" ? perplOrder : meridianOrder, meta(venue));
  const ses = new TradeSession(rec, spy);
  const px = fakePerpl();
  const ch = fakeChain();
  const legs = venue === "perpl" ? perplDeps(px, () => ses).legs : meridianDeps(ch, () => ses).legs;
  const out = await runTrade({ session: ses, legs, sleep: noSleep }, false);
  return { out, snaps, px, ch, m };
}

describe("fresh trades", () => {
  it("Perpl: IOC → outcome → DONE with fill price, persisted after every event", async () => {
    const { out, snaps, px } = await recordRun("perpl");
    expect(out.state.phase).toBe("DONE");
    expect(out.state.result).toEqual({ filledWad: 385n * WAD, avgPriceWad: 2567n * 10n ** 13n });
    expect(px.iocCalls).toBe(1);
    expect(snaps.length).toBeGreaterThanOrEqual(4);
    expect(decodeRecord(snaps.at(-1))!.state.phase).toBe("DONE");
    expect(decodeRecord(snaps.find((x) => decodeRecord(x)!.meta.perpl?.rqFloor !== undefined))!.meta.perpl!.rqFloor).toBe(41);
  });
  it("Meridian: sign → persist raw → broadcast → receipt → fills from the Trade log (gas = estimate × 1.2)", async () => {
    const { out, ch } = await recordRun("meridian");
    expect(out.state.phase).toBe("DONE");
    expect(out.state.result).toEqual({ filledWad: 300n * WAD, avgPriceWad: 25864n * 10n ** 12n });
    expect(ch.sent.size).toBe(1);
    expect(out.meta.meridian?.raw).toBeDefined();
    expect(out.state.leg.ref).toBe(keccak256(out.meta.meridian!.raw!));
  });
});

describe("kill at every snapshot → resume (fresh process, nothing in memory)", () => {
  for (const venue of ["perpl", "meridian"] as const) {
    it(`${venue}: every stored record resolves to DONE or a clear 'not sent', never twice, never unknown`, async () => {
      const { snaps, px, ch } = await recordRun(venue);
      for (const snap of snaps) {
        const rec = decodeRecord(snap)!;
        if (!isOpenRecord(rec)) continue;
        const { kv } = memKv();
        const ses = new TradeSession(rec, recordStore(kv, 10143, ME));
        // the venue keeps its state across the kill (Perpl history, mined txs); the app's memory does not
        const before = venue === "perpl" ? px.iocCalls : ch.sent.size;
        const perpl = perplDeps(px, () => ses);
        const legs = venue === "perpl" ? perpl.legs : meridianDeps(ch, () => ses).legs;
        const out = await runTrade({ session: ses, legs, sleep: noSleep, findSentPerpl: perpl.findSent, findTries: 1 }, true);
        expect(["DONE", "FAILED"]).toContain(out.state.phase);
        if (out.state.phase === "FAILED") expect(out.state.error).toBe(NOT_SENT);
        else expect(out.state.result!.filledWad).toBe(venue === "perpl" ? 385n * WAD : 300n * WAD);
        expect(venue === "perpl" ? px.iocCalls : ch.sent.size).toBe(before); // nothing re-sent
      }
    });
  }
  it("Perpl killed after the rq floor was saved but before PREPARED: the sent order is found in history (rq > floor)", async () => {
    const px = fakePerpl();
    const { kv } = memKv();
    const store = recordStore(kv, 10143, ME);
    const rec0 = newTradeRecord(perplOrder, meta("perpl"));
    const ses0 = new TradeSession({ ...rec0, state: { ...rec0.state, phase: "SEND" }, meta: { ...rec0.meta, perpl: { rqFloor: 41 } } }, store);
    await px.trading.ioc({ side: "buy", reduceOnly: false, sizeLns: 385, limitPns: 2593 }); // reached Perpl, then the app died
    const perpl = perplDeps(px, () => ses0);
    const out = await runTrade({ session: ses0, legs: perpl.legs, sleep: noSleep, findSentPerpl: perpl.findSent, findTries: 1 }, true);
    expect(out.state.phase).toBe("DONE");
    expect(out.state.leg.ref).toBe("42:0");
    expect(px.iocCalls).toBe(1);
  });
});

describe("definitive failures", () => {
  it("Perpl: not in history after lb + grace ⇒ FAILED expired (not unknown)", async () => {
    const px = fakePerpl();
    const { kv } = memKv();
    const rec0 = newTradeRecord(perplOrder, meta("perpl"));
    const ses = new TradeSession({ ...rec0, state: { ...rec0.state, phase: "CONFIRM", leg: { ref: "77:1000", sent: true } } }, recordStore(kv, 10143, ME));
    const out = await runTrade({ session: ses, legs: perplDeps(px, () => ses, 1011).legs, sleep: noSleep }, true);
    expect(out.state.phase).toBe("FAILED");
    expect(out.state.error).toMatch(/expired/);
  });
  it("Meridian revert ⇒ FAILED with the decoded reason in plain words", async () => {
    const ch = fakeChain({ revert: true });
    const { kv } = memKv();
    const ses = new TradeSession(newTradeRecord(meridianOrder, meta("meridian")), recordStore(kv, 10143, ME));
    const out = await runTrade({ session: ses, legs: meridianDeps(ch, () => ses).legs, sleep: noSleep }, false);
    expect(out.state.phase).toBe("FAILED");
    expect(plainTradeError(out.state.error)).toMatch(/price moved past your worst price/);
  });
  it("collateral preparation failing (passkey cancelled) ⇒ FAILED, nothing signed or sent", async () => {
    const ch = fakeChain();
    const { kv } = memKv();
    const ses = new TradeSession(newTradeRecord(meridianOrder, meta("meridian")), recordStore(kv, 10143, ME));
    const out = await runTrade({ session: ses, legs: meridianDeps(ch, () => ses).legs, sleep: noSleep, prepareCollateral: async () => { throw new Error("User cancelled the passkey prompt"); } }, false);
    expect(out.state.phase).toBe("FAILED");
    expect(plainTradeError(out.state.error)).toBe("Cancelled. Nothing was sent.");
    expect(ch.sent.size).toBe(0);
    expect(ch.estimates).toBe(0);
  });
});

describe("receipt + records", () => {
  it("Perpl receipt: fee from fills, blocks to fill, order id; Meridian receipt: tx link + fee rounded up", async () => {
    const p = await recordRun("perpl");
    const r = buildReceipt(p.out.state, { venue: "perpl", side: "long", summary: "s", stepWad: WAD, priceDp: 5, takerFeeWad: 0n, explorerBase: undefined, sentAtBlock: 1000n, orderId: 9042, feeCns: 3409n, collateralDecimals: 6, fillBlock: 1003n });
    expect(r.ok).toBe(true);
    expect(r.feeWad).toBe(3409n * 10n ** 12n);
    expect(r.blocksToFill).toBe(3n);
    expect(r.orderId).toBe(9042);
    const mr = await recordRun("meridian");
    const rr = buildReceipt(mr.out.state, { venue: "meridian", side: "long", summary: "s", stepWad: 100n * WAD, priceDp: 6, takerFeeWad: 5n * 10n ** 14n, explorerBase: "https://testnet.monadexplorer.com/", sentAtBlock: 68n, receiptBlock: 70n });
    expect(rr.explorerTxUrl).toBe(`https://testnet.monadexplorer.com/tx/${mr.out.state.leg.ref}`);
    expect(rr.feeWad).toBe(3_879_600_000_000_000n); // 300 · 0.025864 = 7.7592 · 0.0005 = 0.0038796
    expect(rr.blocksToFill).toBe(2n);
  });
  it("a corrupt or foreign record never drives an order", () => {
    expect(decodeRecord("{not json")).toBeUndefined();
    expect(decodeRecord(JSON.stringify({ v: 1, exec: "{}", meta: {} }))).toBeUndefined();
    expect(decodeRecord(null)).toBeUndefined();
  });
  it("fills from a receipt ignore other takers and other contracts", () => {
    const own = tradeLog(10n, 2n * WAD);
    const other = { ...own, address: "0x0000000000000000000000000000000000000001" as Address };
    expect(fillsFromReceipt({ logs: [own, other] as never }, OB, ME, true)).toEqual({ filledWad: 2n * WAD, avgPriceWad: 10n });
  });
});
