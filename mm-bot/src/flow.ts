// Thin RPC wiring for the house flow bot (`pnpm flow`). All decisions live in flowplan.ts (pure, unit-tested).
// Every FLOW_MIN_SEC..FLOW_MAX_SEC (random): read index + own position + best bid/ask → one small IOC market order of
// random side and size (biased toward reducing past FLOW_POSITION_CAP_LOTS) within FLOW_MAX_SLIPPAGE_BPS of the index.
// Its key must differ from the MM's and be listed under `mmAccounts` in the deployments record (operator flow, never
// counted as an external user). Kill switch: the KILL_FILE (shared with the MM by default) stops all takes.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RateWindow, createCountingFetch, newRpcStats } from "@meridian/bot-rpc";
import { clearingHouseAbi, oracleAdapterAbi, orderBookAbi } from "./abi.js";
import { type FlowConfig, type FlowIo, flowStep, nextDelayMs, startupProblem } from "./flowplan.js";
import { gasLimitFor } from "./send.js";
import { type PerpRecord, resolvePerpMarket } from "./market.js";

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === "" ? undefined : v;
};
const need = (k: string): string => {
  const v = env(k);
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const CHAIN_ID = Number(env("CHAIN_ID") ?? "31337");
const RPC_URL = CHAIN_ID === 31337 ? (env("RPC_URL") ?? "http://127.0.0.1:8545") : need("RPC_URL");
const READ_RPC_URL = env("READ_RPC_URL") ?? RPC_URL;
const FLOW_PK = need("FLOW_PK") as Hex;
const DEPLOYMENTS = env("DEPLOYMENTS") ?? fileURLToPath(new URL(`../../deployments/${CHAIN_ID}.json`, import.meta.url));
const KILL_FILE = env("KILL_FILE") ?? fileURLToPath(new URL("../KILL", import.meta.url));
const ESTIMATE_BLOCK_TAG = (env("ESTIMATE_BLOCK_TAG") ?? "pending") as "pending" | "latest";
const TOUCH_ALLOWANCE_GAS = BigInt(env("TOUCH_ALLOWANCE_GAS") ?? (ESTIMATE_BLOCK_TAG === "pending" ? "0" : "60000"));
const cfg: FlowConfig = {
  minSec: Number(env("FLOW_MIN_SEC") ?? "20"),
  maxSec: Number(env("FLOW_MAX_SEC") ?? "90"),
  maxLots: BigInt(env("FLOW_MAX_LOTS") ?? "3"),
  maxSlippageBps: Number(env("FLOW_MAX_SLIPPAGE_BPS") ?? "30"),
  positionCapLots: BigInt(env("FLOW_POSITION_CAP_LOTS") ?? "10"),
};

interface Deployments extends PerpRecord {
  chainId: number;
  mmAccounts?: string[];
}
const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments;
if (dep.chainId !== CHAIN_ID) throw new Error(`deployments chainId ${dep.chainId} != CHAIN_ID ${CHAIN_ID}`);
const MARKET = env("MARKET") ?? "main";
if (MARKET === "swap") throw new Error("MARKET=swap: the flow bot takes on a perp book only (main | demo | an added market)");
// main | demo | an added market (K7: "eth" ⇒ ETH-PERP), src/market.ts
const market = resolvePerpMarket(dep, MARKET, DEPLOYMENTS);
const CH: Address = market.clearingHouse;
const OB: Address = market.orderBook;
const ORACLE: Address = market.oracle;

const account = privateKeyToAccount(FLOW_PK, { nonceManager });
const mmPk = env("MM_PK") as Hex | undefined;
{
  const problem = startupProblem({ flow: account.address, mm: mmPk ? privateKeyToAccount(mmPk).address : undefined, mmAccounts: dep.mmAccounts });
  if (problem !== null) throw new Error(problem);
}

const chain = defineChain({
  id: CHAIN_ID,
  name: `meridian-${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const rpcStats = newRpcStats();
const rpcRate = new RateWindow(60_000);
const fetchFn = createCountingFetch({ stats: rpcStats, onCall: (m) => rpcRate.add(Date.now(), Math.max(1, m.length)) });
const pub = createPublicClient({ chain, transport: http(READ_RPC_URL, { fetchFn, retryCount: 0 }) });
const wallet = createWalletClient({ chain, account, transport: http(RPC_URL, { fetchFn, retryCount: 0 }) });

const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const stats = { takes: 0, reverted: 0, skips: 0, errors: 0, gasLimitSum: 0n, lotsBought: 0n, lotsSold: 0n };

async function estimate(data: Hex): Promise<bigint> {
  if (ESTIMATE_BLOCK_TAG === "pending") {
    try {
      return await pub.estimateGas({ account, to: OB, data, blockTag: "pending" });
    } catch (e) {
      if (!/pending|block tag|not supported|invalid/i.test(String(e))) throw e; // a revert stays a revert
    }
  }
  return pub.estimateGas({ account, to: OB, data });
}

const io: FlowIo = {
  killed: () => existsSync(KILL_FILE),
  index: async () => {
    const [ok, price] = await pub.readContract({ address: ORACLE, abi: oracleAdapterAbi, functionName: "tryGetIndexPrice" });
    return ok ? price : null;
  },
  positionWad: async () => (await pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "getAccount", args: [account.address] })).size,
  book: async () => {
    const [bestBid, bestAsk] = await Promise.all([
      pub.readContract({ address: OB, abi: orderBookAbi, functionName: "bestBid" }),
      pub.readContract({ address: OB, abi: orderBookAbi, functionName: "bestAsk" }),
    ]);
    return { bestBid, bestAsk };
  },
  take: async (t) => {
    // minFilledLots = 1: a partial fill is fine; nothing fills ⇒ SlippageExceeded at estimate time, so no tx is sent.
    const data = encodeFunctionData({ abi: orderBookAbi, functionName: "placeMarketOrder", args: [t.isBid, t.lots, t.limitTick, 1n, t.reduceOnly] });
    const gas = gasLimitFor((await estimate(data)) + TOUCH_ALLOWANCE_GAS); // Monad bills the limit: estimate × 1.2 (CONTRIBUTING.md §7)
    const hash = await wallet.sendTransaction({ to: OB, data, gas });
    const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 10_000 });
    log("take", { block: rcpt.blockNumber, status: rcpt.status, side: t.isBid ? "buy" : "sell", lots: t.lots, limitTick: t.limitTick, reduceOnly: t.reduceOnly, gasLimit: gas, tx: hash });
    return { status: rcpt.status, gasLimit: gas };
  },
};

let stopping = false;
let busy = false;
let killedLogged = false;
let lotSize = 0n;
let tickSize = 0n;

async function step(): Promise<void> {
  if (stopping) return;
  busy = true;
  try {
    const r = await flowStep(io, Math.random, cfg, lotSize, tickSize);
    if (r.kind === "killed") {
      if (!killedLogged) log("KILL switch: no takes until the file is removed", { file: KILL_FILE });
      killedLogged = true;
    } else {
      killedLogged = false;
      if (r.kind === "skip") {
        stats.skips++;
        log("skip", { reason: r.reason });
      } else {
        stats.takes++;
        stats.gasLimitSum += r.gasLimit;
        if (r.status !== "success") stats.reverted++;
        else if (r.take.isBid) stats.lotsBought += r.take.lots;
        else stats.lotsSold += r.take.lots;
      }
    }
  } catch (e) {
    stats.errors++; // an estimate revert (book moved, oracle went stale) lands here before any tx is sent
    log("error", { step: "take", error: String(e).split("\n")[0] });
  } finally {
    busy = false;
  }
  if (!stopping) setTimeout(() => void step(), nextDelayMs(Math.random, cfg.minSec, cfg.maxSec));
}

[tickSize, lotSize] = await Promise.all([
  pub.readContract({ address: OB, abi: orderBookAbi, functionName: "tickSize" }),
  pub.readContract({ address: OB, abi: orderBookAbi, functionName: "lotSize" }),
]);
const acct = await pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "getAccount", args: [account.address] });
if (acct.collateral === 0n) throw new Error(`flow account ${account.address} has no collateral in ${CH}: deposit tAUSD first (RUNBOOK §2b)`);
log("flow start", { chainId: CHAIN_ID, market: MARKET, orderBook: OB, taker: account.address, killFile: KILL_FILE, ...cfg, collateralWad: acct.collateral });
setInterval(() => log("stats", { ...stats, rpcCalls: rpcStats.calls, rpcCallsPerMin: rpcRate.perMinute(Date.now()), rpcErrors: rpcStats.errors }), 60_000).unref();
process.on("SIGINT", () => {
  if (stopping) process.exit(1);
  stopping = true;
  log("SIGINT: finishing the in-flight take, then exiting (the flow bot never rests orders)");
  const drain = async (): Promise<void> => {
    while (busy) await new Promise((r) => setTimeout(r, 100));
  };
  void drain().finally(() => process.exit(0));
});
setTimeout(() => void step(), nextDelayMs(Math.random, cfg.minSec, cfg.maxSec));
