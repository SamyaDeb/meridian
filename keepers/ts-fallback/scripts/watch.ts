// Monitoring watcher (TEAM_PLAN §7 + Phase 5 B6): polls keeper /health endpoints and chain views, prints one
// `ALERT <severity> <code> <message>` line per finding (rules: src/alerts.ts), `OK …` when clean, and pages them
// (src/paging.ts: de-duplicated, reminders, RESOLVED, rate-limited) to ONE channel from .env (RUNBOOK §8).
//   CHAIN_ID=10143 RPC_URL=… DEPLOYMENTS=../../deployments/10143.json KEEPER_HEALTH=http://localhost:8797/health \
//   WATCH_BALANCES=keeper=0x…:20,mm=0x…:10 WATCH_MM=perp=0x…,swap=0x… [CHAINLINK_AUSD_USD=0x…] \
//   [CHAINLINK_MON_USD=0x…] [PAGE_DISCORD_WEBHOOK_URL=… | PAGE_TELEGRAM_BOT_TOKEN=… PAGE_TELEGRAM_CHAT_ID=…] \
//   [PAGE_LABEL="Pulse 143"] [INTERVAL_SEC=15] [ONCE=1] pnpm watch
// WATCH_BALANCES: label=address[:minMON] (floor per wallet; default 5 MON). WATCH_MM: book=address with book "perp"
// (deployments OrderBook) or "swap" (SwapOrderBook): alert when that MM has had 0 open orders for > 60 s.
// ONCE=1 checks once and exits 2 on any critical alert (for cron / CI). INDEXER_LAG_URL (optional) must return JSON
// {"lagSec": n}; > VERIFY the Envio/Hasura endpoint that exposes the latest processed block before wiring it.
import { readFileSync } from "node:fs";
import { type Address, createPublicClient, http } from "viem";
import {
  aggregatorAbi,
  clearingHouseAbi,
  fundingSwapImplAbi,
  fundingSwapWatchAbi,
  insuranceFundAbi,
  oracleAdapterAbi,
  orderBookWatchAbi,
  pulseVaultAbi,
} from "../src/abi.js";
import { type Alert, type Snapshot, TEAM_PLAN_THRESHOLDS, emptySince, evaluateAlerts, ifBaseline } from "../src/alerts.js";
import { DEFAULT_PAGER, channelFromEnv, deliver, newPagerState, planPages } from "../src/paging.js";

const env = (k: string): string | undefined => (process.env[k] === "" ? undefined : process.env[k]);
const need = (k: string): string => env(k) ?? (() => { throw new Error(`missing env ${k}`); })();
const dep = JSON.parse(readFileSync(need("DEPLOYMENTS"), "utf8")) as { chainId: number; contracts: Record<string, Address | undefined> };
if (dep.chainId !== Number(need("CHAIN_ID"))) throw new Error("deployments chainId mismatch");
const pub = createPublicClient({ transport: http(need("RPC_URL"), { timeout: 5_000 }) });
const C = dep.contracts;
const health = (env("KEEPER_HEALTH") ?? "").split(",").filter(Boolean);
const balances = (env("WATCH_BALANCES") ?? "").split(",").filter(Boolean).map((kv) => {
  const [label, rest] = kv.split("=");
  const [addr, minMon] = (rest ?? "").split(":");
  return { label: label ?? "?", addr: addr as Address, ...(minMon ? { minWei: BigInt(Math.round(Number(minMon) * 1e6)) * 10n ** 12n } : {}) };
});
const mms = (env("WATCH_MM") ?? "").split(",").filter(Boolean).map((kv) => {
  const [book, addr] = kv.split("=");
  const ob = book === "swap" ? C.SwapOrderBook : C.OrderBook;
  if (ob === undefined) throw new Error(`WATCH_MM: no ${book === "swap" ? "SwapOrderBook" : "OrderBook"} in the deployment`);
  return { label: `mm-${book}`, addr: addr as Address, ob };
});
const mmEmpty = new Map<string, bigint | null>();
const AUSD_FEED = env("CHAINLINK_AUSD_USD") as Address | undefined;
const GUARD_FEED = env("CHAINLINK_MON_USD") as Address | undefined;
const channel = channelFromEnv(process.env);
const pager = newPagerState();
const LABEL = env("PAGE_LABEL") ?? `Pulse ${dep.chainId}`;
let vaultPeak: bigint | null = null;
const ONCE = env("ONCE") === "1";
const INTERVAL = Number(env("INTERVAL_SEC") ?? "15") * 1000;
let ifPeak: bigint | null = null;

const opt = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

