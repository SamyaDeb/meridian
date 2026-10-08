// Perpl trading state for ONE account and ONE market, rebuilt from the trading WebSocket's snapshots and updates (pure).
// Ported unchanged from meridian-k3/mm-bot/src/perpl/state.ts (perpl-hedge @ fe873b0).
// websocket.md "Initial Snapshots" (mt 19 wallet, 23 orders, 26 positions), updates (21 account, 24 orders, 25 fills,
// 27 positions), "Heartbeat (Trading)" (sequence from the wallet snapshot's sn, +1 each, gap ⇒ reconnect), and the
// per-rq deduplication rules in "Placing Orders" (first non-failure status is definitive; only failures ⇒ the first).
// A reconnect calls reset(): everything is re-derived from the new snapshots, never patched across connections.
import { MT, OrderStatus, PositionSide, PositionStatus, type Account, type Fill, type Order, type Position } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export class PerplFrameError extends Error {
  override name = "PerplFrameError";
}
function need(ok: boolean, what: string): asserts ok {
  if (!ok) throw new PerplFrameError(what);
}

export function parseAccount(v: unknown): Account {
  need(isObj(v), "account: expected object");
  const o = v as Obj;
  need(int(o.id) && int(o.lfr) && typeof o.fw === "boolean" && typeof o.fr === "boolean", "account: id/lfr/fw/fr");
  need(typeof o.b === "string" && /^-?\d+$/.test(o.b) && typeof o.lb === "string" && /^-?\d+$/.test(o.lb), "account: b/lb decimal strings");
  return { in: int(o.in) ? o.in : 0, id: o.id as number, fr: o.fr as boolean, fw: o.fw as boolean, ft: int(o.ft) ? o.ft : 0, lfr: o.lfr as number, b: o.b as string, lb: o.lb as string };
}
export function parseOrder(v: unknown): Order {
  need(isObj(v), "order: expected object");
  const o = v as Obj;
  need(int(o.rq) && int(o.mkt) && int(o.acc) && int(o.oid) && int(o.t), "order: rq/mkt/acc/oid/t");
  return {
    ...(isObj(o.at) ? { at: o.at as Order["at"] & object } : {}),
    rq: o.rq as number,
    mkt: o.mkt as number,
    acc: o.acc as number,
    oid: o.oid as number,
    st: int(o.st) ? o.st : 0,
    sr: int(o.sr) ? o.sr : 0,
    ...(int(o.fr) ? { fr: o.fr } : {}),
    t: o.t as number,
    ...(o.r === true ? { r: true } : {}),
    ...(int(o.p) ? { p: o.p } : {}),
    os: int(o.os) ? o.os : 0,
    fp: int(o.fp) ? o.fp : 0,
    fs: int(o.fs) ? o.fs : 0,
    f: typeof o.f === "string" ? o.f : "0",
    fl: int(o.fl) ? o.fl : 0,
    lv: int(o.lv) ? o.lv : 0,
  };
}
export function parseFill(v: unknown): Fill {
  need(isObj(v), "fill: expected object");
  const o = v as Obj;
  need(int(o.mkt) && int(o.acc) && int(o.oid) && int(o.s) && int(o.l), "fill: mkt/acc/oid/s/l");
  return { ...(isObj(o.at) ? { at: o.at as Fill["at"] & object } : {}), mkt: o.mkt as number, acc: o.acc as number, oid: o.oid as number, t: int(o.t) ? o.t : 0, l: o.l as number, ...(int(o.p) ? { p: o.p } : {}), s: o.s as number, f: typeof o.f === "string" ? o.f : "0" };
}
export function parsePosition(v: unknown): Position {
  need(isObj(v), "position: expected object");
  const o = v as Obj;
  need(int(o.mkt) && int(o.acc) && int(o.pid) && int(o.st) && int(o.sd) && int(o.s), "position: mkt/acc/pid/st/sd/s");
  return { ...(isObj(o.at) ? { at: o.at as Position["at"] & object } : {}), mkt: o.mkt as number, acc: o.acc as number, pid: o.pid as number, st: o.st as number, sd: o.sd as number, s: o.s as number, ep: int(o.ep) ? o.ep : 0, c: typeof o.c === "string" ? o.c : "0" };
}

/** First definitive outcome per rq (websocket.md "Client-side deduplication"). */
export type OrderOutcome = { rq: number; order: Order; failed: boolean };

export type StateEvent =
  | { kind: "ready" }
  | { kind: "account"; account: Account }
  | { kind: "outcome"; outcome: OrderOutcome }
  | { kind: "order"; order: Order }
  | { kind: "fill"; fill: Fill }
  | { kind: "position"; netSize: number }
  | { kind: "gap"; expected: number; got: number }
  | { kind: "status"; cid: number | undefined; code: number; error: string };

const isFailure = (st: number) => st === OrderStatus.Failed;

export class PerplState {
  account: Account | undefined;
  /** open positions of our account in our market, by pid */
  private positions = new Map<number, Position>();
  /** resting orders of our account in our market, by oid */
  readonly openOrders = new Map<number, Order>();
  private outcomes = new Map<number, OrderOutcome>();
  readonly fills: Fill[] = [];
  head: { block: number; recvMs: number } | undefined;
  lastFrameMs: number | undefined;
  private lastSn: number | undefined;
  private seen = { wallet: false, orders: false, positions: false };

  constructor(
    readonly marketId: number,
    /** account id to follow; undefined ⇒ the wallet snapshot's first account (websocket.md example) */
    private accountId?: number,
    private readonly maxFills = 200,
  ) {}

  get accId(): number | undefined {
    return this.account?.id ?? this.accountId;
  }

