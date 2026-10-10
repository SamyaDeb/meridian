// Rates & Risk alerts bot (K5 step 5). Reads positions through the app's own read route (/api/perpl/positions:
// onchain, cached, rate-limit aware) and Perpl's rate through /api/perpl/market; Meridian's rate from the MFI service.
// Pages through keepers/ts-fallback/src/paging.ts (one channel from env). Read-only: it holds no key.
//   ALERTS_WATCHLIST=./watchlist.json ALERTS_APP_URL=https://<app> [ALERTS_MFI_URL=https://<mfi>] \
//   PAGE_DISCORD_WEBHOOK_URL=… (or PAGE_TELEGRAM_BOT_TOKEN + PAGE_TELEGRAM_CHAT_ID) pnpm -C keepers/alerts start
// ONCE=1 → one cycle, then exit (cron / CI smoke).
import { DEFAULT_PAGER, channelFromEnv, deliver, newPagerState, planPages, type PagerState, type PostFn } from "@meridian/keeper-ts/src/paging.js";
import { evaluate, loadWatchList, pctToBps, positionReadings, spreadReading, type Reading, type WatchList } from "./watch.js";

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One cycle's readings; a failed read becomes an `alerts_read` warning, never a silent skip. */
export async function readAll(wl: WatchList, appUrl: string, mfiUrl: string | undefined, fetchFn: Fetch): Promise<Reading[]> {
  const out: Reading[] = [];
  const get = async (url: string) => {
    const r = await fetchFn(url);
    const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${r.status}`);
    return body ?? {};
  };
  for (const w of wl.wallets) {
    try {
      const body = await get(`${appUrl}/api/perpl/positions?chain=${w.chain}&address=${w.address}`);
      out.push(...positionReadings(w, body as { positions?: Record<string, unknown>[] }));
    } catch (e) {
      out.push({ kind: "error", code: `alerts_read:${w.chain}:${w.address.toLowerCase()}`, message: `can't read ${w.label ?? w.address} on Perpl: ${(e as Error).message}` });
    }
  }
  if (wl.spread && mfiUrl) {
    try {
      const [m, mfi] = await Promise.all([get(`${appUrl}/api/perpl/market?chain=${wl.spread.chain}`), get(`${mfiUrl}/v1/mfi`)]);
      const mer = (mfi.venues as { id: string; aprWad?: string }[] | undefined)?.find((v) => v.id === "meridian")?.aprWad;
      if (typeof mer !== "string") throw new Error("MFI has no Meridian rate");
      out.push(spreadReading(wl.spread, BigInt(mer), BigInt(String(m.fundingRatePct100k)), BigInt(Number(m.fundingIntervalSec))));
    } catch (e) {
      out.push({ kind: "error", code: `alerts_read:spread:${wl.spread.chain}`, message: `can't read the spread: ${(e as Error).message}` });
    }
  }
  return out;
}

export type Bot = { active: Set<string>; pager: PagerState };
export const newBot = (): Bot => ({ active: new Set(), pager: newPagerState() });

/** One cycle: read, evaluate with hysteresis, plan pages (cooldown = the watch list's), deliver. Returns what was sent. */
export async function cycle(bot: Bot, wl: WatchList, deps: { appUrl: string; mfiUrl?: string; fetch: Fetch; post: PostFn; nowSec: number; env: Record<string, string | undefined> }): Promise<string[]> {
  const readings = await readAll(wl, deps.appUrl, deps.mfiUrl, deps.fetch);
  const alerts = evaluate(bot.active, readings, pctToBps(wl.hysteresisPct));
  const cd = wl.cooldownMin * 60;
  const msgs = planPages(bot.pager, alerts, deps.nowSec, { ...DEFAULT_PAGER, repeatCriticalSec: cd, repeatWarnSec: cd }, "Meridian Rates & Risk");
  const ch = channelFromEnv(deps.env);
  for (const m of msgs) {
    const r = await deliver(ch, m, deps.post);
    if (!r.ok) console.error(`PAGE_FAILED ${r.detail}`);
  }
  return msgs;
}

async function main() {
  const env = process.env;
  const path = env.ALERTS_WATCHLIST;
  const appUrl = env.ALERTS_APP_URL?.replace(/\/$/, "");
  if (!path || !appUrl) throw new Error("set ALERTS_WATCHLIST (file path) and ALERTS_APP_URL (the Meridian app serving /api/perpl/*)");
  const wl = loadWatchList(path);
  const mfiUrl = env.ALERTS_MFI_URL?.replace(/\/$/, "") || undefined;
  const ch = channelFromEnv(env);
  console.log(`alerts: ${wl.wallets.length} wallets, spread ${wl.spread ? `${wl.spread.aprPct}% on ${wl.spread.chain}${mfiUrl ? "" : " (off: no ALERTS_MFI_URL)"}` : "off"}, paging via ${ch.kind}`);
  const post: PostFn = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const bot = newBot();
  const pollMs = Math.max(5, Number(env.ALERTS_POLL_SEC ?? 30)) * 1000;
  for (;;) {
    const sent = await cycle(bot, wl, { appUrl, ...(mfiUrl ? { mfiUrl } : {}), fetch, post, nowSec: Math.floor(Date.now() / 1000), env });
    for (const m of sent) console.log(`PAGED ${m.split("\n")[0]}`);
    if (env.ONCE === "1") return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