async function snapshot(): Promise<Snapshot> {
  const blk = await pub.getBlock({ blockTag: "latest" });
  const [oracle, fs, ifBal, hedge, bals, hs, lag] = await Promise.all([
    C.OracleAdapter ? opt(pub.readContract({ address: C.OracleAdapter, abi: oracleAdapterAbi, functionName: "tryGetIndexPrice" })) : null,
    C.ClearingHouse ? opt(pub.readContract({ address: C.ClearingHouse, abi: clearingHouseAbi, functionName: "fundingState" })) : null,
    C.InsuranceFund ? opt(pub.readContract({ address: C.InsuranceFund, abi: insuranceFundAbi, functionName: "balance" })) : null,
    C.PulseVault ? opt(pub.readContract({ address: C.PulseVault, abi: pulseVaultAbi, functionName: "hedgeState" })) : null,
    Promise.all(balances.map(async (b) => ({ label: b.label, wei: await pub.getBalance({ address: b.addr }), ...(b.minWei !== undefined ? { minWei: b.minWei } : {}) }))),
    Promise.all(
      health.map(async (url) => {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
          const j = (await r.json()) as { ok?: boolean; errors?: number };
          return { url, ok: j.ok === true, ...(j.errors !== undefined ? { errors: j.errors } : {}) };
        } catch {
          return { url, ok: null };
        }
      }),
    ),
    env("INDEXER_LAG_URL") ? opt(fetch(env("INDEXER_LAG_URL")!).then((r) => r.json() as Promise<{ lagSec: number }>)) : null,
  ]);
  const [ausd, guard, mmCounts, swap, share] = await Promise.all([
    AUSD_FEED ? opt(pub.readContract({ address: AUSD_FEED, abi: aggregatorAbi, functionName: "latestRoundData" })) : null,
    GUARD_FEED ? opt(pub.readContract({ address: GUARD_FEED, abi: aggregatorAbi, functionName: "latestRoundData" })) : null,
    Promise.all(mms.map((m) => opt(pub.readContract({ address: m.ob, abi: orderBookWatchAbi, functionName: "openOrderCount", args: [m.addr] })))),
    C.FundingSwapMarket
      ? opt(
          Promise.all([
            pub.readContract({ address: C.FundingSwapMarket, abi: fundingSwapWatchAbi, functionName: "maturity" }),
            pub.readContract({ address: C.FundingSwapMarket, abi: fundingSwapImplAbi, functionName: "maturitySnapshot" }),
            pub.readContract({ address: C.FundingSwapMarket, abi: fundingSwapWatchAbi, functionName: "openInterest" }),
          ]),
        )
      : null,
    C.PulseVault ? opt(pub.readContract({ address: C.PulseVault, abi: pulseVaultAbi, functionName: "sharePrice" })) : null,
  ]);
  const mmBooks = mms.map((m, i) => {
    const n = mmCounts[i];
    // an unreadable count doesn't start or clear the timer
    const since = n === null || n === undefined ? (mmEmpty.get(m.label) ?? null) : emptySince(mmEmpty.get(m.label) ?? null, n === 0n, blk.timestamp);
    mmEmpty.set(m.label, since);
    return { label: m.label, emptyForSec: since === null ? 0n : blk.timestamp - since };
  });
  return {
    nowSec: blk.timestamp,
    headBlock: blk.number,
    oracle: oracle ? { ok: oracle[0], updatedAt: oracle[2] } : null,
    lastFundingBlock: fs ? fs.lastUpdateBlock : null,
    insuranceFundToken: ifBal,
    vault: hedge ? { hedged: hedge.hedged, marginRatioWad: hedge.marginRatio } : null,
    keeperBalances: bals,
    keeperHealth: hs,
    indexerLagSec: lag ? lag.lagSec : null,
    ausdUsd: ausd ? { price8: ausd[1], updatedAt: ausd[3] } : null,
    secondaryFeed: guard ? { updatedAt: guard[3] } : null,
    mmBooks,
    swap: swap ? { maturity: swap[0], snapped: swap[1][0], longOI: swap[2][0] } : null,
    vaultSharePrice: share,
  };
}

async function check(): Promise<Alert[]> {
  const s = await snapshot();
  if (s.insuranceFundToken !== null) ifPeak = ifBaseline(ifPeak, s.insuranceFundToken);
  const alerts = evaluateAlerts(s, TEAM_PLAN_THRESHOLDS, ifPeak, vaultPeak);
  if (s.vaultSharePrice != null) vaultPeak = ifBaseline(vaultPeak, s.vaultSharePrice);
  const t = new Date().toISOString();
  if (alerts.length === 0) console.log(`${t} OK block ${s.headBlock}`);
  for (const a of alerts) console.log(`${t} ALERT ${a.severity} ${a.code} ${a.message}`);
  await page(alerts);
  return alerts;
}

async function page(alerts: Alert[]): Promise<void> {
  const post = (url: string, body: string) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5_000) });
  for (const msg of planPages(pager, alerts, Date.now() / 1000, DEFAULT_PAGER, LABEL)) {
    const r = await deliver(channel, msg, post);
    if (!r.ok) console.log(`${new Date().toISOString()} PAGE_FAILED ${r.detail}`);
  }
}

if (ONCE) {
  const a = await check();
  process.exit(a.some((x) => x.severity === "critical") ? 2 : 0);
}
console.log(`${new Date().toISOString()} paging via ${channel.kind}`);
for (;;) {
  await check().catch(async (e: unknown) => {
    const a: Alert = { severity: "critical", code: "watcher_error", message: String(e).split("\n")[0] ?? "" };
    console.log(`${new Date().toISOString()} ALERT critical watcher_error ${a.message}`);
    await page([a]);
  });
  await new Promise((r) => setTimeout(r, INTERVAL));
}
