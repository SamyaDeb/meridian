// Perpl market-data WebSocket (`/ws/v1/market-data`, public): frame parsing, a pure feed state (funding, market state,
// config, L2 book), and a reconnecting socket. Ported from meridian-k3/mfi/src/perpl/ws.ts (perpl-hedge @ 116e26d) with
// the WebSocket factory injected and the order book (`order-book@<market_id>`, mt 15/16) added.
// Source: api-docs @ 25ab6e2 websocket.md "Market Data WebSocket", types.md "L2Book" (an update level with o: 0 is a
// removal), README "Rate Limits" (10 requests/min, 16 subscriptions per connection) and "WebSocket Close Codes".
import { realClock, type Clock, type WsFactory, type WsLike } from "../util/runtime";
import { PerplSchemaError } from "./errors";
import type { FundingEvent, L2Book, L2Level, MarketState, PerplFees, PerplTrade } from "./types";
import { parseFees, parseFundingEvent, parseL2Book, parseMarketState, parseTrades } from "./validate";

/** websocket.md "Message Types" (the market-data subset). */
export const MD = { ping: 1, status: 3, subscribe: 5, subscribed: 6, marketConfig: 8, marketState: 9, funding: 10, bookSnapshot: 15, bookUpdate: 16, tradesSnapshot: 17, tradesUpdate: 18, heartbeat: 100 } as const;

export type MarketConfigWs = { isOpen: boolean; priceDecimals: number; sizeDecimals: number; fees: PerplFees; atBlock?: number };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const safeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** One market's `MarketConfig` from an mt: 8 frame (or `Market.config` from /v1/pub/context). */
export function parseMarketConfigWs(v: unknown, path = "config"): MarketConfigWs {
  if (!isObj(v)) throw new PerplSchemaError(path, "expected object");
  if (typeof v.is_open !== "boolean") throw new PerplSchemaError(`${path}.is_open`, "expected boolean");
  const dec = (k: string) => {
    const d = v[k];
    if (!safeInt(d) || d < 0 || d > 18) throw new PerplSchemaError(`${path}.${k}`, "expected decimals in [0, 18]");
    return d;
  };
  const fees = parseFees(v, path);
  if (!fees) throw new PerplSchemaError(`${path}.taker_fee`, "expected maker_fee / taker_fee (micros)");
  const at = isObj(v.at) && safeInt(v.at.b) ? v.at.b : undefined;
  return { isOpen: v.is_open, priceDecimals: dec("price_decimals"), sizeDecimals: dec("size_decimals"), fees, ...(at !== undefined ? { atBlock: at } : {}) };
}

export type MarketDataFrame =
  | { mt: 6; subs: { stream: string; sid?: number; code: number; error?: string }[] }
  | { mt: 8 | 9 | 10; sn?: number; markets: Record<string, unknown> }
  | { mt: 15 | 16 | 17 | 18; sid?: number; sn?: number; raw: Obj }
  | { mt: 100; sn: number; h: number }
  | { mt: number; other: true };

/**
 * Envelope only: per-market bodies (mt 8/9/10 carry `d: { [marketId]: … }`, recorded 7 Oct 2026) stay raw so a bad entry
 * for a market we don't follow can't take down the feed; the feed validates the market it follows.
 */
export function parseMarketDataFrame(text: string): MarketDataFrame {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new PerplSchemaError("ws", "frame is not JSON");
  }
  if (!isObj(v) || !safeInt(v.mt)) throw new PerplSchemaError("ws.mt", "expected a frame with an integer mt");
  const sn = safeInt(v.sn) ? { sn: v.sn } : {};
  switch (v.mt) {
    case MD.subscribed: {
      if (!Array.isArray(v.subs)) throw new PerplSchemaError("ws.subs", "expected array");
      return {
        mt: 6,
        subs: v.subs.map((s, i) => {
          if (!isObj(s) || typeof s.stream !== "string") throw new PerplSchemaError(`ws.subs[${i}]`, "expected { stream }");
          const st = isObj(s.status) ? s.status : {};
          return { stream: s.stream, ...(safeInt(s.sid) ? { sid: s.sid } : {}), code: safeInt(st.code) ? st.code : 0, ...(typeof st.error === "string" ? { error: st.error } : {}) };
        }),
      };
    }
    case MD.marketConfig:
    case MD.marketState:
    case MD.funding:
      if (!isObj(v.d)) throw new PerplSchemaError(`ws(mt ${v.mt}).d`, "expected object keyed by market id");
      return { mt: v.mt, ...sn, markets: v.d };
    case MD.bookSnapshot:
    case MD.bookUpdate:
    case MD.tradesSnapshot:
    case MD.tradesUpdate:
      return { mt: v.mt, ...sn, ...(safeInt(v.sid) ? { sid: v.sid } : {}), raw: v };
    case MD.heartbeat:
      if (!safeInt(v.sn) || !safeInt(v.h)) throw new PerplSchemaError("ws.heartbeat", "expected integer sn and h");
      return { mt: 100, sn: v.sn, h: v.h };
    default:
      return { mt: v.mt, other: true };
  }
}

