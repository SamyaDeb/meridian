// One Perpl cache per server process, shared by the candles and book routes (one upstream budget, one market lookup).
import { createPerplCache } from "@/features/chart/datafeed/perplCache";

export const perplCache = createPerplCache();

export const json = (body: unknown, status: number, cacheSec = 0) =>
  Response.json(body, { status, headers: { "cache-control": cacheSec > 0 ? `public, s-maxage=${cacheSec}, stale-while-revalidate=${cacheSec}` : "no-store" } });
