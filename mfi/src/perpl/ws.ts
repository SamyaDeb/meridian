// Perpl market-data WebSocket (`/ws/v1/market-data`, public): frame parsing, a pure feed state, and a reconnecting socket.
// Source: github.com/PerplFoundation/api-docs (7 Oct 2026) websocket.md "Market Data WebSocket", README.md "Rate Limits"
// and "WebSocket Close Codes", types.md "FundingEvent" / "MarketState" / "MarketConfig".
// REST (client.ts) stays for context, funding backfill and as the fallback when this feed is down (MFI.md §5, PERPL_HEDGE.md).
import { PerplSchemaError } from "./errors";
import type { FundingEvent, MarketState, PerplFees } from "./types";
import { parseFees, parseFundingEvent, parseMarketState } from "./validate";

/** Market-data WebSocket base URLs from Perpl's README "Network Configuration". Prefer env PERPL_WS_URL. */
export const PERPL_WS_URL = { mainnet: "wss://app.perpl.xyz", testnet: "wss://testnet.perpl.xyz" } as const;

/** websocket.md "Message Types" (the market-data subset). */
export const MT = { ping: 1, status: 3, subscribe: 5, subscribed: 6, marketConfig: 8, marketState: 9, funding: 10, bookSnapshot: 15, bookUpdate: 16, tradesSnapshot: 17, tradesUpdate: 18, heartbeat: 100 } as const;

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

/** README "Fees & fee tiers": tier entry if present and in range, else the base rate. */
export function feeForTier(f: PerplFees, tier: number, isMaker: boolean): number {
  const tiers = isMaker ? f.makerTiers : f.takerTiers;
  const base = isMaker ? f.makerMicros : f.takerMicros;
  return tiers && Number.isInteger(tier) && tier >= 0 && tier < tiers.length ? tiers[tier]! : base;
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
    case MT.subscribed: {
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
    case MT.marketConfig:
    case MT.marketState:
    case MT.funding:
      if (!isObj(v.d)) throw new PerplSchemaError(`ws(mt ${v.mt}).d`, "expected object keyed by market id");
      return { mt: v.mt, ...sn, markets: v.d };
    case MT.bookSnapshot:
    case MT.bookUpdate:
    case MT.tradesSnapshot:
    case MT.tradesUpdate:
      return { mt: v.mt, ...sn, ...(safeInt(v.sid) ? { sid: v.sid } : {}), raw: v };
    case MT.heartbeat:
      if (!safeInt(v.sn) || !safeInt(v.h)) throw new PerplSchemaError("ws.heartbeat", "expected integer sn and h");
      return { mt: 100, sn: v.sn, h: v.h };
    default:
      return { mt: v.mt, other: true };
  }
}

export type FundingUpdate = { marketId: number; event: FundingEvent; kind: "new" | "final" | "repeat" };

/**
 * Latest market-data state for ONE market, fed frame by frame (pure: the caller passes the receive time).
 * Funding is kept per `feb` (types.md: two messages per interval, the second with the final `at.t`), bounded to the last
 * `maxEvents` intervals, so "the rate in force now" can skip an event that applies ahead of the head.
 */
export class MarketDataFeed {
  private readonly events = new Map<number, FundingEvent>();
  state: { value: MarketState; recvMs: number } | undefined;
  config: { value: MarketConfigWs; recvMs: number } | undefined;
  head: { block: number; sn: number; recvMs: number } | undefined;
  lastFrameMs: number | undefined;
  lastFundingMs: number | undefined;
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

  /** Forget the heartbeat sequence (a new connection starts a new one). */
  resetSequence(): void {
    this.head = this.head ? { ...this.head, sn: -1 } : undefined;
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
      if (!("markets" in f)) return undefined;
      const body = f.markets[key];
      if (body === undefined) return undefined; // frames carry only the markets that changed
      if (f.mt === MT.marketState) this.state = { value: parseMarketState(body, `ws.state.${key}`), recvMs };
      else if (f.mt === MT.marketConfig) this.config = { value: parseMarketConfigWs(body, `ws.config.${key}`), recvMs };
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

/** The subset of the WHATWG WebSocket the socket uses (Node 22's global WebSocket, or a fake in tests). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  random(): number;
};
export const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), random: Math.random };

/** websocket.md "Reconnection Strategy". */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

/**
 * Delay before reconnect attempt `attempt` (0-based) after close `code`, README "WebSocket Close Codes":
 * 1001 server going away ⇒ now; 1013 send-buffer overflow ⇒ pause first (we were reading too slowly), then back off;
 * anything else (1006 network, 1008 rate/idle, 1011, 3401) ⇒ the documented schedule. Jitter ±25% so clients don't
 * reconnect in lockstep.
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
  factory?: WsFactory;
  clock?: Clock;
  /** no frame for this long ⇒ reconnect (data arrives every block; default 15 s) */
  silenceMs?: number;
  /**
   * Application ping period. Default 0 = off: websocket.md "Keep-Alive" says market-data connections need no mt: 1 (data
   * arrives every block, the server keeps the socket alive) and pings spend the 10 requests/min budget.
   */
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
    this.streams = [`heartbeat@${o.chainId}`, `market-config@${o.chainId}`, `market-state@${o.chainId}`, `funding@${o.chainId}`];
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
    const factory = this.o.factory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
    const ws = factory(url);
    this.ws = ws;
    this.connects++;
    this.o.feed.resetSequence();
    const openedAt = this.clock.now();
    ws.onopen = () => {
      this.o.onEvent?.({ kind: "open", url });
      ws.send(JSON.stringify({ mt: MT.subscribe, subs: this.streams.map((stream) => ({ stream, subscribe: true })) }));
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

  /** Close `ws` ourselves and reconnect right away through the normal schedule (attempt counter applies). */
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
      ws.send(JSON.stringify({ mt: MT.ping, t: this.clock.now() }));
      this.pinger = this.clock.setTimeout(ping, every);
    };
    this.pinger = this.clock.setTimeout(ping, every);
  }
}