/**
 * L2 book of one market, rebuilt from a snapshot (mt 15) and patched by updates (mt 16): an update level replaces the
 * level at its price; `o: 0` removes it (types.md "L2Book"). Sides kept best first. Updates before a snapshot are ignored.
 */
export class L2BookState {
  private bids = new Map<number, L2Level>();
  private asks = new Map<number, L2Level>();
  ready = false;
  atBlock: number | undefined;

  apply(b: L2Book): void {
    if (b.mt === 15) {
      this.bids = new Map(b.bid.filter((l) => l.o > 0 && l.s > 0).map((l) => [l.p, l]));
      this.asks = new Map(b.ask.filter((l) => l.o > 0 && l.s > 0).map((l) => [l.p, l]));
      this.ready = true;
    } else {
      if (!this.ready) return;
      for (const [side, levels] of [
        [this.bids, b.bid],
        [this.asks, b.ask],
      ] as const)
        for (const l of levels) {
          if (l.o === 0 || l.s === 0) side.delete(l.p);
          else side.set(l.p, l);
        }
    }
    if (b.at.b !== undefined) this.atBlock = b.at.b;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.ready = false;
  }

  /** Best first: bids high → low, asks low → high. */
  snapshot(): { bid: L2Level[]; ask: L2Level[] } {
    return { bid: [...this.bids.values()].sort((a, b) => b.p - a.p), ask: [...this.asks.values()].sort((a, b) => a.p - b.p) };
  }
}

export type FundingUpdate = { marketId: number; event: FundingEvent; kind: "new" | "final" | "repeat" };

/**
 * Latest market-data state for ONE market, fed frame by frame (pure: the caller passes the receive time).
 * Funding is kept per `feb` (types.md: two messages per interval, the second with the final `at.t`), bounded to the last
 * `maxEvents` intervals, so "the rate in force now" can skip an event that applies ahead of the head.
 */
/** Recent trades kept per feed (the Pro Trades tab shows ~20). */
export const MAX_TRADES = 50;

export class MarketDataFeed {
  private readonly events = new Map<number, FundingEvent>();
  readonly book = new L2BookState();
  /** recent public trades of this market, newest first (bounded; `trades@<id>`, mt 17 replaces, mt 18 prepends) */
  trades: PerplTrade[] = [];
  lastTradesMs: number | undefined;
  state: { value: MarketState; recvMs: number } | undefined;
  config: { value: MarketConfigWs; recvMs: number } | undefined;
  head: { block: number; sn: number; recvMs: number } | undefined;
  lastFrameMs: number | undefined;
  lastFundingMs: number | undefined;
  lastBookMs: number | undefined;
  /** heartbeat sequence gaps seen (websocket.md "Sequence Numbers": heartbeat is continuous) */
  heartbeatGaps = 0;
  errors: string[] = [];

  constructor(
    readonly marketId: number,
    private readonly maxEvents = 8,
  ) {}

  /** Seed / backfill from REST (`GET /v1/market-data/:id/funding/:from-:to`). Never overrides a WS copy of the same feb. */
  backfill(events: readonly FundingEvent[]): void {
    for (const e of events) if (!this.events.has(e.feb)) this.events.set(e.feb, e);
    this.trim();
  }

  /** A new connection: forget the heartbeat sequence and the book (the new subscription opens with a fresh snapshot). */
  resetSequence(): void {
    this.head = this.head ? { ...this.head, sn: -1 } : undefined;
    this.book.reset();
  }

