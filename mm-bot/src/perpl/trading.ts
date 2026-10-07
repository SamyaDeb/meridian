// Perpl trading client: one authenticated trading WebSocket (`/ws/v1/trading`) + signed REST.
// Sources: api-docs (7 Oct 2026) authentication.md, websocket.md "Trading WebSocket" / "Placing Orders" / "Command
// Status (mt: 3)" / "Heartbeat (Trading)" / "Keep-Alive" / "Reconnection Strategy", rest-endpoints.md "Trading State
// Endpoints" / "POST /api/v1/trading/orders", README "Rate Limits" / "WebSocket Close Codes".
//
// Rules this file enforces:
// - sign-in (mt: 29) is the FIRST frame, sent as soon as the socket opens (idle window 10 s testnet, 5 s mainnet);
// - `rq` = max(local, account.lfr) + 1, strictly increasing; `sn` unique and non-zero (echoed as `cid` on mt: 3);
// - `lb` = head + order_ttl_blocks (head from the heartbeat; ttl from /v1/pub/context, never hard-coded);
// - `code: 0` on mt: 3 is "accepted for forwarding", NOT filled: the outcome is the first definitive mt: 24 for the rq;
// - every outbound frame (orders and pings) spends a token: ≤ 50/min on testnet, under the 60/min limit;
// - at most ONE trading connection (4 per wallet, shared with browser sessions).
import { randomBytes } from "node:crypto";
import { newNonce, redact, restHeaders, signInFrame } from "./auth.js";
import { TokenBucket } from "./ratelimit.js";
import { PerplState, type OrderOutcome, type StateEvent } from "./state.js";
import { MT, OrderStatus, type BatchStatus, type Order, type OrderSpec } from "./types.js";

/** Same shape the MFI's market-data socket uses: the WHATWG WebSocket subset (Node 22 global, or a fake in tests). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void; random(): number };
export const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), random: Math.random };

/** websocket.md "Reconnection Strategy" + README close codes: 1001 now, 1013 pause first, else the schedule ±25%. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
export function tradingReconnectDelayMs(code: number, attempt: number, random: () => number): number {
  if (code === 1001) return 0;
  const base = RETRY_DELAYS_MS[Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)]!;
  return (code === 1013 ? 30_000 : 0) + Math.round(base * (0.75 + 0.5 * random()));
}

export type TradingConfig = {
  apiUrl: string; // e.g. https://testnet.perpl.xyz/api
  wsUrl: string; // e.g. wss://testnet.perpl.xyz
  chainId: number;
  apiKey: string;
  secret: Uint8Array;
  marketId: number;
  /** market.order_ttl_blocks from /v1/pub/context */
  orderTtlBlocks: number;
  accountId?: number;
  /** token bucket: per minute and burst (testnet: 50/min, under the 60/min limit) */
  ratePerMin?: number;
  burst?: number;
  /** websocket.md "Keep-Alive": mt: 1 every 30 s (counts toward the request budget) */
  pingEveryMs?: number;
  /** give up waiting for a definitive mt: 24 this many blocks after lb has passed (default 10) */
  outcomeGraceBlocks?: number;
  clock?: Clock;
  factory?: (url: string) => WsLike;
  fetchFn?: typeof fetch;
  random?: (n: number) => Uint8Array;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
};

export type Placed = {
  rq: number;
  sn: number;
  lb: number;
  transport: "ws" | "rest";
  /** gateway admission: code 0 = accepted for forwarding; non-zero = rejected, no mt: 24 will follow */
  ack: Promise<{ code: number; error: string }>;
  /** first definitive order event for this rq, or a timeout / rejection / lost connection (state reconciles later) */
  outcome: Promise<PlaceResult>;
};
export type PlaceResult =
  | { kind: "outcome"; outcome: OrderOutcome }
  | { kind: "rejected"; code: number; error: string }
  | { kind: "unknown"; reason: string };

type Pending = {
  rq: number;
  sn: number;
  lb: number;
  ack: (s: { code: number; error: string }) => void;
  done: (r: PlaceResult) => void;
  settled: boolean;
  acked: boolean;
};

export class PerplTrading {
  readonly state: PerplState;
  private ws: WsLike | undefined;
  private authed = false;
  private stopped = true;
  private attempt = 0;
  private timers = { reconnect: undefined as unknown, ping: undefined as unknown };
  private localRq = 0;
  private sn = 0;
  private readonly bucket: TokenBucket;
  private readonly pending = new Map<number, Pending>(); // by rq
  private readonly bySn = new Map<number, number>(); // sn → rq
  private readyWaiters: (() => void)[] = [];
  readonly stats = { connects: 0, closes: 0, lastClose: "", authFailures: 0, gaps: 0, sent: 0, throttled: 0, restOrders: 0 };
  onEvent: ((e: StateEvent) => void) | undefined;

