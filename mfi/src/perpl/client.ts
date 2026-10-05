// Typed Perpl read client (public market data only): context, ticker, funding; plus the MFI venue read (docs/MFI.md §2–§5).
import { PerplSchemaError, PerplUnavailableError } from "./errors";
import type { PerplTransport } from "./transport";
import type { FundingEvent, Market, MarketState } from "./types";
import { parseContext, parseFundingSeries, parseMarketStateUpdate } from "./validate";
import { perplOiNotionalWad, perplRateToAprWad } from "./units";

export type PerplClientOptions = {
  transport: PerplTransport;
  /** per attempt; MFI.md §5 default 5 s */
  timeoutMs?: number;
  /** total attempts (1 = no retry); default 3 */
  attempts?: number;
  /** backoff base: base · 2^n + jitter; default 250 ms */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const RETRYABLE = (s: number) => s === 429 || s === 503 || s >= 500;

export function createPerplClient(opts: PerplClientOptions) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  async function get(path: string): Promise<unknown> {
    let last: PerplUnavailableError | undefined;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(Math.max(last?.retryAfterMs ?? 0, backoffMs * 2 ** (i - 1) + Math.floor(random() * backoffMs)));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await Promise.race([
          opts.transport(path, ctrl.signal),
          new Promise<never>((_, rej) => ctrl.signal.addEventListener("abort", () => rej(new PerplUnavailableError("timeout", `timeout after ${timeoutMs} ms: ${path}`)))),
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
        clearTimeout(timer);
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
    /** Resolve a market by symbol, never by a hard-coded id (MFI.md §1); see matchMarket. */
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
 * leaves `symbol` EMPTY and puts the asset in `name` (`name: "MON"`, id 10; BTC is listed the same way). So: an exact
 * `symbol` match wins; otherwise a market whose symbol is empty and whose `name` matches. More than one ⇒ none (never guess).
 */
export function matchMarket(markets: readonly Market[], symbol: string): Market | undefined {
  const want = symbol.toUpperCase();
  const bySymbol = markets.filter((x) => x.symbol.toUpperCase() === want);
  if (bySymbol.length > 0) return bySymbol.length === 1 ? bySymbol[0] : undefined;
  const byName = markets.filter((x) => x.symbol === "" && x.name.toUpperCase() === want);
  return byName.length === 1 ? byName[0] : undefined;
}

export type PerplVenueRead = {
  marketId: number;
  aprWad: bigint;
  rateMicros: number;
  fundingIntervalSec: number;
  fundingEventBlock: number;
  /** when the rate in force started to apply (`at.t`, ms) */
  fundingAtMs: number | undefined;
  oiNotionalWad: bigint;
  markWad: bigint;
  stateAtMs: number | undefined;
};

/** One MFI read of the Perpl venue: the funding rate in force now (window: 2 intervals back, 1 ahead) + current ticker (MFI.md §2, §3.2, §3.3). */
export async function readPerplVenue(client: PerplClient, market: Market, nowMs: number): Promise<PerplVenueRead> {
  const iv = market.funding_interval_sec * 1000;
  const [events, state] = await Promise.all([client.getFunding(market.id, nowMs - 2 * iv, nowMs + iv), client.getMarketState(market.id)]);
  // The newest event can apply up to ~1 min AHEAD of the head (types.md "FundingEvent"): use the one in force now.
  const inForce = events.filter((e) => e.at.t === undefined || e.at.t <= nowMs);
  const last = inForce.at(-1) ?? events[0];
  if (!last) throw new PerplUnavailableError("http", `market ${market.id} has no funding history`);
  const { price_decimals: pd, size_decimals: sd } = market.config;
  return {
    marketId: market.id,
    aprWad: perplRateToAprWad(last.rate, market.funding_interval_sec),
    rateMicros: last.rate,
    fundingIntervalSec: market.funding_interval_sec,
    fundingEventBlock: last.feb,
    fundingAtMs: last.at.t,
    oiNotionalWad: perplOiNotionalWad(state.oi, sd, state.mrk, pd),
    markWad: BigInt(state.mrk) * 10n ** BigInt(18 - pd),
    stateAtMs: state.at.t,
  };
}
