// Server-side source for the labelled MON/USD reference chart (chart-liquidity prompt, task 4): GeckoTerminal's keyless
// OHLCV for one fixed pool (Uniswap v4 MON/USDC on Monad), cached per query for 60 s in this process so every viewer
// shares one upstream call per minute. No key. Off unless NEXT_PUBLIC_REFERENCE_CHART=1.
import { REFERENCE_ENABLED, parseReferenceQuery } from "@/features/chart/datafeed/reference";
import { CACHE_TTL_MS, createReferenceCache } from "@/features/chart/datafeed/referenceCache";

const cache = createReferenceCache();
const ttlSec = CACHE_TTL_MS / 1_000;

const json = (body: unknown, status: number, cacheSec = 0) =>
  Response.json(body, { status, headers: { "cache-control": cacheSec > 0 ? `public, s-maxage=${cacheSec}, stale-while-revalidate=${cacheSec}` : "no-store" } });

export async function GET(request: Request) {
  if (!REFERENCE_ENABLED) return json({ error: "reference chart disabled" }, 404);
  const q = parseReferenceQuery(new URL(request.url).searchParams);
  if (!q) return json({ error: "bad query" }, 400);
  const r = await cache.get(q);
  if (r.status !== 200) return json({ error: r.error }, r.status); // our own message, never the upstream body
  return json(r.body, 200, r.stale ? 0 : ttlSec);
}
