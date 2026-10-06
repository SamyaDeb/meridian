// Outside MON/USD reference candles (chart-liquidity prompt, task 4): GeckoTerminal's keyless OHLCV for the largest
// MON/USDC pool on Monad mainnet (Uniswap v4), fetched server-side by app/api/reference-candles and cached there (the
// keyless limit is shared by every viewer of one server). A clearly labelled, opt-in view: never the default source and
// never mixed into Last / Mark / Index. Pure parsing + timeframe mapping, unit-tested.
import { aggregate } from "./candles";
import { ALIGN_OFFSET_SEC, TIMEFRAME_SEC, type Bar, type Timeframe } from "./types";

/** `NEXT_PUBLIC_REFERENCE_CHART=1` shows the source in the toolbar; anything else hides it (and a saved choice falls back to Last). */
export const REFERENCE_ENABLED = process.env.NEXT_PUBLIC_REFERENCE_CHART === "1";

/**
 * Keyless GeckoTerminal base (docs.coingecko.com/docs/keyless-public-api, read 6 Oct 2026): "GeckoTerminal endpoints:
 * ~10 calls/min" and "not suitable for production workloads, scheduled polling, or high-frequency updates". Observed
 * 6 Oct: a 429 on the 9th call at 7 s spacing, so the route caches per query and serves its copy on 429.
 * > VERIFY: GeckoTerminal / CoinGecko attribution terms for the keyless API (not on that page); the UI says "via GeckoTerminal".
 */
export const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
/** GeckoTerminal network id for Monad mainnet (`/networks/monad/pools`, read 6 Oct 2026). */
export const REFERENCE_NETWORK = "monad";
/**
 * "MON / USDC 0.05%" on dex `uniswap-v4-monad`: the largest MON/USD-type pool listed on `/networks/monad/pools?page=1`
 * (6 Oct 2026: reserve ≈ $1.16M, 24 h volume ≈ $5.55M). A Uniswap v4 bytes32 pool id, used as GeckoTerminal gives it.
 */
export const REFERENCE_POOL = "0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954";
/** Rows per request: the documented max (docs.coingecko.com/reference/pool-ohlcv-contract-address), 1000 returned keyless on 6 Oct. */
export const REFERENCE_LIMIT = 1_000;

export type GeckoTimeframe = "minute" | "hour" | "day";
export type GeckoQuery = { timeframe: GeckoTimeframe; aggregate: number };
/** Pairs the OHLCV route accepts (documented for the Pro endpoint; each checked keyless on 6 Oct, `minute/3` ⇒ 400). */
export const GECKO_QUERIES: readonly GeckoQuery[] = [
  { timeframe: "minute", aggregate: 1 },
  { timeframe: "minute", aggregate: 5 },
  { timeframe: "minute", aggregate: 15 },
  { timeframe: "hour", aggregate: 1 },
  { timeframe: "hour", aggregate: 4 },
  { timeframe: "hour", aggregate: 12 },
  { timeframe: "day", aggregate: 1 },
];

/** Finest upstream bucket that divides each timeframe; 3m, 30m, 2h, 6h and 1W are aggregated here. */
export const UPSTREAM_OF: Record<Timeframe, GeckoQuery> = {
  "1m": { timeframe: "minute", aggregate: 1 },
  "3m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "15m": { timeframe: "minute", aggregate: 15 },
  "30m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "2h": { timeframe: "hour", aggregate: 1 },
  "4h": { timeframe: "hour", aggregate: 4 },
  "6h": { timeframe: "hour", aggregate: 1 },
  "12h": { timeframe: "hour", aggregate: 12 },
  "1D": { timeframe: "day", aggregate: 1 },
  "1W": { timeframe: "day", aggregate: 1 },
};

/** USD float → WAD bigint at 1e-9 precision (MON ≈ $0.03: 9 significant decimals are below the display's 6). */
const toWad = (x: number): bigint => BigInt(Math.round(x * 1e9)) * 1_000_000_000n;

/**
 * Pure: GeckoTerminal OHLCV JSON (`data.attributes.ohlcv_list` = `[[unixSec, o, h, l, c, volumeUsd], …]`, newest first)
 * → Bar[] in `tf` buckets, ascending. Missing or garbled shape ⇒ throws (shown as "Reference unavailable", never a
 * made-up series); an empty list ⇒ []. Rows with a non-finite / non-positive price or high < low are dropped. Duplicate
 * times keep the last row. Empty buckets between real ones are carried forward and flagged `gapFill`. Volume is always
 * 0: an outside venue's volume is not Meridian's and is never drawn.
 */
export function geckoToBars(json: unknown, tf: Timeframe): Bar[] {
  const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error("reference history: missing ohlcv_list");
  const rows: [number, number, number, number, number][] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [t, o, h, l, c] = row.slice(0, 5).map(Number) as [number, number, number, number, number];
    if (![t, o, h, l, c].every(Number.isFinite) || t <= 0 || Math.min(o, h, l, c) <= 0 || h < l) continue;
    rows.push([Math.floor(t), o, h, l, c]);
  }
  rows.sort((a, b) => a[0] - b[0]); // stable: of equal times, the later row in the response wins below
  const byTime = new Map<number, Bar>();
  for (const [t, o, h, l, c] of rows) byTime.set(t, { time: t, open: toWad(o), high: toWad(h), low: toWad(l), close: toWad(c), volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0 });
  return aggregate([...byTime.values()], TIMEFRAME_SEC[tf], true, ALIGN_OFFSET_SEC[tf] ?? 0);
}

// ── Server side (app/api/reference-candles/route.ts) ────────────────────────────────────────────────────────────────
/** Pure: validates the route's query (an allow-listed timeframe + aggregate pair only) or returns null. */
export function parseReferenceQuery(search: URLSearchParams): GeckoQuery | null {
  const timeframe = search.get("timeframe");
  const agg = search.get("aggregate");
  return GECKO_QUERIES.find((q) => q.timeframe === timeframe && String(q.aggregate) === agg) ?? null;
}

/** Fixed network + pool: the route is not a general GeckoTerminal proxy. */
export function upstreamUrl(q: GeckoQuery): string {
  const p = new URLSearchParams({ aggregate: String(q.aggregate), limit: String(REFERENCE_LIMIT) });
  return `${GECKO_BASE}/networks/${REFERENCE_NETWORK}/pools/${REFERENCE_POOL}/ohlcv/${q.timeframe}?${p}`;
}
