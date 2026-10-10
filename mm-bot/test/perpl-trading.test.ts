import { describe, expect, it } from "vitest";
import { parseSecret } from "../src/perpl/auth";
import { TokenBucket } from "../src/perpl/ratelimit";
import { PerplState, availableCollateral } from "../src/perpl/state";
import { PerplTrading, tradingReconnectDelayMs, type TradingConfig } from "../src/perpl/trading";
import { FakeClock, FakeWs, flush, sentAtLeast } from "./fakes";

const secret = parseSecret("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"); // RFC 8032 test key
const ACC = 77;
const account = (over: Record<string, unknown> = {}) => ({ in: 12, id: ACC, fr: false, fw: true, ft: 0, lfr: 41, b: "5000000000", lb: "0", ...over });
const wallet = (sn = 1_000) => ({ mt: 19, sn, at: { b: sn }, addr: "0xabc", n: 0, fl: 0, as: [account()] });
const order = (rq: number, over: Record<string, unknown> = {}) => ({ rq, mkt: 64, acc: ACC, oid: 9000 + rq, scid: 0, st: 4, sr: 43, t: 1, os: 100, fp: 2580, fs: 100, f: "0", fl: 4, mm: 0, lv: 500, ...over });
const pos = (pid: number, sd: number, s: number, st = 1, mkt = 64) => ({ mkt, acc: ACC, pid, rq: 1, oid: 1, st, sr: 21, sd, c: "100", ep: 2580, s, fee: "0", efs: 0, lv: 500, xfs: 0, ots: {} });

