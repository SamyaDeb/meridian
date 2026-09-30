// Shared RPC plumbing for the keeper and the MM (WS-03, Phase 4 step 1). Pure helpers + one fetch wrapper with
// injected I/O, all unit-tested in test/rpc.test.ts.
//
// Why a fetch wrapper: on the Alchemy free tier and the public testnet RPC (~25 rps) bursts come back as HTTP 429 /
// "HTTP request failed" and a whole keeper step failed (Phase 3, 30 Sep). viem's `http` transport accepts a `fetchFn`,
// so every request of a client goes through here: it is counted by JSON-RPC method (calls/min in /health) and a
// throttled request is retried with capped exponential back-off and jitter instead of failing the step.

/** Capped exponential back-off with "equal jitter": d = min(cap, base·2^attempt); returns d/2 + rand·d/2. */
export function backoffDelayMs(attempt: number, opts: { baseMs: number; capMs: number }, rand: number): number {
  const d = Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt));
  const r = Math.min(1, Math.max(0, rand));
  return Math.round(d / 2 + (r * d) / 2);
}

/** 429 = throttled (the request was not processed); 502/503/504 = gateway trouble. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** JSON-RPC method names in a request body (single call or batch); [] if the body isn't JSON-RPC. */
export function rpcMethods(body: unknown): string[] {
  if (typeof body !== "string") return [];
  try {
    const j = JSON.parse(body) as unknown;
    const arr = Array.isArray(j) ? j : [j];
    return arr.flatMap((x) => (x !== null && typeof x === "object" && typeof (x as { method?: unknown }).method === "string" ? [(x as { method: string }).method] : []));
  } catch {
    return [];
  }
}

/**
 * A retry must never duplicate a state change. A 429 means the request was refused, so even a send may be retried
 * (the same signed bytes ⇒ same hash; a duplicate is rejected as "already known"). After a network error or a 5xx the
 * send may have been accepted, so only reads are retried then.
 */
export function mayRetry(methods: readonly string[], status: number | null): boolean {
  if (status === 429) return true;
  return !methods.includes("eth_sendRawTransaction");
}

export interface RpcStats {
  /** JSON-RPC calls sent (a batch of n counts n; retries count again). */
  calls: number;
  byMethod: Record<string, number>;
  /** HTTP 429 responses seen. */
  rateLimited: number;
  retries: number;
  /** Requests that failed after all retries (or were not retryable). */
  errors: number;
}

export function newRpcStats(): RpcStats {
  return { calls: 0, byMethod: {}, rateLimited: 0, retries: 0, errors: 0 };
}

export interface CountingFetchOptions {
  stats: RpcStats;
  /** Retries after the first attempt (default 5 ⇒ worst case ≈ base·(1+2+4+8+16) with the cap). */
  maxRetries?: number;
  baseMs?: number;
  capMs?: number;
  /** Called for every request (e.g. a RateWindow). */
  onCall?: (methods: readonly string[]) => void;
  // injected for tests
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

/** A `fetch` for viem's `http(url, { fetchFn, retryCount: 0 })`: counts calls, retries 429/5xx with jittered back-off. */
export function createCountingFetch(o: CountingFetchOptions): typeof globalThis.fetch {
  const f = o.fetch ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = o.rand ?? Math.random;
  const maxRetries = o.maxRetries ?? 5;
  const b = { baseMs: o.baseMs ?? 200, capMs: o.capMs ?? 4_000 };
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const methods = rpcMethods(init?.body);
    for (let attempt = 0; ; attempt++) {
      o.stats.calls += Math.max(1, methods.length);
      for (const m of methods) o.stats.byMethod[m] = (o.stats.byMethod[m] ?? 0) + 1;
      o.onCall?.(methods);
      let res: Response;
      try {
        res = await f(input, init);
      } catch (e) {
        if (attempt < maxRetries && mayRetry(methods, null)) {
          o.stats.retries++;
          await sleep(backoffDelayMs(attempt, b, rand()));
          continue;
        }
        o.stats.errors++;
        throw e;
      }
      if (res.status === 429) o.stats.rateLimited++;
      if (isRetryableStatus(res.status) && attempt < maxRetries && mayRetry(methods, res.status)) {
        o.stats.retries++;
        await sleep(backoffDelayMs(attempt, b, rand()));
        continue;
      }
      if (!res.ok) o.stats.errors++;
      return res;
    }
  }) as typeof globalThis.fetch;
}

/** Events per minute over a sliding window (default 60 s). `now` is injected (ms). */
export class RateWindow {
  private readonly ts: number[] = [];
  constructor(private readonly windowMs = 60_000) {}
  add(nowMs: number, n = 1): void {
    for (let i = 0; i < n; i++) this.ts.push(nowMs);
    this.prune(nowMs);
  }
  /** Events per minute, extrapolated from the covered part of the window. */
  perMinute(nowMs: number): number {
    this.prune(nowMs);
    if (this.ts.length === 0) return 0;
    return (this.ts.length * 60_000) / this.windowMs;
  }
  private prune(nowMs: number): void {
    while (this.ts.length > 0 && this.ts[0]! <= nowMs - this.windowMs) this.ts.shift();
  }
}

export interface BalanceSample {
  tMs: number;
  wei: bigint;
}

/**
 * MON burned per hour (wei/h) from balance samples in time order: the sum of the decreases between consecutive
 * samples (a top-up is not negative spending) scaled to one hour. null until two samples ≥ 1 s apart exist.
 */
export function burnPerHourWei(samples: readonly BalanceSample[]): bigint | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const dt = last.tMs - first.tMs;
  if (dt < 1_000) return null;
  let spent = 0n;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i - 1]!.wei - samples[i]!.wei;
    if (d > 0n) spent += d;
  }
  return (spent * 3_600_000n) / BigInt(dt);
}

/** Keep samples younger than `windowMs` (plus the newest one before it, so the window stays covered). */
export function pruneSamples(samples: readonly BalanceSample[], nowMs: number, windowMs: number): BalanceSample[] {
  const cut = nowMs - windowMs;
  let i = 0;
  while (i + 1 < samples.length && samples[i + 1]!.tMs <= cut) i++;
  return samples.slice(i);
}
