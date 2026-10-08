// Ported from meridian-k3/mfi/test/ws.test.ts (perpl-hedge @ 116e26d) + the L2 book (order-book@64 frames recorded the
// same session, 7 Oct 2026 15:26 UTC, fixtures/perpl/testnet/ws/order-book.jsonl).
import { describe, expect, it } from "vitest";
import { L2BookState, MarketDataFeed, MarketDataSocket, RETRY_DELAYS_MS, feeForTier, parseContext, parseL2Book, parseMarketDataFrame, perplRateToAprWad, reconnectDelayMs, type FundingEvent, type FundingUpdate, type MarketDataFrame, type SocketEvent } from "../src/perpl";
import { FakeClock, FakeWs, fixtureJson, fixtureLines } from "./helpers";

const lines = (name: string) => fixtureLines(`perpl/testnet/ws/${name}.jsonl`);
const all = () =>
  ["control", "heartbeat", "market-config", "market-state", "funding", "order-book", "trades"]
    .flatMap((n) => lines(n))
    .sort((a, b) => a.recvMs - b.recvMs);
const ctx = parseContext(fixtureJson("perpl/testnet/context.json"));
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

  it("replay builds the feed: state, live fees, the funding snapshot and a gapless heartbeat", () => {
    const feed = new MarketDataFeed(64);
    const updates = replay(feed);
    expect(feed.errors).toEqual([]);
    expect(feed.heartbeatGaps).toBe(0);
    const f = updates.filter((u): u is FundingUpdate => u !== "gap");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ marketId: 64, kind: "new" });
    expect(feed.config?.value).toMatchObject({ isOpen: true, priceDecimals: 5, sizeDecimals: 0, fees: { makerMicros: 45, takerMicros: 345 } });
    expect(feed.head?.block).toBe((lines("heartbeat").at(-1)!.frame as { h: number }).h);
    expect(MON.config.price_decimals).toBe(feed.config!.value.priceDecimals);
  });

  it("README fee tiers: tier index into the arrays, base rate when missing/out of range", () => {
    const feed = new MarketDataFeed(64);
    replay(feed);
    const fees = feed.config!.value.fees;
    expect(feeForTier(fees, 0, false)).toBe(345);
    expect(feeForTier(fees, 2, false)).toBe(250);
    expect(feeForTier(fees, 2, true)).toBe(15);
    expect(feeForTier(fees, 99, false)).toBe(345);
  });

  it("the L2 book: snapshot then updates (o: 0 removes a level); sides best first and never crossed", () => {
    const feed = new MarketDataFeed(64);
    const book = lines("order-book");
    expect(book[0]!.frame.mt).toBe(15);
    feed.apply(parseMarketDataFrame(JSON.stringify(book[0]!.frame)), book[0]!.recvMs);
    const snap = feed.book.snapshot();
    expect(snap.bid[0]).toEqual({ p: 2574, s: 4_298_218, o: 1 });
    expect(snap.ask[0]).toEqual({ p: 2578, s: 4_285_404, o: 1 });
    expect(snap.bid).toHaveLength(8);
    // second frame: 2574 removed (o: 0), 2575 added
    feed.apply(parseMarketDataFrame(JSON.stringify(book[1]!.frame)), book[1]!.recvMs);
    const s2 = feed.book.snapshot();
    expect(s2.bid.find((l) => l.p === 2574)).toBeUndefined();
    expect(s2.bid[0]).toEqual({ p: 2575, s: 4_470_604, o: 1 });
    for (const { recvMs, frame } of book.slice(2)) feed.apply(parseMarketDataFrame(JSON.stringify(frame)), recvMs);
    const end = feed.book.snapshot();
    for (let i = 1; i < end.bid.length; i++) expect(end.bid[i]!.p).toBeLessThan(end.bid[i - 1]!.p);
    for (let i = 1; i < end.ask.length; i++) expect(end.ask[i]!.p).toBeGreaterThan(end.ask[i - 1]!.p);
    expect(end.bid[0]!.p).toBeLessThan(end.ask[0]!.p);
    expect(feed.book.atBlock).toBe((book.at(-1)!.frame.at as { b: number }).b);
  });

  it("book updates before a snapshot are ignored; a reconnect clears the book", () => {
    const b = new L2BookState();
    b.apply(parseL2Book({ mt: 16, at: {}, bid: [{ p: 1, s: 1, o: 1 }], ask: [] }));
    expect(b.ready).toBe(false);
    expect(b.snapshot().bid).toEqual([]);
    const feed = new MarketDataFeed(64);
    feed.apply(parseMarketDataFrame(JSON.stringify(lines("order-book")[0]!.frame)), 0);
    expect(feed.book.ready).toBe(true);
    feed.resetSequence();
    expect(feed.book.ready).toBe(false);
  });
});

describe("recorded funding interval (testnet, 7 Oct 2026, market 64)", () => {
  const frames = lines("funding-interval-64");
  it("snapshot ⇒ new; next interval ⇒ new then final (same feb)", () => {
    const feed = new MarketDataFeed(64);
    const kinds = frames.map((f) => feed.apply(parseMarketDataFrame(JSON.stringify(f.frame)), f.recvMs)).map((u) => (u && u !== "gap" ? u.kind : u));
    expect(kinds).toEqual(["new", "new", "final"]);
    expect(feed.fundingInForce(1_791_391_830_000)?.rate).toBe(0);
    expect(feed.fundingInForce(1_791_391_849_165)?.rate).toBe(-10);
    expect(perplRateToAprWad(-10, 2580)).toBe(-122_232_558_139_534_883n);
  });
});

