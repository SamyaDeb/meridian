// Server-side source for the read-only "Perpl" book tab: Perpl's public L2 snapshot of its MON perp (Monad mainnet),
// top PERPL_BOOK_LEVELS per side, cached a few seconds in this process (perplCache.ts). No key. Off unless
// NEXT_PUBLIC_PERPL_REFERENCE=1.
import { PERPL_ENABLED } from "@/features/chart/datafeed/perpl";
import { json, perplCache } from "../cache";

export async function GET() {
  if (!PERPL_ENABLED) return json({ error: "Perpl reference disabled" }, 404);
  const r = await perplCache.book();
  if (r.status !== 200) return json({ error: r.error }, r.status); // our own message, never the upstream body
  return json(r.body, 200);
}