  /** Applies one frame; returns the funding update for our market, if the frame carried one. A heartbeat gap returns "gap". */
  apply(f: MarketDataFrame, recvMs: number): FundingUpdate | "gap" | undefined {
    this.lastFrameMs = recvMs;
    const key = String(this.marketId);
    try {
      if ("h" in f) {
        const gap = this.head !== undefined && this.head.sn >= 0 && f.sn !== this.head.sn + 1;
        this.head = { block: f.h, sn: f.sn, recvMs };
        if (gap) {
          this.heartbeatGaps++;
          return "gap";
        }
        return undefined;
      }
      if ("raw" in f) {
        if (f.mt === MD.bookSnapshot || f.mt === MD.bookUpdate) {
          // order-book@<id> is per market; the frame carries no market id, so a feed follows exactly one book stream
          this.book.apply(parseL2Book(f.raw, `ws.book.${key}`));
          this.lastBookMs = recvMs;
        } else if (f.mt === MD.tradesSnapshot || f.mt === MD.tradesUpdate) {
          // trades@<id> is per market like the book; newest first by block, then as sent
          const t = parseTrades(f.raw, `ws.trades.${key}`).d;
          const sorted = [...t].sort((a, b) => (b.at.b ?? 0) - (a.at.b ?? 0));
          this.trades = (f.mt === MD.tradesSnapshot ? sorted : [...sorted, ...this.trades]).slice(0, MAX_TRADES);
          this.lastTradesMs = recvMs;
        }
        return undefined;
      }
      if (!("markets" in f)) return undefined;
      const body = f.markets[key];
      if (body === undefined) return undefined; // frames carry only the markets that changed
      if (f.mt === MD.marketState) this.state = { value: parseMarketState(body, `ws.state.${key}`), recvMs };
      else if (f.mt === MD.marketConfig) this.config = { value: parseMarketConfigWs(body, `ws.config.${key}`), recvMs };
      else {
        const e = parseFundingEvent(body, `ws.funding.${key}`);
        const prev = this.events.get(e.feb);
        this.events.set(e.feb, e);
        this.trim();
        this.lastFundingMs = recvMs;
        const kind = prev === undefined ? "new" : prev.at.t !== e.at.t || prev.rate !== e.rate ? "final" : "repeat";
        return { marketId: this.marketId, event: e, kind };
      }
    } catch (e) {
      this.errors = [...this.errors.slice(-19), e instanceof Error ? e.message : String(e)];
    }
    return undefined;
  }

  /** Events oldest first. */
  fundingEvents(): FundingEvent[] {
    return [...this.events.values()].sort((a, b) => a.feb - b.feb);
  }

  /** The event in force at `nowMs` (the newest can apply up to ~1 min AHEAD of the head, types.md "FundingEvent"). */
  fundingInForce(nowMs: number): FundingEvent | undefined {
    const all = this.fundingEvents();
    return all.filter((e) => e.at.t === undefined || e.at.t <= nowMs).at(-1) ?? all[0];
  }

  private trim(): void {
    const febs = [...this.events.keys()].sort((a, b) => a - b);
    for (const feb of febs.slice(0, Math.max(0, febs.length - this.maxEvents))) this.events.delete(feb);
  }
}

// ───────────────────────────── connection ─────────────────────────────

/** websocket.md "Reconnection Strategy". */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

/**
 * Delay before reconnect attempt `attempt` (0-based) after close `code`, README "WebSocket Close Codes":
 * 1001 server going away ⇒ now; 1013 send-buffer overflow ⇒ pause first, then back off; anything else ⇒ the documented
 * schedule. Jitter ±25% so clients don't reconnect in lockstep.
 */
export function reconnectDelayMs(code: number, attempt: number, random: () => number, opts: { slowConsumerPauseMs?: number } = {}): number {
  if (code === 1001) return 0;
  const base = RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)]!;
  const jittered = Math.round(base * (0.75 + 0.5 * random()));
  return code === 1013 ? (opts.slowConsumerPauseMs ?? 30_000) + jittered : jittered;
}

export type SocketEvent =
  | { kind: "open"; url: string }
  | { kind: "subscribed"; subs: { stream: string; code: number; error?: string }[] }
  | { kind: "close"; code: number; reason: string; reconnectInMs: number }
  | { kind: "silent"; forMs: number }
  | { kind: "gap" }
  | { kind: "bad-frame"; error: string };

export type MarketDataSocketOptions = {
  baseUrl: string;
  chainId: number;
  feed: MarketDataFeed;
  factory: WsFactory;
  clock?: Clock;
  /** also follow `order-book@<feed.marketId>` (default true: the router needs the book) */
  book?: boolean;
  /** also follow `trades@<feed.marketId>` (websocket.md "Trade Messages"; default false) */
  trades?: boolean;
  /** no frame for this long ⇒ reconnect (data arrives every block; default 15 s) */
  silenceMs?: number;
  /** Application ping period. Default 0 = off (websocket.md "Keep-Alive": market-data needs none; pings spend the budget). */
  pingEveryMs?: number;
  slowConsumerPauseMs?: number;
  onFunding?: (u: FundingUpdate) => void;
  onEvent?: (e: SocketEvent) => void;
};

/**
 * One market-data connection. Subscribes in ONE mt: 5 frame (10 requests/min, 16 subscriptions per connection), routes
 * frames by `mt` (the mt: 6 reply's `sid`s were not reliable on testnet, 7 Oct 2026), reconnects with jittered back-off.
 * Frames are parsed and applied synchronously in onmessage (cheap) so the server's send buffer never backs up (1013).
 */
