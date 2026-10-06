// Thin RPC wiring for the Pulse market maker. All pricing lives in as.ts / plan.ts (pure, unit-tested).
// Per block: read index + inventory → A–S quotes (MATH_SPEC §4) → 3-level ladder → replace/place/cancel.
// Requotes when the index moved > 2 bps since the last quote, inventory moved, or a level is missing (filled).
// Kill switch: the KILL_FILE exists, or the oracle is stale ⇒ cancel every resting order and stop quoting.
// RPC/gas budget (Phase 4 step 1): tick every TICK_EVERY_BLOCKS; per tick the index + our account (parallel) and ONE
// eth_getLogs for our Trade/OrderEvicted since the last tick; getOrder only for ids those logs mention (plus a full
// refresh every FULL_REFRESH_TICKS); per-tx gas limits (send.ts gasLimitsForBatch) instead of the batch max; reads can
// go to a separate READ_RPC_URL; throttled requests retry with jittered back-off (@pulse/bot-rpc).
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
import { RateWindow, createCountingFetch, newRpcStats } from "@pulse/bot-rpc";
import { clearingHouseAbi, fundingSwapAbi, oracleAdapterAbi, orderBookAbi } from "./abi.js";
import { DEFAULTS, buildLadder, inventoryRatio, quoteBps, sigmaForQuoting } from "./as.js";
import { type AnchorSource, aprSigma, aprWadToBps, blocksFor, buildAprLadder, chooseAnchor, movedAprBps } from "./aprbook.js";
import { type Resting, idsToRefresh, needsRequote, planRequote, shouldTick, touchedId } from "./plan.js";
import { gasLimitFor, gasLimitsForBatch, sendBatch } from "./send.js";
import { launchGuard } from "./launch.js";

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
const REQUOTE_BPS = BigInt(env("REQUOTE_BPS") ?? "2"); // MATH_SPEC §4; testnet budget runs raise it (Monad bills the gas limit)
const MAX_INVENTORY_LOTS = BigInt(env("MAX_INVENTORY_LOTS") ?? "200"); // 20,000 MON (< the 25,000 MON position cap)
// Swap book (MARKET=swap): inventory limit = the swap market's maxPositionSize × this fraction (read at start).
const SWAP_INVENTORY_FRACTION_BPS = BigInt(env("SWAP_INVENTORY_FRACTION_BPS") ?? "8000");
// σ on the APR axis (APR bps/√s): the spec gives no default; 1 bp/√s ⇒ δ ≈ 4.56 APR bps at γ 0.01, k 0.5, 60 s.
const SWAP_SIGMA_BPS = Number(env("SWAP_SIGMA_BPS") ?? "1");
const SWAP_SIGMA_MAX = Number(env("SWAP_SIGMA_MAX") ?? "20");
const SWAP_SIGMA_WINDOW_SEC = 8 * 3600; // σ from the 8 h realized APR series (MATH_SPEC §4)
const SIGMA_WINDOW_SEC = 600; // σ from the last 10 min of index
const SIGMA_MIN_COVERAGE_SEC = Number(env("SIGMA_MIN_COVERAGE_SEC") ?? "120");
const SIGMA_MAX = Number(env("SIGMA_MAX") ?? String(5 * DEFAULTS.sigma)); // ≈ 500% annual vol
const GAMMA = Number(env("GAMMA") ?? String(DEFAULTS.gamma));
const K = Number(env("K") ?? String(DEFAULTS.k));
const HORIZON_SEC = Number(env("HORIZON_SEC") ?? String(DEFAULTS.horizonSec));
const RECOVER_LOOKBACK_BLOCKS = BigInt(env("RECOVER_LOOKBACK_BLOCKS") ?? "5000");
const LOG_SPAN = BigInt(env("LOG_SPAN") ?? "100"); // public RPC eth_getLogs cap (ARCHITECTURE R2)
const READ_RPC_URL = env("READ_RPC_URL") ?? RPC_URL; // reads/estimates/receipts; sends always go to RPC_URL
const TICK_EVERY_BLOCKS = BigInt(env("TICK_EVERY_BLOCKS") ?? "1"); // 2–3 on testnet
const FULL_REFRESH_TICKS = Number(env("FULL_REFRESH_TICKS") ?? "20"); // getOrder on every resting id every N ticks
const ESTIMATE_BLOCK_TAG = (env("ESTIMATE_BLOCK_TAG") ?? "pending") as "pending" | "latest";
// Gas policy (send.ts): per-tx estimate + buffers. Touch allowance defaults to 0 when estimating against `pending`.
const CONFLICT_BUFFER_GAS = BigInt(env("CONFLICT_BUFFER_GAS") ?? "45000");
const TOUCH_ALLOWANCE_GAS = BigInt(env("TOUCH_ALLOWANCE_GAS") ?? (ESTIMATE_BLOCK_TAG === "pending" ? "0" : "60000"));

