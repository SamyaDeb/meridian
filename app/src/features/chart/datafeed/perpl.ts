// Labelled outside venue: Perpl's MON perpetual on Monad mainnet (an onchain order book), read through Perpl's public,
// unauthenticated market-data REST API by our server routes (app/api/perpl/*). Shown only as a reference: its own chart
// source and a read-only book tab, never mixed into Meridian's trades, mark, index or book, and never tradeable here.
// Pure parsing + query mapping, unit-tested. Off unless NEXT_PUBLIC_PERPL_REFERENCE=1.
import type { DepthLevel } from "@/data/types";
import { aggregate } from "./candles";
import { ALIGN_OFFSET_SEC, TIMEFRAME_SEC, type Bar, type Timeframe } from "./types";

/** `NEXT_PUBLIC_PERPL_REFERENCE=1` shows the Perpl chart source and book tab; anything else hides both. */
export const PERPL_ENABLED = process.env.NEXT_PUBLIC_PERPL_REFERENCE === "1";

/**
 * Perpl mainnet REST base (github.com/PerplFoundation/api-docs README "Network Configuration", read 7 Oct 2026). The
 * candles, book and context endpoints need no authentication (rest-endpoints.md). REST limits "are not published …
 * treat HTTP 429 as the signal" (README "Rate Limits"), so the routes cache and back off (perplCache.ts).
 */
export const PERPL_API = "https://app.perpl.xyz/api";
/** Resolved by name from `/v1/pub/context`, never by a hard-coded id (7 Oct 2026: id 10, symbol "", name "MON"). */
export const PERPL_MARKET = "MON";
/** Shown wherever Perpl data is drawn. */
export const PERPL_VENUE = "Perpl MON-PERP · Monad mainnet";
export const PERPL_APP_URL = "https://app.perpl.xyz";

/** Candle resolutions the endpoint accepts (rest-endpoints.md "Supported Resolutions"; 120 s ⇒ 400, checked 7 Oct). */
export const PERPL_RESOLUTIONS = [60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200, 86_400] as const;
export type PerplResolution = (typeof PERPL_RESOLUTIONS)[number];
/** Candles per request: documented max 1024 (1025 ⇒ 400, checked 7 Oct); a margin for the inclusive window edges. */
export const PERPL_MAX_CANDLES = 1_000;
/** Book levels per side we ask for (the endpoint serves 1–100). */
export const PERPL_BOOK_LEVELS = 20;

/** Finest upstream resolution that divides each timeframe; 3m, 6h and 1W are aggregated here. */
export const PERPL_RES_OF: Record<Timeframe, PerplResolution> = {
  "1m": 60,
  "3m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1_800,
  "1h": 3_600,
  "2h": 7_200,
  "4h": 14_400,
  "6h": 7_200,
  "12h": 43_200,
  "1D": 86_400,
  "1W": 86_400,
};

export type PerplMarket = { id: number; name: string; priceDecimals: number; sizeDecimals: number };

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
const decimalsOk = (d: unknown): d is number => isInt(d) && d >= 0 && d <= 18;

/**
 * Pure: picks the market from `/v1/pub/context` the way Perpl names it: an exact `symbol` match wins, else a market
 * whose symbol is empty and whose `name` matches. No match, more than one, or bad decimals ⇒ undefined (never guess).
 */
export function resolvePerplMarket(context: unknown, name = PERPL_MARKET): PerplMarket | undefined {
  const markets = (context as { markets?: unknown } | null)?.markets;
  if (!Array.isArray(markets)) return undefined;
  type Raw = { id?: unknown; symbol?: unknown; name?: unknown; config?: { price_decimals?: unknown; size_decimals?: unknown } };
  const want = name.toUpperCase();
  const all = markets as Raw[];
  const bySymbol = all.filter((m) => typeof m?.symbol === "string" && m.symbol.toUpperCase() === want);
  const byName = all.filter((m) => m?.symbol === "" && typeof m?.name === "string" && m.name.toUpperCase() === want);
  const hits = bySymbol.length > 0 ? bySymbol : byName;
  if (hits.length !== 1) return undefined;
  const m = hits[0]!;
  const pd = m.config?.price_decimals;
  const sd = m.config?.size_decimals;
  if (!isInt(m.id) || !decimalsOk(pd) || !decimalsOk(sd)) return undefined;
  return { id: m.id, name: String(m.name), priceDecimals: pd, sizeDecimals: sd };
}

/** Scaled integer at `decimals` → WAD, exact (Perpl prices and sizes are integers scaled by the market's decimals). */
export const scaledToWad = (x: number, decimals: number): bigint => BigInt(x) * 10n ** BigInt(18 - decimals);

