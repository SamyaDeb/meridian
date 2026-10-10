// ONE authenticated Perpl trading WebSocket for the whole app (README: max 4 connections per wallet, shared with
// browser sessions). Wraps core PerplTrading (sign-in mt 29 as the first frame, reconnect on core's documented delays,
// token bucket under 60/120 per minute). Runs only while the wallet is unlocked, onboarding is READY and the app is in
// the foreground: closed on background / lock / sign-out, reopened (fresh snapshots) on foreground.
import { PerplTrading, type Account, type StateEvent, type TradingConfig } from "@meridian/core/perpl";
import { Store } from "../../live/store";

export type SocketStatus = "off" | "connecting" | "ready";
export type TradingSocketState = {
  status: SocketStatus;
  /** clients opened by this manager (one per foreground session) */
  opens: number;
  /** WS connects of the current client (reconnects included) */
  connects: number; closes: number; lastClose: string | undefined; account: Account | undefined; netSize: number; head: number | undefined };

const OFF: TradingSocketState = { status: "off", opens: 0, connects: 0, closes: 0, lastClose: undefined, account: undefined, netSize: 0, head: undefined };

/** Build the core client for the current key + token (undefined when not tradeable). */
export type TradingFactory = () => TradingConfig | undefined;

let liveSockets = 0;
/** test/dev introspection: authenticated trading clients running in this JS runtime (must be ≤ 1) */
export const runningTradingSockets = (): number => liveSockets;

export class TradingSocketManager {
  readonly store = new Store<TradingSocketState>(OFF);
  private t: PerplTrading | undefined;
  private want = false;
  private active = true;

  constructor(
    private factory: TradingFactory,
    private make: (c: TradingConfig) => PerplTrading = (c) => new PerplTrading(c),
    private every: (fn: () => void, ms: number) => { cancel(): void } = (fn, ms) => {
      const h = setInterval(fn, ms);
      return { cancel: () => clearInterval(h) };
    },
  ) {}
  private tick_: { cancel(): void } | undefined;

  /** the running client (for orders); undefined when off */
  get client(): PerplTrading | undefined {
    return this.t;
  }

  /** Wanted on (READY + unlocked). Starts now if the app is in the foreground. */
  enable(): void {
    this.want = true;
    this.sync();
  }

  /** Lock / sign-out / not READY: close and forget the client (its key may be wiped next). */
  disable(): void {
    this.want = false;
    this.sync();
  }

  /** AppState: background closes the socket (in-flight orders become "unknown", reconciled on resume). */
  onAppState(state: string): void {
    if (state === "background") this.active = false;
    else if (state === "active") this.active = true;
    else return;
    this.sync();
  }

  private sync(): void {
    const run = this.want && this.active;
    if (run && !this.t) this.open();
    else if (!run && this.t) this.close();
  }

  private open(): void {
    const cfg = this.factory();
    if (!cfg) return;
    if (liveSockets > 0) throw new Error("a Perpl trading socket is already running in this app");
    const t = this.make(cfg);
    this.t = t;
    liveSockets++;
    t.onEvent = (e: StateEvent) => this.onEvent(t, e);
    this.store.update({ status: "connecting", opens: this.store.get().opens + 1 });
    t.start();
    // a close carries no frame: read core's stats once a second so the status line follows drops and reconnects
    this.tick_ = this.every(() => this.tick(), 1_000);
  }

  /** refresh the status from the client (connected + signed in + snapshots), connects and closes */
  tick(): void {
    const t = this.t;
    if (!t) return;
    this.store.update({ status: t.ready ? "ready" : "connecting", connects: t.stats.connects, closes: t.stats.closes, lastClose: t.stats.lastClose || undefined, head: t.state.head?.block });
  }

  private close(): void {
    const t = this.t;
    if (!t) return;
    this.t = undefined;
    liveSockets--;
    this.tick_?.cancel();
    this.tick_ = undefined;
    t.onEvent = undefined;
    t.stop();
    this.store.update({ status: "off", closes: t.stats.closes, lastClose: "stopped (background or lock)" });
  }

  private onEvent(t: PerplTrading, e: StateEvent): void {
    if (this.t !== t) return;
    const patch: Partial<TradingSocketState> = { status: t.ready ? "ready" : "connecting", connects: t.stats.connects, head: t.state.head?.block };
    if (e.kind === "account") patch.account = e.account;
    if (e.kind === "position") patch.netSize = e.netSize;
    this.store.update(patch);
  }

  /** wait for the signed-in socket (orders go over WS when ready, REST otherwise) */
  async waitReady(ms: number): Promise<boolean> {
    return this.t ? this.t.waitReady(ms) : false;
  }
}