interface MarketDeployment {
  ClearingHouse?: Address;
  OrderBook?: Address;
  OracleAdapter?: Address;
}
interface Deployments {
  chainId: number;
  deployed?: boolean;
  contracts: MarketDeployment & { FundingSwapMarket?: Address; SwapOrderBook?: Address };
  /** MON-PERP-DEMO test market (DeployPulse on 10143); quote it with MARKET=demo. */
  demoMarket?: MarketDeployment & { symbol: string; testMarket: true };
}
const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments;
if (dep.chainId !== CHAIN_ID) throw new Error(`deployments chainId ${dep.chainId} != CHAIN_ID ${CHAIN_ID}`);
const MARKET = env("MARKET") ?? "main";
// MARKET=swap quotes the funding-swap book (SwapOrderBook, margin engine FundingSwapMarket) on the APR axis; the perp
// CH/oracle of the main market give the anchor fallback and the stale-oracle kill switch.
const IS_SWAP = MARKET === "swap";
{
  const refusal = launchGuard({ chainId: CHAIN_ID, market: MARKET, requoteBps: REQUOTE_BPS, allowHighBurn: env("ALLOW_HIGH_BURN") === "1" });
  if (refusal !== null) throw new Error(refusal);
}
const market = MARKET === "demo" ? dep.demoMarket : dep.contracts;
const SWAP: Address | undefined = IS_SWAP ? dep.contracts.FundingSwapMarket : undefined;
if (IS_SWAP && (SWAP === undefined || dep.contracts.SwapOrderBook === undefined)) throw new Error(`${DEPLOYMENTS}: no FundingSwapMarket/SwapOrderBook`);
if (dep.deployed === false || market?.ClearingHouse === undefined || market.OrderBook === undefined || market.OracleAdapter === undefined) {
  throw new Error(`${DEPLOYMENTS}: market ${MARKET} is not deployed`);
}
const TOUCH_EVENTS = orderBookAbi.filter(
  (x): x is Extract<(typeof orderBookAbi)[number], { type: "event"; name: "Trade" | "OrderEvicted" | "MakerFillSkipped" }> =>
    x.type === "event" && (x.name === "Trade" || x.name === "OrderEvicted" || x.name === "MakerFillSkipped"),
);
const CH: Address = market.ClearingHouse;
const OB: Address = IS_SWAP ? (dep.contracts.SwapOrderBook as Address) : market.OrderBook;
const ORACLE: Address = market.OracleAdapter;

