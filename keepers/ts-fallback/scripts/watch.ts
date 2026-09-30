// Monitoring watcher (TEAM_PLAN §7; paging is Phase 5): polls keeper /health endpoints and chain views, prints one
// `ALERT <severity> <code> <message>` line per finding (rules: src/alerts.ts), `OK …` when clean.
//   CHAIN_ID=10143 RPC_URL=… DEPLOYMENTS=../../deployments/10143.json KEEPER_HEALTH=http://localhost:8797/health \
//   WATCH_BALANCES=keeper=0x…,mm=0x… [INTERVAL_SEC=15] [ONCE=1] pnpm watch
// ONCE=1 checks once and exits 2 on any critical alert (for cron / CI). INDEXER_LAG_URL (optional) must return JSON
// {"lagSec": n}; > VERIFY the Envio/Hasura endpoint that exposes the latest processed block before wiring it.
import { readFileSync } from "node:fs";
import { type Address, createPublicClient, http } from "viem";
import { clearingHouseAbi, insuranceFundAbi, oracleAdapterAbi, pulseVaultAbi } from "../src/abi.js";
import { type Alert, type Snapshot, TEAM_PLAN_THRESHOLDS, evaluateAlerts, ifBaseline } from "../src/alerts.js";

const env = (k: string): string | undefined => (process.env[k] === "" ? undefined : process.env[k]);
const need = (k: string): string => env(k) ?? (() => { throw new Error(`missing env ${k}`); })();
const dep = JSON.parse(readFileSync(need("DEPLOYMENTS"), "utf8")) as { chainId: number; contracts: Record<string, Address | undefined> };
if (dep.chainId !== Number(need("CHAIN_ID"))) throw new Error("deployments chainId mismatch");
const pub = createPublicClient({ transport: http(need("RPC_URL"), { timeout: 5_000 }) });
const C = dep.contracts;
const health = (env("KEEPER_HEALTH") ?? "").split(",").filter(Boolean);
const balances = (env("WATCH_BALANCES") ?? "").split(",").filter(Boolean).map((kv) => {
  const [label, addr] = kv.split("=");
  return { label: label ?? "?", addr: addr as Address };
});
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
    Promise.all(balances.map(async (b) => ({ label: b.label, wei: await pub.getBalance({ address: b.addr }) }))),
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
  };
}

async function check(): Promise<Alert[]> {
  const s = await snapshot();
  if (s.insuranceFundToken !== null) ifPeak = ifBaseline(ifPeak, s.insuranceFundToken);
  const alerts = evaluateAlerts(s, TEAM_PLAN_THRESHOLDS, ifPeak);
  const t = new Date().toISOString();
  if (alerts.length === 0) console.log(`${t} OK block ${s.headBlock}`);
  for (const a of alerts) console.log(`${t} ALERT ${a.severity} ${a.code} ${a.message}`);
  return alerts;
}

if (ONCE) {
  const a = await check();
  process.exit(a.some((x) => x.severity === "critical") ? 2 : 0);
}
for (;;) {
  await check().catch((e: unknown) => console.log(`${new Date().toISOString()} ALERT critical watcher_error ${String(e).split("\n")[0]}`));
  await new Promise((r) => setTimeout(r, INTERVAL));
}