function harness(over: Partial<TradingConfig> = {}) {
  const clock = new FakeClock();
  const sockets: FakeWs[] = [];
  const restCalls: { url: string; init: RequestInit }[] = [];
  let restReply: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  const fetchFn = (async (url: string, init: RequestInit) => {
    restCalls.push({ url, init });
    const r = restReply(url);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  const t = new PerplTrading({
    apiUrl: "https://testnet.perpl.xyz/api",
    wsUrl: "wss://testnet.perpl.xyz",
    chainId: 10143,
    apiKey: "key-token",
    secret,
    marketId: 64,
    orderTtlBlocks: 20,
    clock,
    fetchFn,
    random: (n) => Uint8Array.from({ length: n }, (_, i) => (i + clock.t) % 256),
    factory: (u) => {
      const w = new FakeWs(u);
      sockets.push(w);
      return w;
    },
    ...over,
  });
  return { t, clock, sockets, restCalls, setRest: (f: typeof restReply) => (restReply = f), ws: () => sockets.at(-1)! };
}

async function readyHarness(over: Partial<TradingConfig> = {}) {
  const h = harness(over);
  h.t.start();
  h.ws().open();
  await sentAtLeast(h.ws());
  h.ws().msg(wallet());
  h.ws().msg({ mt: 23, sn: 1_000, d: [] });
  h.ws().msg({ mt: 26, sn: 1_000, d: [] });
  h.ws().msg({ mt: 100, sn: 1_001, h: 5_000 });
  return h;
}

describe("trading WebSocket session", () => {
  it("first frame is the signed mt: 29 sign-in on /ws/v1/trading; ready after the three snapshots", async () => {
    const h = harness();
    h.t.start();
    expect(h.ws().url).toBe("wss://testnet.perpl.xyz/ws/v1/trading");
    h.ws().open();
    await sentAtLeast(h.ws());
    expect(h.ws().sent[0]).toMatchObject({ mt: 29, chain_id: 10143, api_key: "key-token" });
    expect(h.ws().sent[0]!.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(h.t.ready).toBe(false);
    h.ws().msg(wallet());
    h.ws().msg({ mt: 23, d: [] });
    expect(h.t.ready).toBe(false);
    h.ws().msg({ mt: 26, d: [] });
    expect(h.t.ready).toBe(true);
    expect(h.t.state.account).toMatchObject({ id: ACC, fw: true, lfr: 41 });
  });

  it("place: mt: 22 with unique sn, rq = lfr + 1, lb = head + order_ttl_blocks; code 0 is only an ack, the outcome is mt: 24", async () => {
    const h = await readyHarness();
    const p = await h.t.place({ mkt: 64, t: 1, p: 2600, s: 100, fl: 4, lv: 500 });
    expect(p).toMatchObject({ rq: 42, sn: 1, lb: 5_020, transport: "ws" });
    expect(h.ws().sent.at(-1)).toEqual({ mt: 22, sn: 1, rq: 42, mkt: 64, acc: ACC, t: 1, p: 2600, s: 100, fl: 4, lv: 500, lb: 5_020 });
    let settled = false;
    void p.outcome.then(() => (settled = true));
    h.ws().msg({ mt: 3, sid: 100, sn: 7, cid: 1, status: { code: 0, error: "" } });
    expect(await p.ack).toEqual({ code: 0, error: "" });
    await flush();
    expect(settled).toBe(false); // accepted for forwarding ≠ filled
    h.ws().msg({ mt: 24, d: [order(42, { st: 4, fs: 100 })] });
    expect(await p.outcome).toMatchObject({ kind: "outcome", outcome: { rq: 42, failed: false, order: { fs: 100 } } });
    const p2 = await h.t.place({ mkt: 64, t: 2, p: 2500, s: 50, fl: 4, lv: 500 });
    expect(p2).toMatchObject({ rq: 43, sn: 2 });
  });

  it("rq stays above an lfr that moved (another client of the wallet)", async () => {
    const h = await readyHarness();
    h.ws().msg({ mt: 21, ...account({ lfr: 900 }) });
    expect((await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 })).rq).toBe(901);
  });

  it("gateway rejection (non-zero mt: 3) ⇒ rejected, no mt: 24 awaited", async () => {
    const h = await readyHarness();
    const p = await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    h.ws().msg({ mt: 3, sid: 100, cid: p.sn, status: { code: 400, error: "last exec block already expired" } });
    expect(await p.outcome).toEqual({ kind: "rejected", code: 400, error: "last exec block already expired" });
  });

  it("forwarding not allowed: ack code 0, then mt: 24 st 7 / sr 34 ⇒ a failed outcome (README)", async () => {
    const h = await readyHarness();
    const p = await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    h.ws().msg({ mt: 3, cid: p.sn, status: { code: 0 } });
    h.ws().msg({ mt: 24, d: [order(p.rq, { st: 7, sr: 34, oid: 0, fs: 0 })] });
    expect(await p.outcome).toMatchObject({ kind: "outcome", outcome: { failed: true, order: { sr: 34 } } });
  });

  it("dedup: first non-failure is definitive even after an earlier failure; later failures ignored", () => {
    const s = new PerplState(64, ACC);
    s.apply({ mt: 24, d: [order(5, { st: 7, sr: 36 })] }, 1);
    expect(s.outcome(5)?.failed).toBe(true);
    const ev = s.apply({ mt: 24, d: [order(5, { st: 3, fs: 40 })] }, 2);
    expect(ev.some((e) => e.kind === "outcome")).toBe(true);
    expect(s.outcome(5)).toMatchObject({ failed: false, order: { st: 3 } });
    s.apply({ mt: 24, d: [order(5, { st: 7, sr: 44 })] }, 3);
    expect(s.outcome(5)).toMatchObject({ failed: false });
    s.apply({ mt: 24, d: [order(5, { st: 4, fs: 100 })] }, 4); // same order progressing: latest fs kept
    expect(s.outcome(5)?.order.fs).toBe(100);
  });

  it("no status by lb + grace blocks ⇒ unknown (caller reconciles), never assumed filled", async () => {
    const h = await readyHarness({ outcomeGraceBlocks: 5 });
    const p = await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    h.ws().msg({ mt: 100, sn: 1_002, h: 5_024 });
    h.ws().msg({ mt: 100, sn: 1_003, h: 5_025 });
    expect(await p.outcome).toMatchObject({ kind: "unknown" });
  });

  it("close 3401 ⇒ in-flight orders unknown, reconnect with a FRESH sign-in (new timestamp + nonce)", async () => {
    const h = await readyHarness();
    const p = await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    const first = h.ws().sent[0]!;
    h.ws().serverClose(3401, "unauthorized");
    expect(await p.outcome).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/3401/) });
    expect(h.t.stats.authFailures).toBe(1);
    h.clock.advance(1_000);
    expect(h.sockets).toHaveLength(2);
    h.ws().open();
    await sentAtLeast(h.ws());
    expect(h.ws().sent[0]).toMatchObject({ mt: 29 });
    expect(h.ws().sent[0]!.timestamp).not.toBe(first.timestamp);
    expect(h.ws().sent[0]!.nonce).not.toBe(first.nonce);
    expect(h.t.ready).toBe(false); // snapshots must come again
  });

  it("heartbeat gap ⇒ force reconnect (websocket.md Heartbeat (Trading))", async () => {
    const h = await readyHarness();
    h.ws().msg({ mt: 100, sn: 1_005, h: 5_004 });
    expect(h.sockets[0]!.closed).toMatchObject({ code: 4000 });
    expect(h.t.stats.gaps).toBe(1);
    h.clock.advance(1_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("rate limit: the bucket refuses before the server would close with 1008; pings spend tokens", async () => {
    const h = await readyHarness({ burst: 3, ratePerMin: 50, pingEveryMs: 30_000 });
    // sign-in took one token; two left
    await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    await expect(h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 })).rejects.toThrow(/budget/);
    expect(h.t.stats.throttled).toBe(1);
    expect(h.t.throttleMs()).toBeGreaterThan(0);
    h.clock.advance(30_000);
    expect(h.ws().sent.filter((f) => f.mt === 1)).toHaveLength(1);
  });

  it("1008 idle timeout on a signed-in socket ⇒ keep-alive tightened to 8 s (testnet idle window is 10 s)", async () => {
    const h = await readyHarness({ pingEveryMs: 30_000 });
    h.ws().serverClose(1008, "idle timeout");
    h.clock.advance(1_000);
    h.ws().open();
    await sentAtLeast(h.ws());
    h.clock.advance(8_000);
    expect(h.ws().sent.filter((f) => f.mt === 1)).toHaveLength(1);
  });

  it("refuses to send without a head block or an account", async () => {
    const h = harness();
    h.t.start();
    h.ws().open();
    await sentAtLeast(h.ws());
    await expect(h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 })).rejects.toThrow(/no account/);
    h.ws().msg(wallet());
    await expect(h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 })).rejects.toThrow(/no head block/);
  });

  it("REST fallback when the socket isn't ready: signed POST /v1/trading/orders, batch of one; outcome from order-history", async () => {
    const h = await readyHarness();
    h.ws().serverClose(1006);
    let polls = 0;
    h.setRest((url) => {
      if (url.endsWith("/v1/trading/orders")) return { status: 200, body: { mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] } };
      polls++;
      return { status: 200, body: { d: polls < 2 ? [] : [order(42, { st: 4 })], np: "" } };
    });
    const p = await h.t.place({ mkt: 64, t: 1, p: 2600, s: 100, fl: 4, lv: 500 });
    expect(p.transport).toBe("rest");
    const post = h.restCalls[0]!;
    expect(post.url).toBe("https://testnet.perpl.xyz/api/v1/trading/orders");
    expect(post.init.method).toBe("POST");
    const hdr = post.init.headers as Record<string, string>;
    expect(Object.keys(hdr)).toEqual(expect.arrayContaining(["X-API-Key", "X-API-Timestamp", "X-API-Nonce", "X-API-Signature"]));
    expect(JSON.parse(post.init.body as string)).toEqual({ sn: 1, d: [{ mkt: 64, t: 1, p: 2600, s: 100, fl: 4, lv: 500, rq: 42, acc: ACC, lb: 5_020 }] });
    expect(await p.ack).toEqual({ code: 0, error: "" });
    // advance until the poll loop settles: signing each GET takes several event-loop turns, so on a slow runner the
    // next poll's timer can be registered after a fixed number of advances (bounded like the client's 10 polls)
    let settled = false;
    void p.outcome.then(() => (settled = true));
    for (let i = 0; i < 10 && !settled; i++) {
      h.clock.advance(1_000);
      for (let j = 0; j < 5 && !settled; j++) await flush();
    }
    expect(await p.outcome).toMatchObject({ kind: "outcome", outcome: { rq: 42 } });
    expect(h.restCalls.some((c) => c.url.endsWith("/v1/trading/order-history?count=20"))).toBe(true);
  });

  it("REST per-order refusal (statuses[0]) ⇒ rejected", async () => {
    const h = await readyHarness();
    h.ws().serverClose(1006);
    h.setRest(() => ({ status: 200, body: { mt: 31, status: { code: 0 }, statuses: [{ code: 403, error: "invalid account" }] } }));
    const p = await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    expect(await p.outcome).toEqual({ kind: "rejected", code: 403, error: "invalid account" });
  });

  it("restSnapshot reconciles from GET wallet/orders/positions; 404 = no exchange account", async () => {
    const h = harness();
    h.setRest((url) => {
      if (url.endsWith("/wallet")) return { status: 200, body: wallet(7_000) };
      if (url.endsWith("/orders")) return { status: 200, body: { mt: 23, sn: 7_000, d: [order(3, { st: 2, oid: 5 })] } };
      return { status: 200, body: { mt: 26, sn: 7_000, d: [pos(1, 2, 300)] } };
    });
    await h.t.restSnapshot();
    expect(h.t.state.account?.fw).toBe(true);
    expect(h.t.state.netSize()).toBe(-300);
    expect(h.t.openOrders().map((o) => o.oid)).toEqual([5]);
    expect(h.t.lastExecBlock()).toBe(7_020);
    h.setRest(() => ({ status: 404, body: { error: "not found" } }));
    await expect(h.t.restSnapshot()).rejects.toMatchObject({ status: 404 });
  });

  it("stop() closes, fails in-flight as unknown, never reconnects", async () => {
    const h = await readyHarness();
    const p = await h.t.place({ mkt: 64, t: 1, p: 1, s: 1, fl: 4, lv: 500 });
    h.t.stop();
    expect(await p.outcome).toMatchObject({ kind: "unknown", reason: "stopped" });
    h.clock.advance(120_000);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("PerplState positions / fills / collateral", () => {
  it("net position = Σ long − Σ short of OPEN positions in our market; snapshot replaces, update patches", () => {
    const s = new PerplState(64, ACC);
    s.apply({ mt: 26, d: [pos(1, 1, 500), pos(2, 2, 200), pos(3, 1, 999, 1, 16)] }, 1);
    expect(s.netSize()).toBe(300);
    s.apply({ mt: 27, d: [pos(1, 1, 500, 2)] }, 2); // closed
    expect(s.netSize()).toBe(-200);
    s.apply({ mt: 26, d: [] }, 3);
    expect(s.netSize()).toBe(0);
  });
  it("fills: only our market and account, bounded", () => {
    const s = new PerplState(64, ACC, 3);
    for (let i = 0; i < 5; i++) s.apply({ mt: 25, d: [{ mkt: 64, acc: ACC, oid: i, t: 1, l: 2, p: 2580, s: 10, f: "1" }, { mkt: 16, acc: ACC, oid: i, t: 1, l: 2, s: 1, f: "0" }] }, i);
    expect(s.fills.map((f) => f.oid)).toEqual([2, 3, 4]);
  });
  it("available collateral = b − lb, exact", () => {
    expect(availableCollateral(account({ b: "5000000000", lb: "1234567" }) as never)).toBe(4_998_765_433n);
  });
  it("malformed frames throw PerplFrameError (the client logs and drops them)", () => {
    const s = new PerplState(64);
    expect(() => s.apply({ mt: 21, id: "x" }, 1)).toThrow(/account/);
    expect(() => s.apply("nope", 1)).toThrow(/mt/);
  });
});

describe("TokenBucket / reconnect delays", () => {
  it("50/min with burst 5: refills continuously", () => {
    const b = new TokenBucket(5, 50, 0);
    for (let i = 0; i < 5; i++) expect(b.tryTake(0)).toBe(true);
    expect(b.tryTake(0)).toBe(false);
    expect(b.waitMs(0)).toBe(1_200);
    expect(b.tryTake(1_200)).toBe(true);
    let n = 0;
    for (let t = 1_200; t <= 61_200; t += 100) if (b.tryTake(t)) n++;
    expect(n).toBeLessThanOrEqual(51);
  });
  it("1001 now; 1013 pauses 30 s; others follow the documented schedule", () => {
    expect(tradingReconnectDelayMs(1001, 3, () => 0.5)).toBe(0);
    expect(tradingReconnectDelayMs(1013, 0, () => 0.5)).toBe(31_000);
    expect(tradingReconnectDelayMs(3401, 0, () => 0.5)).toBe(1_000);
    expect(tradingReconnectDelayMs(1008, 99, () => 0.5)).toBe(60_000);
  });
});
