// Small server cache for the Perpl read routes: one entry per key for `ttlMs`, concurrent misses share one read, a
// rate-limited RPC (HTTP 429) pauses that key's reads with exponential backoff (base · 2^n, capped), and while paused
// or failing the last good value is served for up to `staleMaxMs` (marked stale), else the error.
export type Cached<T> = { ok: true; value: T; at: number; stale: boolean } | { ok: false; error: string; status: 429 | 502 | 503; retryAfterMs?: number };

export const isRateLimited = (e: unknown): boolean => {
  const s = JSON.stringify(e instanceof Error ? { m: e.message, c: (e as { cause?: unknown }).cause, s: (e as { status?: unknown }).status } : e) ?? "";
  return /\b429\b|rate.?limit|too many requests/i.test(s);
};

export function createTtlCache<T>(o: { ttlMs: number; staleMaxMs: number; backoffBaseMs?: number; backoffMaxMs?: number; now?: () => number }) {
  const now = o.now ?? Date.now;
  const base = o.backoffBaseMs ?? 2_000;
  const cap = o.backoffMaxMs ?? 60_000;
  const good = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<Cached<T>>>();
  const pause = new Map<string, { until: number; n: number }>();

  const fallback = (key: string, error: string, status: 429 | 502 | 503, retryAfterMs?: number): Cached<T> => {
    const g = good.get(key);
    if (g && now() - g.at <= o.staleMaxMs) return { ok: true, value: g.value, at: g.at, stale: true };
    return { ok: false, error, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  };

  async function get(key: string, load: () => Promise<T>, describe: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e))): Promise<Cached<T>> {
    const g = good.get(key);
    if (g && now() - g.at < o.ttlMs) return { ok: true, value: g.value, at: g.at, stale: false };
    const p = pause.get(key);
    if (p && now() < p.until) return fallback(key, "RPC rate-limited, backing off", 429, p.until - now());
    const running = inflight.get(key);
    if (running) return running;
    const run = (async (): Promise<Cached<T>> => {
      try {
        const value = await load();
        good.set(key, { at: now(), value });
        pause.delete(key);
        return { ok: true, value, at: now(), stale: false };
      } catch (e) {
        if (isRateLimited(e)) {
          const n = (pause.get(key)?.n ?? 0) + 1;
          const wait = Math.min(cap, base * 2 ** (n - 1));
          pause.set(key, { until: now() + wait, n });
          return fallback(key, "RPC rate-limited, backing off", 429, wait);
        }
        return fallback(key, describe(e), 502);
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, run);
    return run;
  }
  return { get, size: () => good.size };
}
