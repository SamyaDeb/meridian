// Thin RPC wiring for the Pulse market maker. All pricing lives in as.ts / plan.ts (pure, unit-tested).
// Per block: read index + inventory → A–S quotes (MATH_SPEC §4) → 3-level ladder → replace/place/cancel.
// Requotes when the index moved > 2 bps since the last quote, inventory moved, or a level is missing (filled).
// Kill switch: the KILL_FILE exists, or the oracle is stale ⇒ cancel every resting order and stop quoting.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Hex,
  type TransactionReceipt,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  nonceManager,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clearingHouseAbi, oracleAdapterAbi, orderBookAbi } from "./abi.js";
import { DEFAULTS, buildLadder, inventoryRatio, quoteBps, realizedSigmaBpsPerSqrtSec } from "./as.js";
import { type Resting, planRequote } from "./plan.js";

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
const MM_PK = need("MM_PK") as Hex;
const DEPLOYMENTS = env("DEPLOYMENTS") ?? fileURLToPath(new URL(`../../deployments/${CHAIN_ID}.json`, import.meta.url));
const KILL_FILE = env("KILL_FILE") ?? fileURLToPath(new URL("../KILL", import.meta.url));
const LEVELS = Number(env("LEVELS") ?? "3");
const LOTS_PER_LEVEL = BigInt(env("LOTS_PER_LEVEL") ?? "20");
const LEVEL_SPACING_BPS = Number(env("LEVEL_SPACING_BPS") ?? "2");
const MAX_INVENTORY_LOTS = BigInt(env("MAX_INVENTORY_LOTS") ?? "200"); // 20,000 MON (< the 25,000 MON position cap)
const REQUOTE_MOVE_BPS = 2n; // MATH_SPEC §4
const SIGMA_WINDOW_SEC = 600; // σ from the last 10 min of index
const GAMMA = Number(env("GAMMA") ?? String(DEFAULTS.gamma));
const K = Number(env("K") ?? String(DEFAULTS.k));
const HORIZON_SEC = Number(env("HORIZON_SEC") ?? String(DEFAULTS.horizonSec));

interface Deployments {
  chainId: number;
  contracts: { ClearingHouse: Address; OrderBook: Address; OracleAdapter: Address };
}
const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments;
if (dep.chainId !== CHAIN_ID) throw new Error(`deployments chainId ${dep.chainId} != CHAIN_ID ${CHAIN_ID}`);
const { ClearingHouse: CH, OrderBook: OB, OracleAdapter: ORACLE } = dep.contracts;