  /** all three initial snapshots received since the last reset */
  get ready(): boolean {
    return this.seen.wallet && this.seen.orders && this.seen.positions;
  }

  /** New connection: forget sequence and snapshot flags; the next snapshots replace everything. */
  reset(): void {
    this.lastSn = undefined;
    this.seen = { wallet: false, orders: false, positions: false };
  }

  /** Net position in our market, signed, in scaled size units (Long +, Short −). */
  netSize(): number {
    let n = 0;
    for (const p of this.positions.values()) if (p.st === PositionStatus.Open) n += p.sd === PositionSide.Long ? p.s : -p.s;
    return n;
  }

  outcome(rq: number): OrderOutcome | undefined {
    return this.outcomes.get(rq);
  }

  apply(frame: unknown, recvMs: number): StateEvent[] {
    need(isObj(frame) && int((frame as Obj).mt), "frame: expected { mt }");
    const f = frame as Obj;
    this.lastFrameMs = recvMs;
    const ev: StateEvent[] = [];
    const wasReady = this.ready;
    switch (f.mt) {
      case MT.status: {
        const st = isObj(f.status) ? f.status : {};
        ev.push({ kind: "status", cid: int(f.cid) ? f.cid : undefined, code: int(st.code) ? st.code : -1, error: typeof st.error === "string" ? st.error : "" });
        break;
      }
      case MT.walletSnapshot: {
        need(Array.isArray(f.as), "wallet snapshot: as[]");
        const accounts = (f.as as unknown[]).map(parseAccount);
        const a = this.accountId !== undefined ? accounts.find((x) => x.id === this.accountId) : accounts[0];
        if (a) {
          this.account = a;
          ev.push({ kind: "account", account: a });
        }
        if (int(f.sn)) this.lastSn = f.sn;
        this.seen.wallet = true;
        break;
      }
      case MT.account: {
        const a = parseAccount(f);
        if (this.accId === undefined || a.id === this.accId) {
          this.account = a; // fw, ft and lfr re-read on every update (README: fw has no other signal)
          ev.push({ kind: "account", account: a });
        }
        break;
      }
      case MT.ordersSnapshot:
        need(Array.isArray(f.d), "orders snapshot: d[]");
        this.openOrders.clear();
        for (const o of (f.d as unknown[]).map(parseOrder)) if (this.mine(o)) this.openOrders.set(o.oid, o);
        this.seen.orders = true;
        break;
      case MT.orders:
        need(Array.isArray(f.d), "orders update: d[]");
        for (const o of (f.d as unknown[]).map(parseOrder)) {
          if (!this.mine(o)) continue;
          ev.push({ kind: "order", order: o });
          if (o.r || o.st === OrderStatus.Filled || o.st === OrderStatus.Canceled || o.st === OrderStatus.Expired || isFailure(o.st)) this.openOrders.delete(o.oid);
          else if (o.oid !== 0) this.openOrders.set(o.oid, o);
          const prev = this.outcomes.get(o.rq);
          // first non-failure is definitive and wins over everything later; with only failures, the first one
          if (!prev || (prev.failed && !isFailure(o.st))) {
            const out = { rq: o.rq, order: o, failed: isFailure(o.st) };
            this.outcomes.set(o.rq, out);
            ev.push({ kind: "outcome", outcome: out });
          } else if (!prev.failed && prev.order.oid === o.oid) {
            // same definitive order progressing (e.g. IOC fills then is removed): keep the latest view for fs/fp
            this.outcomes.set(o.rq, { ...prev, order: o });
          }
        }
        this.trimOutcomes();
        break;
      case MT.fills:
        need(Array.isArray(f.d), "fills: d[]");
        for (const x of (f.d as unknown[]).map(parseFill)) {
          if (x.mkt !== this.marketId || (this.accId !== undefined && x.acc !== this.accId)) continue;
          this.fills.push(x);
          ev.push({ kind: "fill", fill: x });
        }
        if (this.fills.length > this.maxFills) this.fills.splice(0, this.fills.length - this.maxFills);
        break;
      case MT.positionsSnapshot:
      case MT.positions: {
        need(Array.isArray(f.d), "positions: d[]");
        if (f.mt === MT.positionsSnapshot) this.positions.clear();
        for (const p of (f.d as unknown[]).map(parsePosition)) {
          if (p.mkt !== this.marketId || (this.accId !== undefined && p.acc !== this.accId)) continue;
          if (p.st === PositionStatus.Open && p.s > 0) this.positions.set(p.pid, p);
          else this.positions.delete(p.pid);
        }
        if (f.mt === MT.positionsSnapshot) this.seen.positions = true;
        ev.push({ kind: "position", netSize: this.netSize() });
        break;
      }
      case MT.heartbeat: {
        need(int(f.sn) && int(f.h), "heartbeat: sn/h");
        this.head = { block: f.h as number, recvMs };
        if (this.lastSn !== undefined && f.sn !== this.lastSn + 1) ev.push({ kind: "gap", expected: this.lastSn + 1, got: f.sn as number });
        this.lastSn = f.sn as number;
        break;
      }
      default:
        break;
    }
    if (!wasReady && this.ready) ev.push({ kind: "ready" });
    return ev;
  }

  private mine(o: Order): boolean {
    return o.mkt === this.marketId && (this.accId === undefined || o.acc === this.accId);
  }

  private trimOutcomes(): void {
    if (this.outcomes.size <= 500) return;
    const keys = [...this.outcomes.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - 500)) this.outcomes.delete(k);
  }
}

/** Account balance minus locked balance, in collateral token units (decimal strings ⇒ bigint, exact). */
export function availableCollateral(a: Account): bigint {
  return BigInt(a.b) - BigInt(a.lb);
}
