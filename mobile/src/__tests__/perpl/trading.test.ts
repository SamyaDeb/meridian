// One trading socket per app (Perpl: max 4 per wallet), closed in background, reopened on foreground, reconnects on
// core's schedule; and the IOC round trip through core exec/single with fills reconciled over REST. Real core
// PerplTrading, fake WebSocket + clock + REST. Frame shapes: core's trading fixtures (K3 testnet session, 8 Oct).
import { PerplTrading, createSignedRest, type TradingConfig } from "@meridian/core/perpl";
import type { Clock, FetchLike, WsLike } from "@meridian/core/util";
import { createPerplKeyring } from "../../venues/perpl/keyring";
import { runIoc } from "../../venues/perpl/ioc";
import { runningTradingSockets, TradingSocketManager } from "../../venues/perpl/tradingSocket";
import { seqPrf } from "../auth/authFixtures";

class FakeWs implements WsLike {
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close(code?: number, reason?: string) {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }
  msg(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

class Clk implements Clock {
  t = 1_791_400_000_000;
  q: { at: number; fn: () => void; id: number }[] = [];
  id = 0;
  now = () => this.t;
  random = () => 0.5;
  setTimeout = (fn: () => void, ms: number) => (this.q.push({ at: this.t + ms, fn, id: ++this.id }), this.id);
  clearTimeout = (h: unknown) => void (this.q = this.q.filter((x) => x.id !== h));
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const n = this.q[0];
      if (!n || n.at > end) break;
      this.q.shift();
      this.t = n.at;
      n.fn();
    }
    this.t = end;
  }
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const ACC = 1000;
const account = { in: 1, id: ACC, fr: false, fw: true, ft: 0, lfr: 0, b: "100000000", lb: "0" };

function rig(fills: unknown[] = []) {
  const clock = new Clk();
  const sockets: FakeWs[] = [];
  const restCalls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    restCalls.push(url);
    return { status: 200, text: async () => JSON.stringify(url.includes("/fills") ? { d: fills, np: "" } : {}), headers: { get: () => null } };
  };
  const key = createPerplKeyring(seqPrf(), 10143, 0);
  let draws = 0;
  const cfg = (): TradingConfig => ({
    apiUrl: "https://testnet.perpl.xyz/api",
    wsUrl: "wss://testnet.perpl.xyz",
    chainId: 10143,
    apiKey: "tok_0001_ABCDEFGHIJKLMNOPQRSTUVWXYZ-_",
    secret: key.signer(),
    marketId: 64,
    orderTtlBlocks: 20,
    clock,
    fetchFn,
    random: (n) => new Uint8Array(n).map((_, i) => (i + ++draws) % 256),
    factory: (u) => (sockets.push(new FakeWs(u)), sockets.at(-1)!),
  });
  const ticks: (() => void)[] = [];
  const m = new TradingSocketManager(cfg, undefined, (fn) => (ticks.push(fn), { cancel: () => ticks.splice(ticks.indexOf(fn), 1) }));
  const ready = async (ws: FakeWs) => {
    ws.onopen?.({});
    await settle();
    ws.msg({ mt: 19, sn: 1000, at: { b: 1000 }, addr: "0xabc", n: 0, fl: 0, as: [account] });
    ws.msg({ mt: 23, sn: 1000, d: [] });
    ws.msg({ mt: 26, sn: 1000, d: [] });
    ws.msg({ mt: 100, sn: 1001, h: 5_000 });
    ticks.forEach((f) => f()); // a heartbeat raises no core event: the manager's 1 s tick picks up the head
  };
  return { clock, sockets, m, ready, ticks, restCalls, key, fetchFn };
}

afterEach(() => expect(runningTradingSockets()).toBe(0));

