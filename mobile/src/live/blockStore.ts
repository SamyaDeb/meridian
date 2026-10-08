// Chain head for the whole app: one source (WS subscription when configured, else a ~400 ms getBlockNumber poll),
// liveness, measured cadence (core CadenceMeter), back-off on 429 / errors, pause in background. Pure TS: the timer,
// clock and RPC calls are injected so tests drive it without a network or a device.
import { CadenceMeter, type BlockCadence } from "@meridian/core/route";
import { liveness, observeHead, type HeadState, type Liveness } from "@meridian/core/meridian";
import { Store } from "./store";

export const POLL_MS = 400;
export const MAX_BACKOFF_MS = 10_000;
/** liveness re-check period while no new block arrives (WS mode, or a slow poll) */
export const LIVENESS_CHECK_MS = 1_000;

export type BlockState = {
  block: bigint | undefined;
  head: HeadState;
  liveness: Liveness;
  cadence: BlockCadence | undefined;
  /** "ws" while a subscription delivers heads; "poll" otherwise */
  source: "poll" | "ws";
  running: boolean;
  /** current back-off after errors (0 when healthy) */
  backoffMs: number;
  /** consecutive failed polls */
  failures: number;
  lastError: string | undefined;
};

export type Timer = { set(fn: () => void, ms: number): unknown; clear(h: unknown): void; now(): number };

export const realTimer: Timer = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() };

export type BlockSourceDeps = {
  getBlockNumber: () => Promise<bigint>;
  /** optional head subscription (viem watchBlockNumber over a WS transport); returns an unsubscribe */
  subscribeHeads?: (onBlock: (b: bigint) => void, onError: (e: unknown) => void) => () => void;
  timer?: Timer;
  pollMs?: number;
};

/** HTTP 429 from viem (HttpRequestError.status) or a JSON-RPC "rate limit" message. */
export function isRateLimited(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const o = e as { status?: unknown; message?: unknown; cause?: unknown };
  if (o.status === 429) return true;
  if (typeof o.message === "string" && /\b429\b|rate.?limit/i.test(o.message)) return true;
  return o.cause !== undefined && o.cause !== e ? isRateLimited(o.cause) : false;
}

/** Next back-off: 429 doubles from 1 s, other errors from the poll period; capped. */
export function nextBackoffMs(prev: number, rateLimited: boolean, pollMs: number): number {
  const base = rateLimited ? 1_000 : pollMs;
  return Math.min(MAX_BACKOFF_MS, prev > 0 ? prev * 2 : base);
}

const initial: BlockState = { block: undefined, head: undefined, liveness: "waiting", cadence: undefined, source: "poll", running: false, backoffMs: 0, failures: 0, lastError: undefined };

export class BlockSource {
  readonly store = new Store<BlockState>(initial);
  private readonly meter = new CadenceMeter();
  private readonly timer: Timer;
  private readonly pollMs: number;
  private pollHandle: unknown;
  private liveHandle: unknown;
  private unsubscribe: (() => void) | undefined;
  private inFlight = false;
  /** bumps on every start/stop so a late poll result from a previous run is ignored */
  private epoch = 0;

  constructor(private readonly deps: BlockSourceDeps) {
    this.timer = deps.timer ?? realTimer;
    this.pollMs = deps.pollMs ?? POLL_MS;
  }

  start(): void {
    if (this.store.get().running) return;
    this.epoch++;
    this.store.update({ running: true, backoffMs: 0, failures: 0 });
    if (this.deps.subscribeHeads) this.startWs();
    else this.poll(); // immediate refetch on start / foreground
    this.scheduleLivenessCheck();
  }

  stop(): void {
    this.epoch++;
    this.timer.clear(this.pollHandle);
    this.timer.clear(this.liveHandle);
    this.pollHandle = undefined;
    this.liveHandle = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.inFlight = false;
    this.store.update({ running: false });
  }

  /** A head from any source (also lets other readers that saw a newer block feed it in). */
  observe(block: bigint): void {
    const now = this.timer.now();
    const s = this.store.get();
    const head = observeHead(s.head, block, now);
    if (head === s.head) {
      // no progress: the head may have gone stale (a lagging RPC is not progress)
      const l = liveness(s.head, now);
      if (l !== s.liveness) this.store.update({ liveness: l });
      return;
    }
    this.meter.observe(block, now);
    this.store.update({ block: head?.block, head, liveness: liveness(head, now), cadence: this.meter.cadence() });
  }

  private startWs(): void {
    const epoch = this.epoch;
    this.store.update({ source: "ws" });
    this.poll(); // first head without waiting for the socket
    this.unsubscribe = this.deps.subscribeHeads!(
      (b) => {
        if (epoch === this.epoch) this.observe(b);
      },
      (e) => {
        if (epoch !== this.epoch) return;
        // the socket failed: fall back to polling for this run
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.store.update({ source: "poll", lastError: errText(e) });
        this.schedulePoll(this.pollMs);
      },
    );
  }

  private schedulePoll(ms: number): void {
    this.timer.clear(this.pollHandle);
    this.pollHandle = this.timer.set(() => this.poll(), ms);
  }

  private poll(): void {
    if (this.inFlight || !this.store.get().running) return;
    const epoch = this.epoch;
    this.inFlight = true;
    this.deps.getBlockNumber().then(
      (b) => {
        if (epoch !== this.epoch) return;
        this.inFlight = false;
        this.observe(b);
        if (this.store.get().failures > 0) this.store.update({ failures: 0, backoffMs: 0, lastError: undefined });
        if (this.store.get().source === "poll") this.schedulePoll(this.pollMs);
      },
      (e: unknown) => {
        if (epoch !== this.epoch) return;
        this.inFlight = false;
        const s = this.store.get();
        const backoffMs = nextBackoffMs(s.backoffMs, isRateLimited(e), this.pollMs);
        this.store.update({ failures: s.failures + 1, backoffMs, lastError: errText(e) });
        if (s.source === "poll") this.schedulePoll(backoffMs);
      },
    );
  }

  private scheduleLivenessCheck(): void {
    this.liveHandle = this.timer.set(() => {
      const s = this.store.get();
      if (!s.running) return;
      const l = liveness(s.head, this.timer.now());
      if (l !== s.liveness) this.store.update({ liveness: l });
      this.scheduleLivenessCheck();
    }, LIVENESS_CHECK_MS);
  }
}

/** First line of an error, URLs removed (viem errors embed the RPC URL, which may carry a key: never shown/logged). */
export function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (raw.split("\n")[0] ?? "").replace(/\b(?:https?|wss?):\/\/\S+/gi, "<url>").slice(0, 200);
}
