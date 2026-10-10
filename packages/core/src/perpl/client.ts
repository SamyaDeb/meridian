// Typed Perpl public read client (no auth): context, ticker, funding, L2 book. Transport injected.
// Ported from mfi/src/perpl/{client,transport}.ts (main @ 0ba1664) with the RN-safe changes: no AbortController
// (timeout races the transport via the injected clock), FetchLike instead of the DOM fetch type, + getBook.
import { realClock, type Clock, type FetchLike } from "../util/runtime";
import { MAX_CANDLES_PER_REQUEST, isCandleResolution, parseCandleSeries, type CandleSeries } from "./candles";
import { PerplSchemaError, PerplUnavailableError } from "./errors";
import type { FundingEvent, L2Book, Market, MarketState } from "./types";
import { parseContext, parseFundingSeries, parseL2Book, parseMarketStateUpdate } from "./validate";

// ── transport ──
export type TransportResponse = { status: number; body: unknown; retryAfterMs?: number };
export type PerplTransport = (path: string) => Promise<TransportResponse>;

/** Retry-After in whole seconds → ms (RFC 9110 delta-seconds; HTTP-date form ignored). */
export function retryAfterMs(h: string | null): number | undefined {
  return h && /^\d+$/.test(h) ? Number(h) * 1000 : undefined;
}

export function httpTransport(baseUrl: string, fetchFn: FetchLike): PerplTransport {
  const base = baseUrl.replace(/\/+$/, "");
  return async (path) => {
    const res = await fetchFn(`${base}${path}`, { method: "GET", headers: { accept: "application/json" } });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON body (e.g. an HTML error page): the client reports it as a schema/HTTP error
    }
    const ra = retryAfterMs(res.headers.get("retry-after"));
    return ra === undefined ? { status: res.status, body } : { status: res.status, body, retryAfterMs: ra };
  };
}

/** Fixture transport: path → response (or a function of the call count, to script retries). Unknown path ⇒ 404. */
export function fixtureTransport(routes: Record<string, TransportResponse | ((call: number) => TransportResponse)>): PerplTransport & { calls: string[] } {
  const calls: string[] = [];
  const t = async (path: string) => {
    calls.push(path);
    const r = routes[path];
    if (!r) return { status: 404, body: { error: "not found" } };
    return typeof r === "function" ? r(calls.filter((c) => c === path).length) : r;
  };
  return Object.assign(t, { calls });
}

// ── client ──
export type PerplClientOptions = {
  transport: PerplTransport;
  /** per attempt; default 5 s */
  timeoutMs?: number;
  /** total attempts (1 = no retry); default 3 */
  attempts?: number;
  /** backoff base: base · 2^n + jitter; default 250 ms */
  backoffMs?: number;
  clock?: Clock;
  /** retry sleep; default: the clock's timer */
  sleep?: (ms: number) => Promise<void>;
};

const RETRYABLE = (s: number) => s === 429 || s === 503 || s >= 500;