const chain = defineChain({
  id: CHAIN_ID,
  name: `pulse-${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(MM_PK, { nonceManager });
const rpcStats = newRpcStats();
const rpcRate = new RateWindow(60_000);
const fetchFn = createCountingFetch({ stats: rpcStats, onCall: (m) => rpcRate.add(Date.now(), Math.max(1, m.length)) });
// eth_blockNumber polling was ~250/min at 250 ms (30 Sep rehearsal): quoting every N blocks needs no faster polling.
const POLL_MS = Number(env("POLL_MS") ?? String(250 * Number(TICK_EVERY_BLOCKS)));
const pub = createPublicClient({ chain, transport: http(READ_RPC_URL, { fetchFn, retryCount: 0 }), pollingInterval: POLL_MS });
const wallet = createWalletClient({ chain, account, transport: http(RPC_URL, { fetchFn, retryCount: 0 }) });
const rpc = () => ({ rpcCalls: rpcStats.calls, rpcCallsPerMin: rpcRate.perMinute(Date.now()), rpcErrors: rpcStats.errors, rpcRateLimited: rpcStats.rateLimited });

const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

let resting: Resting[] = [];
const samples: Array<{ t: number; price: bigint }> = [];
let lastQuotedIndex = 0n;
const aprSamples: Array<{ t: number; aprBps: number }> = [];
let maxInventoryWad = 0n; // swap: maxPositionSize × fraction
let REALIZED_BLOCKS = 96_000n; // 8 h at the CH's blockTimeMs (read at start)
let lastQ = Number.NaN;
let busy = false;
let killed = false;
let stopping = false; // set on SIGINT: no new ticks start, the in-flight one finishes before the final cancel
let tickSize = 0n;
let lotSize = 0n;
let lastTickBlock = -1n;
let ticks = 0;
let logsTo = -1n; // our Trade/OrderEvicted logs are read up to here
const touched = new Set<bigint>(); // resting ids a fill/eviction log mentioned since the last refresh
const stats = { requotes: 0, txs: 0, errors: 0, skips: 0, gasLimitSum: 0n, gasUsedSum: 0n };

/** Monad bills the gas limit (ARCHITECTURE R6): limit = ceil(estimate × 1.2) (CLAUDE.md §7). */

/** One re-quote as a pipelined batch (send.ts): cancels, then replaces, then new placements, in planner order. */
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

type PlanItem = { label: string; data: Hex; side: "bid" | "ask" };
async function sendPlan(items: readonly PlanItem[]): Promise<TransactionReceipt[]> {
  const r = await sendBatch(items, {
    estimate: (it) => estimate(it.data),
    send: (it, gas) => wallet.sendTransaction({ to: OB, data: it.data, gas }),
    wait: (hash) => pub.waitForTransactionReceipt({ hash, timeout: 10_000 }),
    limits: (txs, est) =>
      gasLimitsForBatch(
        txs.map((t, i) => ({ estimate: est[i]!, side: t.side })),
        { conflictBufferGas: CONFLICT_BUFFER_GAS, touchAllowanceGas: TOUCH_ALLOWANCE_GAS },
      ),
  });
  r.receipts.forEach((rcpt, i) => {
    stats.txs++;
    stats.gasLimitSum += r.gasLimits[i]!;
    stats.gasUsedSum += rcpt.gasUsed;
    log(items[i]!.label, { block: rcpt.blockNumber, status: rcpt.status, gasUsed: rcpt.gasUsed, gasLimit: r.gasLimits[i], pipelined: r.pipelined });
  });
  return r.receipts;
}

async function send(label: string, data: Hex): Promise<TransactionReceipt> {
  const est = await estimate(data);
  const gas = gasLimitFor(est + TOUCH_ALLOWANCE_GAS);
  const hash = await wallet.sendTransaction({ to: OB, data, gas });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 10_000 });
  stats.txs++;
  stats.gasLimitSum += gas;
  stats.gasUsedSum += rcpt.gasUsed;
  log(label, { block: rcpt.blockNumber, status: rcpt.status, gasUsed: rcpt.gasUsed, gasLimit: gas });
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

/**
 * Drop orders that no longer rest (filled / evicted) and refresh partially filled sizes. `ids` = the orders to read
 * (default: all). Only a fill or an eviction changes a resting order without our own tx (idsToRefresh).
 */
async function refreshResting(ids?: readonly bigint[]): Promise<void> {
  const want = new Set(ids ?? resting.map((r) => r.id));
  const toRead = resting.filter((r) => want.has(r.id));
  const views = await Promise.all(toRead.map((r) => pub.readContract({ address: OB, abi: orderBookAbi, functionName: "getOrder", args: [r.id] })));
  const lots = new Map(toRead.map((r, i) => [r.id, views[i]!.remainingLots]));
  resting = resting.flatMap((r) => {
    const l = lots.get(r.id);
    if (l === undefined) return [r];
    touched.delete(r.id);
    return l === 0n ? [] : [{ ...r, lots: l }];
  });
}

/**
 * Our fills/evictions/skips since the last tick (one eth_getLogs, chunked by LOG_SPAN): marks the ids to re-read.
 * A MakerFillSkipped (CR-007: paused / oracle stale) leaves the order live and unchanged: counted, not re-read.
 */
async function scanTouched(head: bigint): Promise<void> {
  const from = logsTo >= 0n ? logsTo + 1n : head;
  for (let s = from; s <= head; s += LOG_SPAN) {
    const e = s + LOG_SPAN - 1n < head ? s + LOG_SPAN - 1n : head;
    const logs = await pub.getLogs({ address: OB, events: TOUCH_EVENTS, fromBlock: s, toBlock: e, strict: true });
    for (const l of logs) {
      if (l.args.maker.toLowerCase() !== account.address.toLowerCase()) continue;
      const id = touchedId(l);
      if (id === null) stats.skips++;
      else touched.add(id);
    }
    logsTo = e;
  }
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

type QuoteState =
  | { kind: "stale" }
  | { kind: "matured" }
  | {
      kind: "quote";
      /** perp: oracle index (WAD); swap: anchor APR (WAD) */
      ref: bigint;
      q: number;
      sigma: number;
      quote: ReturnType<typeof quoteBps>;
      ladder: ReturnType<typeof buildLadder>;
      movedBps: bigint;
      anchorSource?: AnchorSource;
    };
let maturedLogged = false;
let lastAnchorSource: AnchorSource | null = null;

/**
 * Parallel reads (index/anchor, our account, our fills/evictions since the last tick) → A–S quote → target ladder.
 * Perp: bps relative to the index (MATH_SPEC §4). Swap: absolute APR bps around realizedApr(8 h), falling back to the
 * perp's current funding APR until 8 h of checkpoints exist (aprbook.ts). σ samples use the local clock (no block read).
 */
async function readQuoteState(block: bigint): Promise<QuoteState> {
  const nowSec = Math.floor(Date.now() / 1000);
  const oracleRead = pub.readContract({ address: ORACLE, abi: oracleAdapterAbi, functionName: "tryGetIndexPrice" });
  if (!IS_SWAP) {
    const [[ok, index], acct] = await Promise.all([
      oracleRead,
      pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "getAccount", args: [account.address] }),
      scanTouched(block),
    ]);
    if (!ok || index === 0n) return { kind: "stale" };
    samples.push({ t: nowSec, price: index });
    while (samples.length && samples[0]!.t < nowSec - SIGMA_WINDOW_SEC) samples.shift();
    const q = inventoryRatio(acct.size, MAX_INVENTORY_LOTS * lotSize);
    const sigma = sigmaForQuoting(samples, { fallback: DEFAULTS.sigma, minCoverageSec: SIGMA_MIN_COVERAGE_SEC, max: SIGMA_MAX });
    const quote = quoteBps({ sigma, gamma: GAMMA, k: K, horizonSec: HORIZON_SEC, q });
    const ladder = buildLadder({ midWad: index, tickSize, bidBps: quote.bidBps, askBps: quote.askBps, levels: LEVELS, levelSpacingBps: LEVEL_SPACING_BPS, lotsPerLevel: LOTS_PER_LEVEL, q });
    const movedBps = lastQuotedIndex === 0n ? 10_000n : (abs(index - lastQuotedIndex) * 10_000n) / lastQuotedIndex;
    return { kind: "quote", ref: index, q, sigma, quote, ladder, movedBps };
  }
  const [[ok, index], acct, matured, realized, fs] = await Promise.all([
    oracleRead,
    pub.readContract({ address: SWAP!, abi: fundingSwapAbi, functionName: "getAccount", args: [account.address] }),
    pub.readContract({ address: SWAP!, abi: fundingSwapAbi, functionName: "isMatured" }),
    // reverts ObservationTooOld until the perp has 8 h of checkpoints ⇒ null ⇒ perp-rate anchor
    pub.readContract({ address: SWAP!, abi: fundingSwapAbi, functionName: "realizedApr", args: [REALIZED_BLOCKS] }).catch(() => null),
    pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "previewFundingState" }),
    scanTouched(block),
  ]);
  if (!ok || index === 0n) return { kind: "stale" };
  if (matured) return { kind: "matured" };
  const anchor = chooseAnchor(realized, fs.rate);
  if (anchor.source !== lastAnchorSource) {
    log(anchor.source === "realized-8h" ? "anchor: realized 8 h APR" : "anchor: perp current funding APR (no 8 h history yet)", { aprWad: anchor.aprWad });
    lastAnchorSource = anchor.source;
  }
  const aprBps = aprWadToBps(anchor.aprWad);
  aprSamples.push({ t: nowSec, aprBps });
  while (aprSamples.length && aprSamples[0]!.t < nowSec - SWAP_SIGMA_WINDOW_SEC) aprSamples.shift();
  const q = inventoryRatio(acct.size, maxInventoryWad);
  const sigma = aprSigma(aprSamples, { fallback: SWAP_SIGMA_BPS, minCoverageSec: SIGMA_MIN_COVERAGE_SEC, max: SWAP_SIGMA_MAX });
  const quote = quoteBps({ sigma, gamma: GAMMA, k: K, horizonSec: HORIZON_SEC, q });
  const ladder = buildAprLadder({ anchorAprBps: aprBps, tickSize, bidBps: quote.bidBps, askBps: quote.askBps, levels: LEVELS, levelSpacingBps: LEVEL_SPACING_BPS, lotsPerLevel: LOTS_PER_LEVEL, q });
  const movedBps = Number.isNaN(lastQ) ? 10_000n : movedAprBps(anchor.aprWad, lastQuotedIndex); // first quote always
  return { kind: "quote", ref: anchor.aprWad, q, sigma, quote, ladder, movedBps, anchorSource: anchor.source };
}

async function tick(block: bigint): Promise<void> {
  if (busy || stopping) return;
  if (!shouldTick(block, lastTickBlock, TICK_EVERY_BLOCKS)) return;
  lastTickBlock = block;
  ticks++;
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
    if (needResync) await syncResting();
    const st = await readQuoteState(block);
    if (st.kind !== "quote") {
      await refreshResting();
      if (resting.length) await cancelAll(st.kind === "stale" ? "oracle stale" : "swap matured");
      if (st.kind === "matured" && !maturedLogged) log("swap market matured: quotes pulled (reduce-only market, MATH_SPEC §6)");
      maturedLogged = st.kind === "matured";
      return;
    }
    const { ref, q, sigma, quote, ladder, movedBps } = st;
    await refreshResting(idsToRefresh(resting, touched, ticks, FULL_REFRESH_TICKS));
    const requote = needsRequote({
      movedBps,
      restingCount: resting.length,
      targetCount: ladder.bids.length + ladder.asks.length,
      allFull: resting.every((r) => r.lots === LOTS_PER_LEVEL),
      dq: Number.isNaN(lastQ) ? 1 : Math.abs(q - lastQ),
      requoteBps: REQUOTE_BPS,
    });
    if (!requote) return;
    const plan = planRequote(resting, ladder);
    const sideOf = (isBid: boolean): "bid" | "ask" => (isBid ? "bid" : "ask");
    const bySide = new Map(resting.map((r) => [r.id, sideOf(r.isBid)]));
    const items: PlanItem[] = [
      ...plan.cancel.map((id) => ({
        label: "cancel",
        side: bySide.get(id) ?? "bid",
        data: encodeFunctionData({ abi: orderBookAbi, functionName: "cancelOrder", args: [id] }),
      })),
      ...plan.replace.map((r) => ({
        label: "replace",
        side: sideOf(r.isBid),
        data: encodeFunctionData({ abi: orderBookAbi, functionName: "replaceOrder", args: [r.id, r.tick, r.lots, 0] }),
      })),
      ...plan.place.map((p) => ({
        label: "place",
        side: sideOf(p.isBid),
        data: encodeFunctionData({ abi: orderBookAbi, functionName: "placeLimitOrder", args: [p.isBid, p.tick, p.lots, 0] }),
      })),
    ];
    const receipts = await sendPlan(items);
    // Cancelled and replaced ids no longer rest; a replace or place re-rests under the id in its OrderPlaced log.
    const gone = new Set<bigint>([...plan.cancel, ...plan.replace.map((r) => r.id)]);
    resting = [...resting.filter((r) => !gone.has(r.id)), ...receipts.flatMap((rc) => (rc.status === "success" ? placedFrom(rc) : []))];
    lastQuotedIndex = ref;
    lastQ = q;
    stats.requotes++;
    log("quoted", {
      block,
      ...(IS_SWAP ? { anchorAprBps: aprWadToBps(ref).toFixed(2), anchorSource: st.anchorSource } : { index: ref }),
      sigmaBps: sigma.toFixed(3),
      q: q.toFixed(3),
      spreadBps: quote.spread.toFixed(2),
      reservationBps: quote.reservation.toFixed(2),
      bids: ladder.bids.map((l) => l.tick),
      asks: ladder.asks.map((l) => l.tick),
      ...stats,
      ...rpc(),
    });
  } catch (e) {
    stats.errors++;
    needResync = true; // a failed batch may still have placed orders
    log("error", { step: "tick", error: String(e).split("\n")[0] });
  } finally {
    busy = false;
  }
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Merge our OrderPlaced logs in (syncedTo, head] into `resting`, then drop filled/cancelled ids. Used at start (restart
 * safety, RECOVER_LOOKBACK_BLOCKS), after a failed tick and before the shutdown cancel: a batch whose receipt wait fails
 * still places orders, and memory alone left them orphaned on testnet (30 Sep).
 */
let syncedTo = -1n;
let needResync = false;
async function syncResting(): Promise<void> {
  const head = await pub.getBlockNumber();
  const from = syncedTo >= 0n ? syncedTo + 1n : head > RECOVER_LOOKBACK_BLOCKS ? head - RECOVER_LOOKBACK_BLOCKS : 0n;
  const known = new Set(resting.map((r) => r.id));
  for (let s = from; s <= head; s += LOG_SPAN) {
    const e = s + LOG_SPAN - 1n < head ? s + LOG_SPAN - 1n : head;
    const logs = await pub.getContractEvents({ address: OB, abi: orderBookAbi, eventName: "OrderPlaced", args: { maker: account.address }, fromBlock: s, toBlock: e, strict: true });
    for (const l of logs) {
      if (known.has(l.args.orderId)) continue;
      known.add(l.args.orderId);
      resting.push({ id: l.args.orderId, isBid: l.args.isBid, tick: l.args.tick, lots: l.args.lots });
    }
    syncedTo = e;
  }
  await refreshResting();
  needResync = false;
}

tickSize = await pub.readContract({ address: OB, abi: orderBookAbi, functionName: "tickSize" });
lotSize = await pub.readContract({ address: OB, abi: orderBookAbi, functionName: "lotSize" });
if (IS_SWAP) {
  const sp = await pub.readContract({ address: SWAP!, abi: fundingSwapAbi, functionName: "swapParams" });
  maxInventoryWad = (sp.maxPositionSize * SWAP_INVENTORY_FRACTION_BPS) / 10_000n;
  const fp = await pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "fundingParams" });
  REALIZED_BLOCKS = blocksFor(8 * 3600, fp.blockTimeMs);
  log("swap book", { swapMarket: SWAP, swapOrderBook: OB, maxInventoryWad, realizedWindowBlocks: REALIZED_BLOCKS, sigmaFallbackAprBps: SWAP_SIGMA_BPS });
}
await syncResting();
log("recovered resting orders", { count: resting.length, lookbackBlocks: RECOVER_LOOKBACK_BLOCKS });
log("mm start", {
  chainId: CHAIN_ID,
  market: MARKET,
  orderBook: OB,
  maker: account.address,
  levels: LEVELS,
  lotsPerLevel: LOTS_PER_LEVEL,
  killFile: KILL_FILE,
  tickEveryBlocks: TICK_EVERY_BLOCKS,
  estimateBlockTag: ESTIMATE_BLOCK_TAG,
  separateReadRpc: READ_RPC_URL !== RPC_URL,
});
setInterval(() => log("stats", { ...stats, ...rpc(), resting: resting.length }), 60_000).unref();
process.on("SIGINT", () => {
  if (stopping) process.exit(1); // second Ctrl-C: exit now, restart re-adopts resting orders (RECOVER_LOOKBACK_BLOCKS)
  stopping = true;
  log("SIGINT: waiting for the in-flight re-quote, then cancelling all");
  // Cancelling while a pipelined batch is in flight left its new orders resting (testnet, 30 Sep): wait for it first.
  const drain = async (): Promise<void> => {
    while (busy) await new Promise((r) => setTimeout(r, 100));
    await syncResting();
    await cancelAll("shutdown");
  };
  void drain().finally(() => process.exit(0));
});
pub.watchBlockNumber({ emitOnBegin: true, onBlockNumber: (b) => void tick(b), onError: (e) => log("error", { step: "watch", error: String(e) }) });