describe("trading socket manager", () => {
  it("one signed-in socket; background closes it, foreground opens a fresh one; lock disables", async () => {
    const r = rig();
    r.m.enable();
    expect(r.sockets).toHaveLength(1);
    expect(r.sockets[0]!.url).toBe("wss://testnet.perpl.xyz/ws/v1/trading");
    await r.ready(r.sockets[0]!);
    expect(r.sockets[0]!.sent[0]).toMatchObject({ mt: 29, chain_id: 10143 });
    expect(r.m.store.get()).toMatchObject({ status: "ready", opens: 1, head: 5_000 });
    expect(runningTradingSockets()).toBe(1);
    r.m.enable(); // idempotent
    expect(r.sockets).toHaveLength(1);

    r.m.onAppState("background");
    expect(r.sockets[0]!.closed).toEqual({ code: 1000, reason: "stop" });
    expect(r.m.store.get().status).toBe("off");
    expect(runningTradingSockets()).toBe(0);
    r.m.onAppState("inactive"); // iOS-style transitional state: ignored
    r.m.onAppState("active");
    expect(r.sockets).toHaveLength(2);
    await r.ready(r.sockets[1]!);
    expect(r.m.store.get()).toMatchObject({ status: "ready", opens: 2 });
    expect(r.sockets[1]!.sent[0]).toMatchObject({ mt: 29 }); // signs in again, fresh nonce
    expect(r.sockets[1]!.sent[0]!.nonce).not.toBe(r.sockets[0]!.sent[0]!.nonce);

    r.m.disable();
    expect(runningTradingSockets()).toBe(0);
    r.m.onAppState("active");
    expect(r.sockets).toHaveLength(2); // disabled stays closed in the foreground
  });

  it("a second manager can't open another authenticated socket while one runs", async () => {
    const a = rig();
    const b = rig();
    a.m.enable();
    expect(() => b.m.enable()).toThrow(/already running/);
    a.m.disable();
    b.m.disable();
  });

  it("server drop ⇒ status 'connecting', core reconnects on its schedule and signs in again", async () => {
    const r = rig();
    r.m.enable();
    await r.ready(r.sockets[0]!);
    r.sockets[0]!.onclose?.({ code: 1006, reason: "abnormal" });
    r.ticks.forEach((f) => f());
    expect(r.m.store.get().status).toBe("connecting");
    r.clock.advance(1_250); // first delay 1 s ± 25 % (random 0.5 ⇒ 1 s)
    expect(r.sockets).toHaveLength(2);
    await r.ready(r.sockets[1]!);
    r.ticks.forEach((f) => f());
    expect(r.m.store.get()).toMatchObject({ status: "ready", opens: 1, connects: 2, closes: 1 });
    r.m.disable();
  });

  it("no token / key / ttl ⇒ nothing opens", () => {
    const m = new TradingSocketManager(() => undefined);
    m.enable();
    expect(m.store.get().status).toBe("off");
    expect(runningTradingSockets()).toBe(0);
  });
});

