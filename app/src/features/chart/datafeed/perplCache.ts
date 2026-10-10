// Server-only cache in front of Perpl's public market-data REST API (used by app/api/perpl/*). Perpl's REST limits are
// not published (README "Rate Limits": back off on 429), and every viewer of one server shares them, so: the market is
// resolved from /v1/pub/context once per CONTEXT_TTL_MS, each candle resolution is fetched at most once per
// CANDLES_TTL_MS and the book once per BOOK_TTL_MS, concurrent misses share one fetch, the whole server stays within
// UPSTREAM_PER_MIN, a 429 pauses every upstream call for COOLDOWN_MS, and a 429, the budget or an outage serves the
// last good copy while it is still a fair reference (stale limits below), else an error.
import {
  perplBookUrl,
  perplCandlesUrl,
  perplContextUrl,
  resolvePerplMarket,
  trimBook,
  trimCandles,
  type PerplBookPayload,
  type PerplCandlesPayload,
  type PerplMarket,
  type PerplResolution,
} from "./perpl";

export const CONTEXT_TTL_MS = 10 * 60_000;
export const CANDLES_TTL_MS = 30_000;
export const BOOK_TTL_MS = 4_000;
export const CANDLES_STALE_MAX_MS = 15 * 60_000;
export const BOOK_STALE_MAX_MS = 30_000; // an older book is not a fair picture of the venue: report unavailable instead
/** Upstream calls per rolling minute for the whole server (book every 4 s = 15, plus candles and context). */
export const UPSTREAM_PER_MIN = 40;
export const COOLDOWN_MS = 30_000;

export type CacheResult<T> = { status: 200; body: T; stale: boolean } | { status: 502 | 503; error: string };

type Entry<T> = { at: number; body: T };
class Upstream extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503,
  ) {
    super(message);
  }
}

export function createPerplCache(fetchFn: typeof fetch = fetch, now: () => number = Date.now) {
  const entries = new Map<string, Entry<unknown>>();
  const inflight = new Map<string, Promise<CacheResult<unknown>>>();
  let recent: number[] = [];
  let cooldownUntil = 0;
  let upstreamCalls = 0;

  async function getJson(url: string): Promise<unknown> {
    const t = now();
    recent = recent.filter((at) => t - at < 60_000);
    if (t < cooldownUntil || recent.length >= UPSTREAM_PER_MIN) throw new Upstream("rate limited", 503);
    recent.push(t);
    upstreamCalls++;
    let r: Response;
    try {
      r = await fetchFn(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new Upstream("Perpl unreachable", 502);
    }
    if (r.status === 429) {
      cooldownUntil = now() + COOLDOWN_MS;
      throw new Upstream("rate limited", 503);
    }
    if (r.status === 503) throw new Upstream("Perpl not ready", 503);
    if (!r.ok) throw new Upstream(`Perpl ${r.status}`, 502);
    const body = await r.json().catch(() => undefined);
    if (body === undefined) throw new Upstream("Perpl returned an unexpected shape", 502);
    return body;
  }

  /** TTL cache + shared in-flight load; on failure, the last good copy within `staleMax`, else the error. */
  function cached<T>(key: string, ttl: number, staleMax: number, load: () => Promise<T>): Promise<CacheResult<T>> {
    const hit = entries.get(key) as Entry<T> | undefined;
    if (hit && now() - hit.at < ttl) return Promise.resolve({ status: 200, body: hit.body, stale: false });
    let p = inflight.get(key) as Promise<CacheResult<T>> | undefined;
    if (!p) {
      p = load()
        .then((body): CacheResult<T> => {
          entries.set(key, { at: now(), body });
          return { status: 200, body, stale: false };
        })
        .catch((e: unknown): CacheResult<T> => {
          const old = entries.get(key) as Entry<T> | undefined;
          if (old && now() - old.at <= staleMax) return { status: 200, body: old.body, stale: true };
          return e instanceof Upstream ? { status: e.status, error: e.message } : { status: 502, error: e instanceof Error ? e.message : "Perpl error" };
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p as Promise<CacheResult<unknown>>);
    }
    return p;
  }

  const market = () =>
    cached<PerplMarket>("context", CONTEXT_TTL_MS, 24 * 60 * 60_000, async () => {
      const m = resolvePerplMarket(await getJson(perplContextUrl()));
      if (!m) throw new Upstream("no single Perpl market named MON", 502);
      return m;
    });

  return {
    candles(res: PerplResolution): Promise<CacheResult<PerplCandlesPayload>> {
      return cached(`candles/${res}`, CANDLES_TTL_MS, CANDLES_STALE_MAX_MS, async () => {
        const m = await market();
        if (m.status !== 200) throw new Upstream(m.error, m.status);
        return { market: m.body, r: res, d: trimCandles(await getJson(perplCandlesUrl(m.body.id, res, now()))) };
      });
    },
    book(): Promise<CacheResult<PerplBookPayload>> {
      return cached("book", BOOK_TTL_MS, BOOK_STALE_MAX_MS, async () => {
        const m = await market();
        if (m.status !== 200) throw new Upstream(m.error, m.status);
        return { market: m.body, ...trimBook(await getJson(perplBookUrl(m.body.id))) };
      });
    },
    get upstreamCalls() {
      return upstreamCalls;
    },
  };
}