export class MarketDataSocket {
  private ws: WsLike | undefined;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: unknown;
  private watchdog: unknown;
  private pinger: unknown;
  readonly streams: string[];
  connects = 0;

  constructor(private readonly o: MarketDataSocketOptions) {
    this.streams = [`heartbeat@${o.chainId}`, `market-config@${o.chainId}`, `market-state@${o.chainId}`, `funding@${o.chainId}`, ...(o.book === false ? [] : [`order-book@${o.feed.marketId}`]), ...(o.trades ? [`trades@${o.feed.marketId}`] : [])];
  }

  private get clock(): Clock {
    return this.o.clock ?? realClock;
  }

  get connected(): boolean {
    return this.ws !== undefined;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clock.clearTimeout(this.reconnectTimer);
    this.clock.clearTimeout(this.watchdog);
    this.clock.clearTimeout(this.pinger);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000, "stop");
  }

  /** ms since the last frame of any kind, or Infinity if none yet */
  silentForMs(): number {
    const last = this.o.feed.lastFrameMs;
    return last === undefined ? Infinity : this.clock.now() - last;
  }

  private connect(): void {
    const url = `${this.o.baseUrl.replace(/\/+$/, "")}/ws/v1/market-data`;
    const ws = this.o.factory(url);
    this.ws = ws;
    this.connects++;
    this.o.feed.resetSequence();
    const openedAt = this.clock.now();
    ws.onopen = () => {
      this.o.onEvent?.({ kind: "open", url });
      ws.send(JSON.stringify({ mt: MD.subscribe, subs: this.streams.map((stream) => ({ stream, subscribe: true })) }));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const now = this.clock.now();
      let f: MarketDataFrame;
      try {
        f = parseMarketDataFrame(String(ev.data));
      } catch (e) {
        this.o.onEvent?.({ kind: "bad-frame", error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if ("subs" in f) {
        this.o.onEvent?.({ kind: "subscribed", subs: f.subs });
        if (f.subs.every((s) => s.code === 0)) this.attempt = 0; // a healthy session resets the back-off
      }
      const u = this.o.feed.apply(f, now);
      if (u === "gap") {
        // websocket.md "Sequence Numbers": on a gap, resubscribe for a fresh snapshot; a new connection does exactly that
        this.o.onEvent?.({ kind: "gap" });
        this.drop(ws, 4000, "heartbeat gap");
        return;
      }
      if (u && u.kind !== "repeat") this.o.onFunding?.(u);
    };
    ws.onerror = () => {
      /* followed by onclose */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.scheduleReconnect(ev.code, ev.reason);
    };
    this.armWatchdog(ws, openedAt);
    this.armPing(ws);
  }

  private drop(ws: WsLike, code: number, reason: string): void {
    if (this.ws !== ws) return;
    ws.onclose = null;
    ws.close(code, reason);
    this.scheduleReconnect(code, reason);
  }

  private scheduleReconnect(code: number, reason: string): void {
    this.ws = undefined;
    this.clock.clearTimeout(this.watchdog);
    this.clock.clearTimeout(this.pinger);
    if (this.stopped) return;
    const delay = reconnectDelayMs(code, this.attempt++, this.clock.random, this.o.slowConsumerPauseMs !== undefined ? { slowConsumerPauseMs: this.o.slowConsumerPauseMs } : {});
    this.o.onEvent?.({ kind: "close", code, reason, reconnectInMs: delay });
    this.reconnectTimer = this.clock.setTimeout(() => this.connect(), delay);
  }

  private armWatchdog(ws: WsLike, openedAt: number): void {
    const silence = this.o.silenceMs ?? 15_000;
    const check = () => {
      if (this.ws !== ws || this.stopped) return;
      const last = Math.max(openedAt, this.o.feed.lastFrameMs ?? 0);
      const quiet = this.clock.now() - last;
      if (quiet >= silence) {
        this.o.onEvent?.({ kind: "silent", forMs: quiet });
        this.drop(ws, 4001, "silent");
        return;
      }
      this.watchdog = this.clock.setTimeout(check, silence - quiet);
    };
    this.watchdog = this.clock.setTimeout(check, silence);
  }

  private armPing(ws: WsLike): void {
    const every = this.o.pingEveryMs ?? 0;
    if (every <= 0) return;
    const ping = () => {
      if (this.ws !== ws || this.stopped) return;
      ws.send(JSON.stringify({ mt: MD.ping, t: this.clock.now() }));
      this.pinger = this.clock.setTimeout(ping, every);
    };
    this.pinger = this.clock.setTimeout(ping, every);
  }
}
