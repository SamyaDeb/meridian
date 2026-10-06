// Server-only cache in front of GeckoTerminal's keyless OHLCV (used by app/api/reference-candles). The keyless budget
// (~10 calls/min, see GECKO_BASE) is shared by every viewer of one server, so each allow-listed query is fetched at most
// once per TTL, concurrent misses share one fetch, the whole server stays within UPSTREAM_PER_MIN, a 429 pauses every
// upstream call for COOLDOWN_MS, and a 429, the budget or an outage serves the last good copy instead.
import { upstreamUrl, type GeckoQuery } from "./reference";

export const CACHE_TTL_MS = 60_000;
export const STALE_MAX_MS = 15 * 60_000; // an older copy is no longer a fair "reference": report unavailable instead
export const MAX_ENTRIES = 12; // the allow-list has 7 queries; the cap is a backstop
/** Upstream calls per rolling minute for the whole server (keyless "~10 calls/min"; a 429 was seen at the 9th). */
export const UPSTREAM_PER_MIN = 6;
export const COOLDOWN_MS = 60_000; // after a 429 nothing goes upstream for this long

/** Only the candle rows go back to the browser: never the upstream body as such (meta, errors, anything it quotes). */
export type ReferencePayload = { data: { attributes: { ohlcv_list: unknown[] } } };
export type ReferenceResult = { status: 200; body: ReferencePayload; stale: boolean } | { status: 502 | 503; error: string };

type Entry = { at: number; body: ReferencePayload };

export function createReferenceCache(fetchFn: typeof fetch = fetch, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<ReferenceResult>>();
  let upstreamCalls = 0;
  let recent: number[] = []; // upstream call times within the last minute
  let cooldownUntil = 0;

  const fromCache = (key: string, error: string, status: 502 | 503): ReferenceResult => {
    const e = entries.get(key);
    return e && now() - e.at <= STALE_MAX_MS ? { status: 200, body: e.body, stale: true } : { status, error };
  };

  async function load(key: string, q: GeckoQuery): Promise<ReferenceResult> {
    const t = now();
    recent = recent.filter((at) => t - at < 60_000);
    if (t < cooldownUntil || recent.length >= UPSTREAM_PER_MIN) return fromCache(key, "rate limited", 503);
    recent.push(t);
    upstreamCalls++;
    console.info(`[reference-candles] upstream ${key} (#${upstreamCalls})`); // counted in the dev log against the keyless limit
    let r: Response;
    try {
      r = await fetchFn(upstreamUrl(q), { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    } catch {
      return fromCache(key, "upstream unreachable", 502);
    }
    if (r.status === 429) {
      cooldownUntil = now() + COOLDOWN_MS;
      return fromCache(key, "rate limited", 503);
    }
    if (!r.ok) return fromCache(key, `upstream ${r.status}`, 502);
    const list = ((await r.json().catch(() => null)) as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return fromCache(key, "upstream returned an unexpected shape", 502);
    const body: ReferencePayload = { data: { attributes: { ohlcv_list: list } } };
    entries.delete(key); // re-insert: Map order = age, so the first key is the oldest
    entries.set(key, { at: now(), body });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    return { status: 200, body, stale: false };
  }

  return {
    async get(q: GeckoQuery): Promise<ReferenceResult> {
      const key = `${q.timeframe}/${q.aggregate}`;
      const hit = entries.get(key);
      if (hit && now() - hit.at < CACHE_TTL_MS) return { status: 200, body: hit.body, stale: false };
      let p = inflight.get(key);
      if (!p) {
        p = load(key, q).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return p;
    },
    get upstreamCalls() {
      return upstreamCalls;
    },
  };
}