export function createPerplClient(opts: PerplClientOptions) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 250;
  const clock = opts.clock ?? realClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => void clock.setTimeout(r, ms)));

  async function get(path: string): Promise<unknown> {
    let last: PerplUnavailableError | undefined;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(Math.max(last?.retryAfterMs ?? 0, backoffMs * 2 ** (i - 1) + Math.floor(clock.random() * backoffMs)));
      let timer: unknown;
      try {
        const res = await Promise.race([
          opts.transport(path),
          new Promise<never>((_, rej) => {
            timer = clock.setTimeout(() => rej(new PerplUnavailableError("timeout", `timeout after ${timeoutMs} ms: ${path}`)), timeoutMs);
          }),
        ]);
        if (res.status >= 200 && res.status < 300) return res.body;
        const kind = res.status === 429 ? "rate-limited" : res.status === 503 ? "not-ready" : res.status === 400 ? "unknown-market" : "http";
        last = new PerplUnavailableError(kind, `HTTP ${res.status}: ${path}`, res.status, res.retryAfterMs);
        if (!RETRYABLE(res.status)) throw last;
      } catch (e) {
        if (e instanceof PerplUnavailableError) {
          last = e;
          if (e.status !== undefined && !RETRYABLE(e.status)) throw e;
        } else last = new PerplUnavailableError("network", `${e instanceof Error ? e.message : String(e)}: ${path}`);
      } finally {
        clock.clearTimeout(timer);
      }
    }
    throw last ?? new PerplUnavailableError("network", `no response: ${path}`);
  }

  const client = {
    /** GET /v1/pub/context */
    getContext: async () => parseContext(await get("/v1/pub/context")),
    /** GET /v1/market-data/:id/ticker → that market's state. 400 = unknown market, 503 = not ready (retried). */
    getMarketState: async (marketId: number): Promise<MarketState> => {
      const u = parseMarketStateUpdate(await get(`/v1/market-data/${marketId}/ticker`));
      const s = u.d[String(marketId)];
      if (!s) throw new PerplSchemaError(`ticker.d.${marketId}`, "market missing from its own ticker");
      return s;
    },
    /** GET /v1/market-data/:id/funding/:from-:to (ms, inclusive), oldest first, deduplicated by `feb` (last wins). */
    getFunding: async (marketId: number, fromMs: number, toMs: number): Promise<FundingEvent[]> => {
      if (!(Number.isSafeInteger(fromMs) && Number.isSafeInteger(toMs) && fromMs <= toMs)) throw new RangeError("bad funding window");
      const s = parseFundingSeries(await get(`/v1/market-data/${marketId}/funding/${fromMs}-${toMs}`));
      if (s.m !== marketId) throw new PerplSchemaError("fundingSeries.m", `expected market ${marketId}, got ${s.m}`);
      const byFeb = new Map<number, FundingEvent>();
      for (const e of s.d) byFeb.set(e.feb, e);
      return [...byFeb.values()].sort((a, b) => a.feb - b.feb);
    },
    /** GET /v1/market-data/:id/book?levels=n (rest-endpoints.md: 1–100, outside ⇒ 400, not clamped). */
    getBook: async (marketId: number, levels = 100): Promise<L2Book> => {
      if (!Number.isInteger(levels) || levels < 1 || levels > 100) throw new RangeError("levels must be 1–100");
      const b = parseL2Book(await get(`/v1/market-data/${marketId}/book?levels=${levels}`));
      if (b.mt !== 15) throw new PerplSchemaError("book.mt", "REST book must be a snapshot (15)");
      return b;
    },
    /** GET /v1/market-data/:id/candles/:resolution/:from-:to (resolution s, from/to ms, ≤ 1024 candles), oldest first. */
    getCandles: async (marketId: number, resolutionSec: number, fromMs: number, toMs: number): Promise<CandleSeries> => {
      if (!isCandleResolution(resolutionSec)) throw new RangeError(`unsupported candle resolution ${resolutionSec}s`);
      if (!(Number.isSafeInteger(fromMs) && Number.isSafeInteger(toMs) && fromMs <= toMs)) throw new RangeError("bad candle window");
      if (Math.floor((toMs - fromMs) / (resolutionSec * 1000)) + 1 > MAX_CANDLES_PER_REQUEST) throw new RangeError(`window spans more than ${MAX_CANDLES_PER_REQUEST} candles`);
      const s = parseCandleSeries(await get(`/v1/market-data/${marketId}/candles/${resolutionSec}/${fromMs}-${toMs}`));
      if (s.r !== resolutionSec) throw new PerplSchemaError("candles.r", `expected resolution ${resolutionSec}, got ${s.r}`);
      return s;
    },
    /** Resolve a market by symbol, never by a hard-coded id; see matchMarket. */
    findMarket: async (symbol: string): Promise<Market> => {
      const m = matchMarket((await client.getContext()).markets, symbol);
      if (!m) throw new PerplUnavailableError("unknown-market", `no Perpl market with symbol ${symbol}`);
      return m;
    },
  };
  return client;
}

export type PerplClient = ReturnType<typeof createPerplClient>;

/**
 * Market by symbol (case-insensitive). Recorded 5 Oct 2026: testnet lists MON as `symbol: "MON"` (id 64), but mainnet
 * leaves `symbol` EMPTY and puts the asset in `name` (`name: "MON"`, id 10). So: an exact `symbol` match wins; otherwise
 * a market whose symbol is empty and whose `name` matches. More than one ⇒ none (never guess).
 */
export function matchMarket(markets: readonly Market[], symbol: string): Market | undefined {
  const want = symbol.toUpperCase();
  const bySymbol = markets.filter((x) => x.symbol.toUpperCase() === want);
  if (bySymbol.length > 0) return bySymbol.length === 1 ? bySymbol[0] : undefined;
  const byName = markets.filter((x) => x.symbol === "" && x.name.toUpperCase() === want);
  return byName.length === 1 ? byName[0] : undefined;
}

/** The funding event in force at `nowMs` (the newest can apply up to ~1 min AHEAD of the head, types.md "FundingEvent"). */
export function fundingInForce(events: readonly FundingEvent[], nowMs: number): FundingEvent | undefined {
  const inForce = events.filter((e) => e.at.t === undefined || e.at.t <= nowMs);
  return inForce.at(-1) ?? events[0];
}