const ev = (feb: number, t: number, rate = 30): FundingEvent => ({ at: { b: feb, t }, feb, rate, idx: 2573, ppl: 77, sum: 0, div: 1000 });
const fundingFrame = (e: FundingEvent, market = 64): MarketDataFrame => ({ mt: 10, markets: { [market]: e } });

describe("MarketDataFeed funding", () => {
  it("new feb ⇒ new; same feb with the final at.t ⇒ final; identical ⇒ repeat; other markets ignored", () => {
    const f = new MarketDataFeed(64);
    expect(f.apply(fundingFrame(ev(100, 1_000)), 1)).toMatchObject({ kind: "new" });
    expect(f.apply(fundingFrame(ev(100, 1_200)), 2)).toMatchObject({ kind: "final" });
    expect(f.apply(fundingFrame(ev(100, 1_200)), 3)).toMatchObject({ kind: "repeat" });
    expect(f.apply(fundingFrame(ev(200, 5_000), 16), 4)).toBeUndefined();
  });
  it("bounded history; REST backfill never overwrites a WS copy", () => {
    const f = new MarketDataFeed(64, 3);
    for (let i = 1; i <= 5; i++) f.apply(fundingFrame(ev(i * 100, i * 1_000, i)), i);
    expect(f.fundingEvents().map((e) => e.feb)).toEqual([300, 400, 500]);
    f.backfill([ev(500, 1, 99)]);
    expect(f.fundingEvents().at(-1)!.rate).toBe(5);
  });
  it("heartbeat gap ⇒ 'gap'; a reset sequence is not a gap; malformed bodies recorded not thrown", () => {
    const f = new MarketDataFeed(64);
    f.apply({ mt: 100, sn: 10, h: 10 }, 1);
    expect(f.apply({ mt: 100, sn: 12, h: 12 }, 3)).toBe("gap");
    f.resetSequence();
    expect(f.apply({ mt: 100, sn: 500, h: 500 }, 4)).toBeUndefined();
    expect(f.apply({ mt: 9, markets: { 64: { mrk: "x" } } }, 1)).toBeUndefined();
    expect(f.errors[0]).toMatch(/ws\.state\.64/);
    expect(() => parseMarketDataFrame("nope")).toThrow(/not JSON/);
  });
});

describe("reconnectDelayMs", () => {
  it("1001 now; schedule ±25 %; 1013 pauses", () => {
    expect(reconnectDelayMs(1001, 5, () => 0.9)).toBe(0);
    for (let a = 0; a < 10; a++) expect(reconnectDelayMs(1006, a, () => 0)).toBe(RETRY_DELAYS_MS[Math.min(a, RETRY_DELAYS_MS.length - 1)]! * 0.75);
    expect(reconnectDelayMs(1013, 0, () => 0.5)).toBe(31_000);
  });
});

function harness(over: { silenceMs?: number; book?: boolean } = {}) {
  const clock = new FakeClock();
  const sockets: FakeWs[] = [];
  const events: SocketEvent[] = [];
  const funding: FundingUpdate[] = [];
  const feed = new MarketDataFeed(64);
  const s = new MarketDataSocket({ baseUrl: "wss://testnet.perpl.xyz/", chainId: 10143, feed, clock, factory: (u) => (sockets.push(new FakeWs(u)), sockets.at(-1)!), onEvent: (e) => events.push(e), onFunding: (u) => funding.push(u), ...over });
  return { clock, sockets, events, funding, feed, s, last: () => sockets.at(-1)! };
}

describe("MarketDataSocket", () => {
  it("subscribes ONCE to the chain streams + the market's order book (5 of 16 subscriptions)", () => {
    const h = harness();
    h.s.start();
    h.last().open();
    expect(h.last().url).toBe("wss://testnet.perpl.xyz/ws/v1/market-data");
    expect(h.last().sent).toEqual([{ mt: 5, subs: ["heartbeat@10143", "market-config@10143", "market-state@10143", "funding@10143", "order-book@64"].map((stream) => ({ stream, subscribe: true })) }]);
    const h2 = harness({ book: false });
    h2.s.start();
    h2.last().open();
    expect((h2.last().sent[0]!.subs as unknown[]).length).toBe(4);
  });
  it("network drop ⇒ back-off reconnect; silence ⇒ reconnect; stop ⇒ never again", () => {
    const h = harness({ silenceMs: 5_000 });
    h.s.start();
    h.last().open();
    h.last().serverClose(1006);
    expect(h.events.at(-1)).toMatchObject({ kind: "close", code: 1006, reconnectInMs: 1_000 });
    h.clock.advance(1_000);
    expect(h.sockets).toHaveLength(2);
    h.last().open();
    h.clock.advance(5_000);
    expect(h.sockets[1]!.closed).toMatchObject({ code: 4001 });
    h.s.stop();
    h.clock.advance(120_000);
    expect(h.sockets.length).toBeLessThanOrEqual(3);
  });
  it("funding: new and final reach onFunding, repeats don't; heartbeat gap ⇒ fresh connection", () => {
    const h = harness();
    h.s.start();
    h.last().open();
    h.last().msg({ mt: 10, d: { 64: ev(100, 1_000) } });
    h.last().msg({ mt: 10, d: { 64: ev(100, 1_000) } });
    h.last().msg({ mt: 10, d: { 64: ev(100, 1_300) } });
    expect(h.funding.map((u) => u.kind)).toEqual(["new", "final"]);
    h.last().msg({ mt: 100, sn: 1, h: 1 });
    h.last().msg({ mt: 100, sn: 3, h: 3 });
    expect(h.sockets[0]!.closed).toMatchObject({ code: 4000 });
  });
});