  constructor(private readonly c: TradingConfig) {
    this.state = new PerplState(c.marketId, c.accountId);
    this.bucket = new TokenBucket(c.burst ?? 5, c.ratePerMin ?? 50, this.clock.now());
  }

  private get clock(): Clock {
    return this.c.clock ?? realClock;
  }
  private log(msg: string, extra: Record<string, unknown> = {}): void {
    this.c.log?.(msg, redact(extra));
  }

  /** connected, signed in and holding all three initial snapshots */
  get ready(): boolean {
    return this.ws !== undefined && this.authed && this.state.ready;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clock.clearTimeout(this.timers.reconnect);
    this.clock.clearTimeout(this.timers.ping);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000, "stop");
    this.failPending("stopped");
  }

  /** Resolves when ready (or after `timeoutMs`, returning false). */
  waitReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((res) => {
      const h = this.clock.setTimeout(() => res(false), timeoutMs);
      this.readyWaiters.push(() => {
        this.clock.clearTimeout(h);
        res(true);
      });
    });
  }

  private connect(): void {
    const url = `${this.c.wsUrl.replace(/\/+$/, "")}/ws/v1/trading`;
    const ws = (this.c.factory ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(url);
    this.ws = ws;
    this.authed = false;
    this.state.reset();
    this.stats.connects++;
    ws.onopen = () => {
      void this.signIn(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        this.log("perpl ws: non-JSON frame dropped");
        return;
      }
      this.onFrame(ws, frame);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.closed(ev.code, ev.reason);
    };
  }

  /** authentication.md: the signed ApiKeySignIn is the FIRST frame (fresh timestamp + nonce on every connection). */
  private async signIn(ws: WsLike): Promise<void> {
    const frame = await signInFrame(this.c.apiKey, this.c.secret, { chainId: this.c.chainId, timestampMs: this.clock.now(), nonce: newNonce(this.c.random ?? randomBytes) });
    if (this.ws !== ws) return;
    this.bucket.tryTake(this.clock.now()); // counts toward the budget like any frame
    ws.send(JSON.stringify(frame));
    this.armPing(ws);
  }

  private onFrame(ws: WsLike, frame: unknown): void {
    let events: StateEvent[];
    try {
      events = this.state.apply(frame, this.clock.now());
    } catch (e) {
      this.log("perpl ws: bad frame", { error: String(e) });
      return;
    }
    // the wallet snapshot is the first thing an authenticated socket receives (websocket.md "Initial Snapshots")
    if ((frame as { mt?: number }).mt === MT.walletSnapshot) this.authed = true;
    for (const e of events) {
      if (e.kind === "account") this.localRq = Math.max(this.localRq, e.account.lfr);
      if (e.kind === "status") this.onStatus(e.cid, e.code, e.error);
      if (e.kind === "outcome") this.settle(e.outcome.rq, { kind: "outcome", outcome: e.outcome });
      if (e.kind === "gap") {
        // websocket.md "Heartbeat (Trading)": a gap means messages may be lost ⇒ force a reconnect for fresh snapshots
        this.stats.gaps++;
        this.log("perpl ws: heartbeat gap, reconnecting", { expected: e.expected, got: e.got });
        this.drop(ws, 4000, "heartbeat gap");
        return;
      }
      if (e.kind === "ready") {
        this.attempt = 0;
        const w = this.readyWaiters.splice(0);
        for (const f of w) f();
      }
      this.onEvent?.(e);
    }
    this.expireByBlock();
  }

  private onStatus(cid: number | undefined, code: number, error: string): void {
    if (cid === undefined) return;
    const rq = this.bySn.get(cid);
    if (rq === undefined) return;
    this.bySn.delete(cid);
    const p = this.pending.get(rq);
    if (!p) return;
    p.acked = true;
    p.ack({ code, error });
    // websocket.md: a non-zero code means the gateway rejected the frame and NO mt: 24 will follow
    if (code !== 0) this.settle(rq, { kind: "rejected", code, error });
  }

  private settle(rq: number, r: PlaceResult): void {
    const p = this.pending.get(rq);
    if (!p || p.settled) return;
    p.settled = true;
    this.pending.delete(rq);
    if (!p.acked) p.ack(r.kind === "rejected" ? { code: r.code, error: r.error } : { code: 0, error: "" });
    p.done(r);
  }

  /** No definitive status by `lb` + grace ⇒ unknown (the caller reconciles from snapshots before acting again). */
  private expireByBlock(): void {
    const head = this.state.head;
    if (!head) return;
    const grace = this.c.outcomeGraceBlocks ?? 10;
    for (const p of [...this.pending.values()]) if (head.block >= p.lb + grace) this.settle(p.rq, { kind: "unknown", reason: `no status by block ${head.block} (lb ${p.lb})` });
  }

  private failPending(reason: string): void {
    for (const p of [...this.pending.values()]) this.settle(p.rq, { kind: "unknown", reason });
  }

  private drop(ws: WsLike, code: number, reason: string): void {
    if (this.ws !== ws) return;
    ws.onclose = null;
    ws.close(code, reason);
    this.closed(code, reason);
  }

  private closed(code: number, reason: string): void {
    this.ws = undefined;
    this.authed = false;
    this.clock.clearTimeout(this.timers.ping);
    this.stats.closes++;
    this.stats.lastClose = `${code} ${reason}`;
    if (code === 3401) this.stats.authFailures++;
    // README: a close carries no per-request status; anything in flight is lost silently ⇒ reconcile, never assume
    this.failPending(`connection closed ${code} ${reason}`);
    if (this.stopped) return;
    const delay = tradingReconnectDelayMs(code, this.attempt++, this.clock.random);
    this.log("perpl ws: closed", { code, reason, reconnectInMs: delay });
    this.timers.reconnect = this.clock.setTimeout(() => this.connect(), delay);
  }

  private armPing(ws: WsLike): void {
    const every = this.c.pingEveryMs ?? 30_000;
    if (every <= 0) return;
    const ping = () => {
      if (this.ws !== ws || this.stopped) return;
      if (this.bucket.tryTake(this.clock.now())) ws.send(JSON.stringify({ mt: MT.ping, t: this.clock.now() }));
      this.timers.ping = this.clock.setTimeout(ping, every);
    };
    this.timers.ping = this.clock.setTimeout(ping, every);
  }

  /** websocket.md "Request ID generation": rq = max(local, account.lfr) + 1. */
  nextRq(): number {
    this.localRq = Math.max(this.localRq, this.state.account?.lfr ?? 0) + 1;
    return this.localRq;
  }

  /** order_ttl_blocks is per market and can change (websocket.md "Last execution block"): set from /v1/pub/context. */
  setOrderTtlBlocks(n: number): void {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("order_ttl_blocks must be a positive integer");
    this.c.orderTtlBlocks = n;
  }

  /** head < lb ≤ head + order_ttl_blocks; undefined until a heartbeat gave us the head. */
  lastExecBlock(): number | undefined {
    const h = this.state.head?.block;
    return h === undefined ? undefined : h + this.c.orderTtlBlocks;
  }

  /** ms until the bucket allows one more frame (0 = now). */
  throttleMs(): number {
    return this.bucket.waitMs(this.clock.now());
  }

  /**
   * Place / cancel one order (OrderSpec without rq/lb/acc: those are filled here). Over the WS when ready, else over
   * REST (POST /v1/trading/orders, a batch of one). Throws without sending when the rate budget is spent or there is no
   * head block / account yet: never an order we can't confirm.
   */
  async place(spec: Omit<OrderSpec, "rq" | "lb" | "acc">): Promise<Placed> {
    const acc = this.state.accId;
    const lb = this.lastExecBlock();
    if (acc === undefined) throw new Error("perpl: no account yet (wallet snapshot not received)");
    if (lb === undefined) throw new Error("perpl: no head block yet (heartbeat not received)");
    if (!this.bucket.tryTake(this.clock.now())) {
      this.stats.throttled++;
      throw new Error("perpl: request budget spent (token bucket), not sending");
    }
    const rq = this.nextRq();
    const sn = ++this.sn;
    const full: OrderSpec = { ...spec, rq, acc, lb };
    let ackRes!: Placed["ack"] extends Promise<infer T> ? (v: T) => void : never;
    let doneRes!: (r: PlaceResult) => void;
    const ack = new Promise<{ code: number; error: string }>((r) => (ackRes = r));
    const outcome = new Promise<PlaceResult>((r) => (doneRes = r));
    this.pending.set(rq, { rq, sn, lb, ack: ackRes, done: doneRes, settled: false, acked: false });
    if (this.ready && this.ws) {
      this.bySn.set(sn, rq);
      this.ws.send(JSON.stringify({ mt: MT.order, sn, ...full }));
      this.stats.sent++;
      this.log("perpl order sent", { transport: "ws", sn, ...full });
      return { rq, sn, lb, transport: "ws", ack, outcome };
    }
    this.stats.restOrders++;
    try {
      const res = (await this.rest("POST", "/v1/trading/orders", JSON.stringify({ sn, d: [full] }))) as BatchStatus;
      const st = res.status?.code ? res.status : (res.statuses?.[0] ?? { code: -1, error: "no per-order status" });
      const p = this.pending.get(rq);
      if (p) {
        p.acked = true;
        p.ack({ code: st.code, error: st.error ?? "" });
      }
      if (st.code !== 0) this.settle(rq, { kind: "rejected", code: st.code, error: st.error ?? "" });
      else void this.confirmOverRest(rq, lb);
    } catch (e) {
      this.settle(rq, { kind: "unknown", reason: `rest: ${String(e)}` });
    }
    this.log("perpl order sent", { transport: "rest", sn, ...full });
    return { rq, sn, lb, transport: "rest", ack, outcome };
  }

  /** REST path: poll order history for the rq until a definitive status (or the WS delivers it first). */
  private async confirmOverRest(rq: number, lb: number): Promise<void> {
    for (let i = 0; i < 10 && this.pending.has(rq); i++) {
      await new Promise((r) => this.clock.setTimeout(() => r(undefined), 1_000));
      try {
        const page = (await this.rest("GET", "/v1/trading/order-history?count=20")) as { d?: unknown[] };
        for (const raw of page.d ?? []) {
          const ev = this.state.apply({ mt: MT.orders, d: [raw] }, this.clock.now());
          for (const e of ev) if (e.kind === "outcome" && e.outcome.rq === rq) this.settle(rq, { kind: "outcome", outcome: e.outcome });
        }
      } catch (e) {
        this.log("perpl rest confirm failed", { error: String(e) });
      }
    }
    if (this.pending.has(rq)) this.settle(rq, { kind: "unknown", reason: `no order-history entry for rq ${rq} (lb ${lb})` });
  }

  /** Cancel one resting order (t: 5). */
  cancel(oid: number): Promise<Placed> {
    return this.place({ mkt: this.c.marketId, oid, t: 5, s: 0, fl: 0, lv: 0 });
  }

  /** Signed REST call (authentication.md). 429/503 retried with back-off; other non-2xx throw with the status. */
  async rest(method: "GET" | "POST", target: string, body = ""): Promise<unknown> {
    const f = this.c.fetchFn ?? fetch;
    for (let i = 0; i < 3; i++) {
      const headers = await restHeaders(this.c.apiKey, this.c.secret, { chainId: this.c.chainId, method, target, timestampMs: this.clock.now(), nonce: newNonce(this.c.random ?? randomBytes), body });
      const res = await f(`${this.c.apiUrl.replace(/\/+$/, "")}${target}`, { method, headers: { ...headers, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) });
      const text = await res.text();
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => this.clock.setTimeout(() => r(undefined), 1_000 * 2 ** i));
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`perpl ${method} ${target}: HTTP ${res.status} ${text.slice(0, 200)}`), { status: res.status });
      return text ? JSON.parse(text) : undefined;
    }
    throw Object.assign(new Error(`perpl ${method} ${target}: still 429/503 after retries`), { status: 429 });
  }

  /**
   * Reconcile from REST snapshots (rest-endpoints.md "Trading State Endpoints": same shapes as the WS snapshots), used at
   * startup and whenever the WS is down. 404 ⇒ the wallet holds no exchange account.
   */
  async restSnapshot(): Promise<void> {
    const [wallet, orders, positions] = await Promise.all([this.rest("GET", "/v1/trading/wallet"), this.rest("GET", "/v1/trading/orders"), this.rest("GET", "/v1/trading/positions")]);
    const now = this.clock.now();
    for (const f of [wallet, orders, positions]) for (const e of this.state.apply(f, now)) if (e.kind === "account") this.localRq = Math.max(this.localRq, e.account.lfr);
    const sn = (wallet as { sn?: number }).sn;
    if (typeof sn === "number" && !this.ready) this.state.head = { block: sn, recvMs: now }; // REST lb base (rest-endpoints.md "The last execution block over HTTP")
  }

  /** Orders of ours still open (resting) in the market. */
  openOrders(): Order[] {
    return [...this.state.openOrders.values()].filter((o) => o.st === OrderStatus.Open || o.st === OrderStatus.PartiallyFilled || o.st === OrderStatus.Pending);
  }
}