// ── Payloads our routes send to the browser (only these fields, never the upstream body as such) ──────────────────
export type PerplCandleRow = { t: number; o: number; h: number; l: number; c: number };
export type PerplCandlesPayload = { market: PerplMarket; r: PerplResolution; d: PerplCandleRow[] };
export type PerplLevelRow = { p: number; s: number; o: number };
export type PerplBookPayload = { market: PerplMarket; block: number; timeMs: number; bid: PerplLevelRow[]; ask: PerplLevelRow[] };

/** Pure: Perpl `CandleSeries` → our trimmed rows. Missing `d` ⇒ throws; rows with non-integer / non-positive prices or h < l are dropped. */
export function trimCandles(json: unknown): PerplCandleRow[] {
  const d = (json as { d?: unknown } | null)?.d;
  if (!Array.isArray(d)) throw new Error("Perpl candles: missing d");
  const out: PerplCandleRow[] = [];
  for (const x of d as Record<string, unknown>[]) {
    const { t, o, h, l, c } = x ?? {};
    if (![t, o, h, l, c].every(isInt)) continue;
    const r = { t, o, h, l, c } as PerplCandleRow;
    if (r.t <= 0 || Math.min(r.o, r.h, r.l, r.c) <= 0 || r.h < r.l) continue;
    out.push(r);
  }
  return out;
}

/** Pure: Perpl `L2Book` → our trimmed snapshot. Missing sides or block ⇒ throws; malformed levels are dropped. */
export function trimBook(json: unknown): { block: number; timeMs: number; bid: PerplLevelRow[]; ask: PerplLevelRow[] } {
  const b = json as { sn?: unknown; at?: { t?: unknown }; bid?: unknown; ask?: unknown } | null;
  if (!b || !isInt(b.sn) || !Array.isArray(b.bid) || !Array.isArray(b.ask)) throw new Error("Perpl book: unexpected shape");
  const side = (xs: unknown[]) =>
    xs.flatMap((x) => {
      const { p, s, o } = (x ?? {}) as Record<string, unknown>;
      return isInt(p) && isInt(s) && p > 0 && s > 0 ? [{ p, s, o: isInt(o) ? o : 0 }] : [];
    });
  return { block: b.sn, timeMs: isInt(b.at?.t) ? b.at.t : 0, bid: side(b.bid), ask: side(b.ask) };
}

/**
 * Pure: our candles payload → Bar[] in `tf` buckets, ascending (upstream `t` is ms). Duplicate times keep the last row,
 * empty buckets between real ones are carried forward and flagged `gapFill`. Volume is always 0: another venue's volume
 * is not Meridian's and is never drawn.
 */
export function perplToBars(payload: PerplCandlesPayload, tf: Timeframe): Bar[] {
  const pd = payload.market.priceDecimals;
  const byTime = new Map<number, Bar>();
  for (const r of [...payload.d].sort((a, b) => a.t - b.t)) {
    const time = Math.floor(r.t / 1_000);
    byTime.set(time, { time, open: scaledToWad(r.o, pd), high: scaledToWad(r.h, pd), low: scaledToWad(r.l, pd), close: scaledToWad(r.c, pd), volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0 });
  }
  return aggregate([...byTime.values()], TIMEFRAME_SEC[tf], true, ALIGN_OFFSET_SEC[tf] ?? 0);
}

/** Pure: our book payload → best-first DepthLevel sides in WAD (bids descending, asks ascending; upstream order is not trusted). */
export function perplToDepth(payload: PerplBookPayload): { bids: DepthLevel[]; asks: DepthLevel[] } {
  const { priceDecimals: pd, sizeDecimals: sd } = payload.market;
  const lv = (r: PerplLevelRow): DepthLevel => ({ priceWad: scaledToWad(r.p, pd), sizeWad: scaledToWad(r.s, sd) });
  const bids = payload.bid.map(lv).sort((a, b) => (a.priceWad > b.priceWad ? -1 : a.priceWad < b.priceWad ? 1 : 0));
  const asks = payload.ask.map(lv).sort((a, b) => (a.priceWad < b.priceWad ? -1 : a.priceWad > b.priceWad ? 1 : 0));
  return { bids, asks };
}

// ── Server side ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Pure: the candles route's `res` query, allow-listed, or null. */
export function parsePerplRes(search: URLSearchParams): PerplResolution | null {
  const r = Number(search.get("res"));
  return (PERPL_RESOLUTIONS as readonly number[]).includes(r) ? (r as PerplResolution) : null;
}

/** Fixed base + market + bounded window (`PERPL_MAX_CANDLES` buckets back from `nowMs`): the routes are not a general proxy. */
export const perplContextUrl = () => `${PERPL_API}/v1/pub/context`;
export const perplCandlesUrl = (marketId: number, res: PerplResolution, nowMs: number) => `${PERPL_API}/v1/market-data/${marketId}/candles/${res}/${nowMs - res * 1_000 * PERPL_MAX_CANDLES}-${nowMs}`;
export const perplBookUrl = (marketId: number) => `${PERPL_API}/v1/market-data/${marketId}/book?levels=${PERPL_BOOK_LEVELS}`;