describe("IOC round trip (core exec/single)", () => {
  it("buy 1 lot with a 1% cap above the ask (rounded up), outcome mt 24, fills from REST (mt 25 may be late)", async () => {
    // fill shape: types.md "Fill"; price 2600 PNS at 5 dp = 0.026, fee 13 collateral units
    const r = rig([{ at: { b: 5_002 }, mkt: 64, acc: ACC, oid: 9001, t: 1, l: 2, p: 2600, s: 1, f: "13" }]);
    r.m.enable();
    const ws = r.sockets[0]!;
    await r.ready(ws);
    const t = r.m.client!;
    const rest = createSignedRest({ apiUrl: "https://testnet.perpl.xyz/api", chainId: 10143, apiKey: "tok_0001_ABCDEFGHIJKLMNOPQRSTUVWXYZ-_", secret: r.key.signer(), fetchFn: r.fetchFn, random: (n) => new Uint8Array(n) });
    const run = runIoc(
      { side: "buy", reduceOnly: false, sizeLns: 1, slippageBps: 100n, leverage: 100 },
      { trading: t, rest, market: { id: 64, priceDecimals: 5, sizeDecimals: 0 }, book: () => ({ bidWad: 25_900_000_000_000_000n, askWad: 26_000_000_000_000_000n }), sleep: async () => undefined },
    );
    await settle();
    const order = ws.sent.find((f) => f.mt === 22)!;
    expect(order).toMatchObject({ mkt: 64, t: 1, s: 1, fl: 4, lv: 100, p: 2626, acc: ACC, rq: 1, lb: 5_020 }); // 0.026 × 1.01 = 0.02626 ⇒ 2626
    ws.msg({ mt: 3, cid: order.sn, status: { code: 0 } });
    ws.msg({ mt: 24, sn: 1002, d: [{ rq: 1, mkt: 64, acc: ACC, oid: 9001, st: 4, sr: 43, t: 1, os: 1, fp: 2600, fs: 1, f: "13", fl: 4, lv: 100 }] });
    const res = await run;
    expect(res.state.phase).toBe("DONE");
    expect(res).toMatchObject({ rq: 1, orderId: 9001, limitPns: 2626, filledLns: 1, avgPriceWad: 26_000_000_000_000_000n, feeCns: 13n });
    expect(res.fills).toEqual([{ oid: 9001, priceWad: 26_000_000_000_000_000n, sizeLns: 1, feeCns: 13n, block: 5_002, maker: false }]);
    expect(r.restCalls.some((u) => u.includes("/v1/trading/fills"))).toBe(true);
    r.m.disable();
  });

  it("reduce-only close sells at the bid minus the cap, rounded DOWN; a gateway reject is FAILED with the reason", async () => {
    const r = rig();
    r.m.enable();
    const ws = r.sockets[0]!;
    await r.ready(ws);
    const rest = createSignedRest({ apiUrl: "https://x/api", chainId: 10143, apiKey: "tok_0001_ABCDEFGHIJKLMNOPQRSTUVWXYZ-_", secret: r.key.signer(), fetchFn: r.fetchFn, random: (n) => new Uint8Array(n) });
    const run = runIoc(
      { side: "sell", reduceOnly: true, sizeLns: 1, slippageBps: 100n, leverage: 100 },
      { trading: r.m.client!, rest, market: { id: 64, priceDecimals: 5, sizeDecimals: 0 }, book: () => ({ bidWad: 25_999_999_999_999_999n, askWad: undefined }), sleep: async () => undefined },
    );
    await settle();
    const order = ws.sent.find((f) => f.mt === 22)!;
    expect(order).toMatchObject({ t: 3, p: 2573, s: 1 }); // 0.025999…×0.99 = 0.0257399… ⇒ down to 2573
    ws.msg({ mt: 3, cid: order.sn, status: { code: 7, error: "insufficient margin" } });
    const res = await run;
    expect(res.state.phase).toBe("FAILED");
    expect(res.error).toMatch(/refused the order \(code 7: insufficient margin\)/);
    r.m.disable();
  });

  it("no ask on the book ⇒ FAILED before anything is sent", async () => {
    const r = rig();
    r.m.enable();
    await r.ready(r.sockets[0]!);
    const res = await runIoc(
      { side: "buy", reduceOnly: false, sizeLns: 1, slippageBps: 100n, leverage: 100 },
      { trading: r.m.client!, rest: {} as never, market: { id: 64, priceDecimals: 5, sizeDecimals: 0 }, book: () => ({ bidWad: undefined, askWad: undefined }), sleep: async () => undefined },
    );
    expect(res.state.phase).toBe("FAILED");
    expect(res.error).toMatch(/No asks/);
    expect(r.sockets[0]!.sent.some((f) => f.mt === 22)).toBe(false);
    await expect(runIoc({ side: "buy", reduceOnly: false, sizeLns: 0, slippageBps: 100n, leverage: 100 }, {} as never)).rejects.toThrow(/below one lot/);
    r.m.disable();
  });
});

// keep PerplTrading referenced (type import elision would hide a broken export)
expect(PerplTrading).toBeDefined();
