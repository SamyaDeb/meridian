// Server-side source for the trade chart's candles: Perpl's public candles for its MON perp (Monad mainnet), cached per
// resolution in this process (perplCache.ts). `tail=1` returns only the newest few buckets on a 2 s cache, so the
// forming candle moves live. No key. Off unless NEXT_PUBLIC_PERPL_REFERENCE=1.
import { PERPL_ENABLED, parsePerplRes, parsePerplTail } from "@/features/chart/datafeed/perpl";
import { CANDLES_TAIL_TTL_MS, CANDLES_TTL_MS } from "@/features/chart/datafeed/perplCache";
import { json, perplCache } from "../cache";

export async function GET(request: Request) {
  if (!PERPL_ENABLED) return json({ error: "Perpl reference disabled" }, 404);
  const search = new URL(request.url).searchParams;
  const res = parsePerplRes(search);
  if (res === null) return json({ error: "bad query" }, 400);
  const tail = parsePerplTail(search);
  const r = await perplCache.candles(res, tail);
  if (r.status !== 200) return json({ error: r.error }, r.status); // our own message, never the upstream body
  return json(r.body, 200, r.stale ? 0 : Math.max(1, Math.floor((tail ? CANDLES_TAIL_TTL_MS : CANDLES_TTL_MS) / 1_000)));
}
