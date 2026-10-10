import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MarketDataFeed,
  MarketDataSocket,
  RETRY_DELAYS_MS,
  createPerplClient,
  feeForTier,
  fixtureTransport,
  parseContext,
  parseMarketDataFrame,
  perplRateToAprWad,
  perplVenueFromFeed,
  readPerplLive,
  reconnectDelayMs,
  type Clock,
  type FundingEvent,
  type FundingUpdate,
  type MarketDataFrame,
  type SocketEvent,
  type WsLike,
} from "../src/perpl";

// REAL frames recorded 7 Oct 2026 from wss://testnet.perpl.xyz/ws/v1/market-data with
// `pnpm --filter @meridian/mfi record:perpl-ws testnet 60` (fixtures/recorded/testnet/ws/*.jsonl).
const lines = (name: string) =>
  readFileSync(new URL(`../fixtures/recorded/testnet/ws/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { recvMs: number; frame: Record<string, unknown> });
const all = () =>
  ["control", "heartbeat", "market-config", "market-state", "funding", "order-book", "trades"]
    .flatMap((n) => lines(n))
    .sort((a, b) => a.recvMs - b.recvMs);
const ctx = parseContext(JSON.parse(readFileSync(new URL("../fixtures/recorded/testnet/context.json", import.meta.url), "utf8")));
const MON = ctx.markets.find((m) => m.id === 64)!;

function replay(feed: MarketDataFeed) {
  const updates: (FundingUpdate | "gap")[] = [];
  for (const { recvMs, frame } of all()) {
    const u = feed.apply(parseMarketDataFrame(JSON.stringify(frame)), recvMs);
    if (u) updates.push(u);
  }
  return updates;
}

describe("recorded market-data frames (testnet, market 64)", () => {
  it("every recorded frame parses; mt 8/9/10 are maps keyed by market id", () => {
    const kinds = new Set<number>();
    for (const { frame } of all()) {
      const f = parseMarketDataFrame(JSON.stringify(frame));
      kinds.add(f.mt);
      if (f.mt === 8 || f.mt === 9 || f.mt === 10) expect("markets" in f && typeof f.markets).toBe("object");
    }
    expect([...kinds].sort((a, b) => a - b)).toEqual([6, 8, 9, 10, 15, 16, 17, 18, 100]);
  });

  it("the mt: 6 reply's sids are not a routing key: funding@ is listed under market-state's sid, but arrives on another", () => {
    const sub = lines("control").find((l) => l.frame.mt === 6)!.frame as { subs: { stream: string; sid: number }[] };
    const sidOf = (s: string) => sub.subs.find((x) => x.stream.startsWith(s))!.sid;
    expect(sidOf("funding@")).toBe(sidOf("market-state@")); // as recorded (3000 / 3000)
    const fundingSid = lines("funding")[0]!.frame.sid;
    expect(fundingSid).not.toBe(sidOf("funding@")); // arrived on 4000
  });

  it("replay builds the feed: state, live fees, the funding snapshot and a gapless heartbeat", () => {
    const feed = new MarketDataFeed(64);
    const updates = replay(feed);
    expect(feed.errors).toEqual([]);
    expect(feed.heartbeatGaps).toBe(0);
    expect(updates.filter((u) => u === "gap")).toHaveLength(0);
    // the funding snapshot on subscribe = one "new" update for our market
    const f = updates.filter((u): u is FundingUpdate => u !== "gap");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ marketId: 64, kind: "new" });
    expect(feed.config?.value).toMatchObject({ isOpen: true, priceDecimals: 5, sizeDecimals: 0, fees: { makerMicros: 45, takerMicros: 345 } });
    const lastState = lines("market-state").filter((l) => (l.frame.d as Record<string, unknown>)["64"] !== undefined).at(-1)!;
    expect(feed.state?.value.mrk).toBe(((lastState.frame.d as Record<string, { mrk: number }>)["64"]!).mrk);
    expect(feed.head?.block).toBe((lines("heartbeat").at(-1)!.frame as { h: number }).h);
  });

  it("README fee tiers: tier index into the arrays, base rate when missing/out of range", () => {
    const feed = new MarketDataFeed(64);
    replay(feed);
    const fees = feed.config!.value.fees;
    expect(feeForTier(fees, 0, false)).toBe(345);
    expect(feeForTier(fees, 2, false)).toBe(250);
    expect(feeForTier(fees, 2, true)).toBe(15);
    expect(feeForTier(fees, 99, false)).toBe(345);
    expect(feeForTier({ makerMicros: 1, takerMicros: 2 }, 3, false)).toBe(2);
  });

  it("venue read from the feed = the same formulas as the REST read (MFI.md §3.2, §3.3)", () => {
    const feed = new MarketDataFeed(64);
    replay(feed);
    const now = feed.lastFrameMs!;
    const r = perplVenueFromFeed(feed, MON, now, 10_000)!;
    const ev = feed.fundingInForce(now)!;
    expect(r.source).toBe("ws");
    expect(r.rateMicros).toBe(ev.rate);
    expect(r.aprWad).toBe(perplRateToAprWad(ev.rate, 2580));
    expect(r.markWad).toBe(BigInt(feed.state!.value.mrk) * 10n ** 13n);
    expect(r.fees).toEqual(feed.config!.value.fees);
    expect(perplVenueFromFeed(feed, MON, now + 10_001, 10_000)).toBeUndefined(); // silent too long ⇒ REST
  });
});

describe("recorded funding interval (testnet, 7 Oct 2026 16:18–16:51 UTC, market 64)", () => {
  // funding@10143 frames reduced to market 64 (the probe logged d["64"] only): the snapshot on subscribe, then ONE
  // interval as types.md describes it: the rate with an estimated at.t 23 s before the block, then the same feb again
  // with the final at.t (1791391848400 → 1791391848000) once the block arrived.
  const frames = readFileSync(new URL("../fixtures/recorded/testnet/ws/funding-interval-64.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { recvMs: number; frame: unknown });
  it("snapshot ⇒ new; next interval ⇒ new then final (same feb), so the MFI cycles twice and dedups by feb", () => {
    const feed = new MarketDataFeed(64);
    const kinds = frames.map((f) => feed.apply(parseMarketDataFrame(JSON.stringify(f.frame)), f.recvMs)).map((u) => (u && u !== "gap" ? u.kind : u));
    expect(kinds).toEqual(["new", "new", "final"]);
    expect(feed.fundingEvents().map((e) => [e.feb, e.rate])).toEqual([
      [69_013_692, 0],
      [69_022_263, -10],
    ]);
    // the newest rate applied ahead of the head when first published: until its at.t, the previous one is in force
    expect(feed.fundingInForce(1_791_391_830_000)?.rate).toBe(0);
    expect(feed.fundingInForce(1_791_391_849_165)?.rate).toBe(-10);
    expect(perplRateToAprWad(-10, 2580)).toBe(-122_232_558_139_534_883n); // −12.2% APR, rounds toward zero
  });
});

const ev = (feb: number, t: number, rate = 30): FundingEvent => ({ at: { b: feb, t }, feb, rate, idx: 2573, ppl: 77, sum: 0, div: 1000 });
const fundingFrame = (e: FundingEvent, market = 64): MarketDataFrame => ({ mt: 10, markets: { [market]: e } });

describe("MarketDataFeed funding (types.md: two messages per interval, keyed by feb)", () => {
  it("new feb ⇒ new; same feb with the final at.t ⇒ final; identical ⇒ repeat; other markets ignored", () => {
    const f = new MarketDataFeed(64);
    expect(f.apply(fundingFrame(ev(100, 1_000)), 1)).toMatchObject({ kind: "new" });
    expect(f.apply(fundingFrame(ev(100, 1_200)), 2)).toMatchObject({ kind: "final" });
    expect(f.apply(fundingFrame(ev(100, 1_200)), 3)).toMatchObject({ kind: "repeat" });
    expect(f.apply(fundingFrame(ev(200, 5_000), 16), 4)).toBeUndefined();
    expect(f.fundingEvents()).toHaveLength(1);
  });
  it("in force skips the newest event while it still applies ahead of now; bounded history", () => {
    const f = new MarketDataFeed(64, 3);
    for (let i = 1; i <= 5; i++) f.apply(fundingFrame(ev(i * 100, i * 1_000, i)), i);
    expect(f.fundingEvents().map((e) => e.feb)).toEqual([300, 400, 500]);
    expect(f.fundingInForce(4_500)?.feb).toBe(400);
    expect(f.fundingInForce(5_000)?.feb).toBe(500);
  });
  it("REST backfill never overwrites a WS copy of the same feb", () => {
    const f = new MarketDataFeed(64);
    f.apply(fundingFrame(ev(100, 1_200, 7)), 1);
    f.backfill([ev(100, 1_000, 99), ev(50, 500, 3)]);
    expect(f.fundingEvents().map((e) => [e.feb, e.rate])).toEqual([
      [50, 3],
      [100, 7],
    ]);
  });
  it("heartbeat gap ⇒ 'gap'; a reset sequence (new connection) is not a gap", () => {
    const f = new MarketDataFeed(64);
    expect(f.apply({ mt: 100, sn: 10, h: 10 }, 1)).toBeUndefined();
    expect(f.apply({ mt: 100, sn: 11, h: 11 }, 2)).toBeUndefined();
    expect(f.apply({ mt: 100, sn: 13, h: 13 }, 3)).toBe("gap");
    f.resetSequence();
    expect(f.apply({ mt: 100, sn: 500, h: 500 }, 4)).toBeUndefined();
  });
  it("a malformed body for our market is recorded, not thrown", () => {
    const f = new MarketDataFeed(64);
    expect(f.apply({ mt: 9, markets: { 64: { mrk: "x" } } }, 1)).toBeUndefined();
    expect(f.errors[0]).toMatch(/ws\.state\.64/);
  });
  it("rejects non-JSON and frames without an integer mt", () => {
    expect(() => parseMarketDataFrame("nope")).toThrow(/not JSON/);
    expect(() => parseMarketDataFrame('{"mt":"9"}')).toThrow(/integer mt/);
    expect(parseMarketDataFrame('{"mt":2,"t":1}')).toEqual({ mt: 2, other: true });
  });
});

describe("reconnectDelayMs (README WebSocket Close Codes, websocket.md Reconnection Strategy)", () => {
  it("1001 ⇒ reconnect now", () => expect(reconnectDelayMs(1001, 5, () => 0.9)).toBe(0));
  it("documented schedule with ±25% jitter, capped at 60 s", () => {
    for (let a = 0; a < 10; a++) {
      const base = RETRY_DELAYS_MS[Math.min(a, RETRY_DELAYS_MS.length - 1)]!;
      expect(reconnectDelayMs(1006, a, () => 0)).toBe(base * 0.75);
      expect(reconnectDelayMs(1008, a, () => 1)).toBe(base * 1.25);
    }
  });
  it("1013 slow consumer ⇒ pause first, then back off", () => {
    expect(reconnectDelayMs(1013, 0, () => 0.5)).toBe(30_000 + 1_000);
    expect(reconnectDelayMs(1013, 0, () => 0.5, { slowConsumerPauseMs: 5_000 })).toBe(6_000);
  });
});

// ───────────── fake socket + clock ─────────────
class FakeClock implements Clock {
  t = 1_000_000;
  private q: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  now = () => this.t;
  random = () => 0.5;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.id;
    this.q.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.q = this.q.filter((x) => x.id !== h);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
class FakeWs implements WsLike {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }
  open() {
    this.onopen?.({});
  }
  msg(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number, reason = "") {
    this.onclose?.({ code, reason });
  }
}
function harness(over: { silenceMs?: number } = {}) {
  const clock = new FakeClock();
  const sockets: FakeWs[] = [];
  const events: SocketEvent[] = [];
  const funding: FundingUpdate[] = [];
  const feed = new MarketDataFeed(64);
  const s = new MarketDataSocket({
    baseUrl: "wss://testnet.perpl.xyz/",
    chainId: 10143,
    feed,
    clock,
    factory: (u) => {
      const w = new FakeWs(u);
      sockets.push(w);
      return w;
    },
    onEvent: (e) => events.push(e),
    onFunding: (u) => funding.push(u),
    ...over,
  });
  return { clock, sockets, events, funding, feed, s, last: () => sockets.at(-1)! };
}
const subOk = { mt: 6, subs: [{ stream: "heartbeat@10143", sid: 5000, status: { code: 0 } }] };

describe("MarketDataSocket", () => {
  it("opens /ws/v1/market-data and subscribes ONCE to the four chain streams (10 req/min budget)", () => {
    const h = harness();
    h.s.start();
    h.last().open();
    expect(h.last().url).toBe("wss://testnet.perpl.xyz/ws/v1/market-data");
    expect(h.last().sent.map((x) => JSON.parse(x))).toEqual([
      { mt: 5, subs: ["heartbeat@10143", "market-config@10143", "market-state@10143", "funding@10143"].map((stream) => ({ stream, subscribe: true })) },
    ]);
  });
  it("no application pings by default (websocket.md Keep-Alive: market-data needs none)", () => {
    const h = harness({ silenceMs: 1e12 });
    h.s.start();
    h.last().open();
    for (let i = 0; i < 100; i++) {
      h.clock.advance(1_000);
      h.last().msg({ mt: 100, sn: i, h: i });
    }
    expect(h.last().sent).toHaveLength(1);
  });
  it("funding: new and final reach onFunding, repeats don't", () => {
    const h = harness();
    h.s.start();
    h.last().open();
    h.last().msg({ mt: 10, sid: 4000, d: { 64: ev(100, 1_000) } });
    h.last().msg({ mt: 10, sid: 4000, d: { 64: ev(100, 1_000) } });
    h.last().msg({ mt: 10, sid: 4000, d: { 64: ev(100, 1_300) } });
    expect(h.funding.map((u) => u.kind)).toEqual(["new", "final"]);
  });
  it("network drop (1006) ⇒ back-off reconnect; 1001 ⇒ immediate; a healthy subscribe resets the back-off", () => {
    const h = harness();
    h.s.start();
    h.last().open();
    h.last().serverClose(1006);
    expect(h.events.at(-1)).toMatchObject({ kind: "close", code: 1006, reconnectInMs: 1_000 });
    h.clock.advance(999);
    expect(h.sockets).toHaveLength(1);
    h.clock.advance(1);
    expect(h.sockets).toHaveLength(2);
    h.last().serverClose(1006);
    expect(h.events.at(-1)).toMatchObject({ reconnectInMs: 2_000 });
    h.clock.advance(2_000);
    h.last().open();
    h.last().msg(subOk);
    h.last().serverClose(1001);
    expect(h.events.at(-1)).toMatchObject({ code: 1001, reconnectInMs: 0 });
    h.clock.advance(0);
    expect(h.sockets).toHaveLength(4);
    h.last().serverClose(1006);
    expect(h.events.at(-1)).toMatchObject({ reconnectInMs: 2_000 }); // attempt 1 after the 1001 (attempt 0)
  });
  it("1013 send-buffer overflow ⇒ pause before reconnecting", () => {
    const h = harness();
    h.s.start();
    h.last().open();
    h.last().serverClose(1013, "send buffer overflow");
    expect(h.events.at(-1)).toMatchObject({ code: 1013, reconnectInMs: 31_000 });
  });
  it("silence watchdog: no frame for silenceMs ⇒ close and reconnect", () => {
    const h = harness({ silenceMs: 5_000 });
    h.s.start();
    h.last().open();
    h.clock.advance(3_000);
    h.last().msg({ mt: 100, sn: 1, h: 1 });
    h.clock.advance(4_999);
    expect(h.last().closed).toBeUndefined();
    h.clock.advance(1);
    expect(h.sockets[0]!.closed).toMatchObject({ code: 4001 });
    expect(h.events.some((e) => e.kind === "silent")).toBe(true);
    h.clock.advance(1_000);
    expect(h.sockets).toHaveLength(2);
  });
  it("heartbeat gap ⇒ fresh connection (resubscribe for a snapshot)", () => {
    const h = harness();
    h.s.start();
    h.last().open();
    h.last().msg({ mt: 100, sn: 1, h: 1 });
    h.last().msg({ mt: 100, sn: 3, h: 3 });
    expect(h.sockets[0]!.closed).toMatchObject({ code: 4000 });
    h.clock.advance(1_000);
    expect(h.sockets).toHaveLength(2);
    h.last().open();
    h.last().msg({ mt: 100, sn: 900, h: 900 }); // new connection, new sequence: no gap
    expect(h.sockets).toHaveLength(2);
  });
  it("stop() closes and never reconnects; frames from a stale socket are ignored", () => {
    const h = harness();
    h.s.start();
    const first = h.last();
    first.open();
    first.serverClose(1006);
    h.clock.advance(1_000);
    first.msg({ mt: 10, d: { 64: ev(1, 1) } });
    expect(h.funding).toHaveLength(0);
    h.s.stop();
    expect(h.last().closed).toMatchObject({ code: 1000 });
    h.clock.advance(120_000);
    expect(h.sockets).toHaveLength(2);
  });
});

describe("readPerplLive: WS first, REST backfill + fallback", () => {
  const rec = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/recorded/testnet/${n}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
  const funding = rec("funding-64");
  const ticker = rec("ticker-64");
  const events = funding.d as { at: { t: number } }[];
  const now = events.at(-1)!.at.t + 1_000;
  const iv = 2_580_000;
  const transport = () =>
    fixtureTransport({
      [`/v1/market-data/64/funding/${now - 2 * iv}-${now + iv}`]: { status: 200, body: funding },
      "/v1/market-data/64/ticker": { status: 200, body: ticker },
    });
  it("silent feed ⇒ one REST read, tagged rest, and the feed is backfilled with the funding history", async () => {
    const t = transport();
    const client = createPerplClient({ transport: t, sleep: async () => {}, random: () => 0 });
    const feed = new MarketDataFeed(64);
    const r = await readPerplLive(client, feed, MON, now);
    expect(r.source).toBe("rest");
    expect(r.fees).toEqual({ makerMicros: 45, takerMicros: 345, makerTiers: [45, 25, 15, 0, 0, 0, 0, 0], takerTiers: [345, 300, 250, 210, 175, 150, 125, 0] });
    expect(feed.fundingEvents().length).toBeGreaterThan(0);
    expect(t.calls.filter((c) => c.includes("/funding/"))).toHaveLength(2);
  });
  it("fresh feed ⇒ no REST call at all", async () => {
    const t = transport();
    const client = createPerplClient({ transport: t });
    const feed = new MarketDataFeed(64);
    feed.apply({ mt: 9, markets: { 64: (ticker.d as Record<string, unknown>)["64"] } }, now - 500);
    feed.backfill((funding.d as FundingEvent[]).slice(-3));
    const r = await readPerplLive(client, feed, MON, now);
    expect(r.source).toBe("ws");
    expect(t.calls).toEqual([]);
  });
  it("a feed for another market is refused", async () => {
    const client = createPerplClient({ transport: transport() });
    await expect(readPerplLive(client, new MarketDataFeed(16), MON, now)).rejects.toThrow(/feed follows market 16/);
  });
});
