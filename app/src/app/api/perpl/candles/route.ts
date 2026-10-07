// Server-side source for the labelled "Perpl MON-PERP" chart source: Perpl's public candles for its MON perp (Monad
// mainnet), cached per resolution in this process (perplCache.ts). No key. Off unless NEXT_PUBLIC_PERPL_REFERENCE=1.
import { PERPL_ENABLED, parsePerplRes } from "@/features/chart/datafeed/perpl";
import { CANDLES_TTL_MS } from "@/features/chart/datafeed/perplCache";
import { json, perplCache } from "../cache";

export async function GET(request: Request) {
  if (!PERPL_ENABLED) return json({ error: "Perpl reference disabled" }, 404);
  const res = parsePerplRes(new URL(request.url).searchParams);
  if (res === null) return json({ error: "bad query" }, 400);
  const r = await perplCache.candles(res);
  if (r.status !== 200) return json({ error: r.error }, r.status); // our own message, never the upstream body
  return json(r.body, 200, r.stale ? 0 : CANDLES_TTL_MS / 1_000);
}