const chain = defineChain({
  id: CHAIN_ID,
  name: `pulse-${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(MM_PK, { nonceManager });
const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 250 });
const wallet = createWalletClient({ chain, account, transport: http(RPC_URL) });

const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

let resting: Resting[] = [];
const samples: Array<{ t: number; price: bigint }> = [];
let lastQuotedIndex = 0n;
let lastQ = Number.NaN;
let busy = false;
let killed = false;
let tickSize = 0n;
let lotSize = 0n;
const stats = { requotes: 0, txs: 0, errors: 0 };

/** Monad bills the gas limit (ARCHITECTURE R6): limit = ceil(estimate × 1.2) (CLAUDE.md §7). */
const gasLimitFor = (est: bigint): bigint => (est * 12n + 9n) / 10n;

async function send(label: string, data: Hex): Promise<TransactionReceipt> {
  const est = await pub.estimateGas({ account, to: OB, data });
  const hash = await wallet.sendTransaction({ to: OB, data, gas: gasLimitFor(est) });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 10_000 });
  stats.txs++;
  log(label, { block: rcpt.blockNumber, status: rcpt.status, gasUsed: rcpt.gasUsed, gasLimit: gasLimitFor(est) });
  return rcpt;
}

/** New resting order ids of ours from a receipt's OrderPlaced logs. */
function placedFrom(rcpt: TransactionReceipt): Resting[] {
  const out: Resting[] = [];
  for (const l of rcpt.logs) {
    if (l.address.toLowerCase() !== OB.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: orderBookAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "OrderPlaced" && ev.args.maker.toLowerCase() === account.address.toLowerCase()) {
        out.push({ id: ev.args.orderId, isBid: ev.args.isBid, tick: ev.args.tick, lots: ev.args.lots });
      }
    } catch {
      /* other events */
    }
  }
  return out;
}

/** Drop orders that no longer rest (filled / evicted) and refresh partially filled sizes. */
async function refreshResting(): Promise<void> {
  const views = await Promise.all(
    resting.map((r) => pub.readContract({ address: OB, abi: orderBookAbi, functionName: "getOrder", args: [r.id] })),
  );
  resting = resting.flatMap((r, i) => (views[i]!.remainingLots === 0n ? [] : [{ ...r, lots: views[i]!.remainingLots }]));
}

async function cancelAll(reason: string): Promise<void> {
  for (const r of resting) {
    try {
      await send(`cancel (${reason})`, encodeFunctionData({ abi: orderBookAbi, functionName: "cancelOrder", args: [r.id] }));
    } catch (e) {
      stats.errors++;
      log("error", { step: "cancel", error: String(e).split("\n")[0] });
    }
  }
  resting = [];
}

async function tick(block: bigint): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (existsSync(KILL_FILE)) {
      if (!killed) log("KILL switch: cancelling all and stopping quotes", { file: KILL_FILE });
      killed = true;
      await refreshResting();
      if (resting.length) await cancelAll("kill");
      return;
    }
    killed = false;
    const [[ok, index], acct, blk] = await Promise.all([
      pub.readContract({ address: ORACLE, abi: oracleAdapterAbi, functionName: "tryGetIndexPrice" }),
      pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "getAccount", args: [account.address] }),
      pub.getBlock({ blockNumber: block }),
    ]);
    if (!ok || index === 0n) {
      await refreshResting();
      if (resting.length) await cancelAll("oracle stale");
      return;
    }
    samples.push({ t: Number(blk.timestamp), price: index });
    while (samples.length && samples[0]!.t < Number(blk.timestamp) - SIGMA_WINDOW_SEC) samples.shift();

    await refreshResting();
    const q = inventoryRatio(acct.size, MAX_INVENTORY_LOTS * lotSize);
    const moved = lastQuotedIndex === 0n ? true : abs(index - lastQuotedIndex) * 10_000n > REQUOTE_MOVE_BPS * lastQuotedIndex;
    const complete = resting.length === (q >= 1 || q <= -1 ? LEVELS : 2 * LEVELS) && resting.every((r) => r.lots === LOTS_PER_LEVEL);
    if (!moved && complete && Math.abs(q - lastQ) < 0.05) return;

    const sigma = realizedSigmaBpsPerSqrtSec(samples, DEFAULTS.sigma);
    const quote = quoteBps({ sigma: sigma > 0 ? sigma : DEFAULTS.sigma, gamma: GAMMA, k: K, horizonSec: HORIZON_SEC, q });
    const ladder = buildLadder({
      midWad: index,
      tickSize,
      bidBps: quote.bidBps,
      askBps: quote.askBps,
      levels: LEVELS,
      levelSpacingBps: LEVEL_SPACING_BPS,
      lotsPerLevel: LOTS_PER_LEVEL,
      q,
    });
    const plan = planRequote(resting, ladder);
    for (const id of plan.cancel) {
      await send("cancel", encodeFunctionData({ abi: orderBookAbi, functionName: "cancelOrder", args: [id] }));
      resting = resting.filter((r) => r.id !== id);
    }
    for (const r of plan.replace) {
      const rcpt = await send("replace", encodeFunctionData({ abi: orderBookAbi, functionName: "replaceOrder", args: [r.id, r.tick, r.lots, 0] }));
      resting = [...resting.filter((x) => x.id !== r.id), ...placedFrom(rcpt)];
    }
    for (const p of plan.place) {
      const rcpt = await send("place", encodeFunctionData({ abi: orderBookAbi, functionName: "placeLimitOrder", args: [p.isBid, p.tick, p.lots, 0] }));
      resting = [...resting, ...placedFrom(rcpt)];
    }
    lastQuotedIndex = index;
    lastQ = q;
    stats.requotes++;
    log("quoted", {
      block,
      index,
      sigmaBps: sigma.toFixed(3),
      q: q.toFixed(3),
      spreadBps: quote.spread.toFixed(2),
      reservationBps: quote.reservation.toFixed(2),
      bids: ladder.bids.map((l) => l.tick),
      asks: ladder.asks.map((l) => l.tick),
      ...stats,
    });
  } catch (e) {
    stats.errors++;
    log("error", { step: "tick", error: String(e).split("\n")[0] });
  } finally {
    busy = false;
  }
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

tickSize = await pub.readContract({ address: OB, abi: orderBookAbi, functionName: "tickSize" });
lotSize = await pub.readContract({ address: OB, abi: orderBookAbi, functionName: "lotSize" });
log("mm start", { chainId: CHAIN_ID, orderBook: OB, maker: account.address, levels: LEVELS, lotsPerLevel: LOTS_PER_LEVEL, killFile: KILL_FILE });
process.on("SIGINT", () => {
  log("SIGINT: cancelling all");
  void cancelAll("shutdown").finally(() => process.exit(0));
});
pub.watchBlockNumber({ emitOnBegin: true, onBlockNumber: (b) => void tick(b), onError: (e) => log("error", { step: "watch", error: String(e) }) });
