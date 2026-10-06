// Thin RPC wiring for the Meridian TS fallback keeper. All decisions live in decide.ts (pure, unit-tested).
// Per block: (a) oracle push — Pyth Hermes (only with PYTH_API_KEY) or, on testnet without a key, the keeper-fed
// TestnetKeeperOracle from a keyless source (pricesource.ts) — (b) funding poke, (c) perp liquidations.
// RPC budget (Phase 4 step 1): ONE eth_getLogs per block (CH PositionChanged + FundingUpdated, oracle PriceUpdated)
// feeds every step: the open-position set, the funding decision (last FundingUpdated block, observed gaps) and
// "an oracle push landed" (full liquidation sweep + vault read). getAccount only for accounts that changed, whose
// mark move could have crossed maintenance (decide.ts accountsToCheck), or on a full sweep. Throttled requests are
// retried with jittered back-off (@meridian/bot-rpc) instead of failing the step.
// MARKET=demo runs the same loop against the clearly labelled MON-PERP-DEMO test market (deployments.demoMarket).
// Funding swaps (Phase 4 step 2): an extra step of the MAIN keeper (not a separate process: it shares the tick, the one
// log scan, the nonce and the block polling), on when deployments has FundingSwapMarket (SWAP_DUTIES=0 turns it off):
// swap liquidations (SwapPositionChanged → getAccount → liquidate, size-bounded; the keeper must hold collateral in the
// swap market because the liquidator takes the position) and settleMaturity() exactly once at maturity.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  maxUint256,
  nonceManager,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RateWindow, burnPerHourWei, createCountingFetch, newRpcStats, pruneSamples, type BalanceSample } from "@meridian/bot-rpc";
import { clearingHouseAbi, fundingSwapAbi, fundingSwapImplAbi, kuruHedgerAbi, oracleAdapterAbi, meridianVaultAbi } from "./abi.js";
import { type CallFrame, FlowClient, findHedgerCalls, parseQuote, quoteRequest, routeAmount } from "./kuruflow.js";
import { type SwapSnapshot, shouldPokeSwapMark, shouldSettleMaturity, swapAccountIsInert, swapAccountsToCheck, swapIsHot, swapLiquidationCandidates } from "./swap.js";
import {
  type AccountSnapshot,
  type CheckedAccount,
  type PricePoint,
  accountsToCheck,
  applyPositionChanges,
  checkedFrom,
  defaultInclusionLag,
  forceSweepAfterPush,
  fundingGaps,
  observedMaxGap,
  isLiquidationCandidate,
  blockRanges,
  gasLimitFor,
  selectLiquidations,
  shouldPokeFunding,
  shouldPushPyth,
  shouldCheckVault,
  shouldReadSource,
  vaultAction,
} from "./decide.js";
import { DEFAULT_HERMES_URL, fetchHermesLatest } from "./hermes.js";
import { type SourcedPrice, decimalToWad, encodeTestOracleUpdate, feedPoint, latestKeylessPrice } from "./pricesource.js";
import { LiquidationLatency } from "./latency.js";

// ───────────────────────────── config ─────────────────────────────

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
// Local anvil is the only default; real networks must come from .env (CLAUDE.md §7).
const RPC_URL = CHAIN_ID === 31337 ? (env("RPC_URL") ?? "http://127.0.0.1:8545") : need("RPC_URL");
const KEEPER_PK = need("KEEPER_PK") as Hex;
const DEPLOYMENTS = env("DEPLOYMENTS") ?? fileURLToPath(new URL(`../../../deployments/${CHAIN_ID}.json`, import.meta.url));
const HEALTH_PORT = Number(env("HEALTH_PORT") ?? "8787");
const PYTH_API_KEY = env("PYTH_API_KEY");
const HERMES_URL = env("HERMES_URL") ?? DEFAULT_HERMES_URL;
const PYTH_FEED_ID = env("PYTH_MON_USD_FEED_ID") as Hex | undefined;

// Keeper-fed test oracle (Phase 3 step 2b): heartbeat 10 s against the oracle's maxStaleness 60 s (R24 fallback value).
const MAINNET_RPC_URL = env("MONAD_RPC_URL"); // mainnet Pyth read-only; unset ⇒ Hyperliquid fallback only
const FEED_HEARTBEAT_SEC = BigInt(env("FEED_HEARTBEAT_SEC") ?? "10");
const FEED_MAX_SOURCE_AGE_SEC = BigInt(env("FEED_MAX_SOURCE_AGE_SEC") ?? "60");
const PRICE_FACTOR_FILE = env("PRICE_FACTOR_FILE"); // demo market only: "0.85" in this file ⇒ push 85% of the source

// Vault rebalances (WS-04), behind a flag. VAULT_ROUTE=flow (mainnet, Phase 5 B4): the spot leg goes through a Kuru
// Flow route (src/kuruflow.ts: documented schema, amount read from a debug_traceCall of the vault, target checked);
// "direct" (default) sends rebalance() with the empty route (testnet MockKuruHedger / a live direct Kuru market).
const VAULT_REBALANCE = env("VAULT_REBALANCE") === "1";
const VAULT_ROUTE = env("VAULT_ROUTE") ?? "direct";
const KURU_FLOW_HAIRCUT_BPS = BigInt(env("KURU_FLOW_HAIRCUT_BPS") ?? "10"); // quote 0.1% under the vault's amount
const KURU_FLOW_SLIPPAGE_BPS = Number(env("KURU_FLOW_SLIPPAGE_BPS") ?? "50"); // advisory; the vault's minOut binds
const VAULT_EVERY_BLOCKS = BigInt(env("VAULT_EVERY_BLOCKS") ?? "20");

const MAX_FUNDING_GAP_BLOCKS = BigInt(env("MAX_FUNDING_GAP_BLOCKS") ?? "20"); // WS-03 acceptance
// Blocks between reading a block and our tx landing. Default per chain (decide.ts defaultInclusionLag): 6 on
// 10143 (30 Sep: pokes landed 3–4 blocks after the decision), 2 elsewhere (the Phase 3 rehearsal with 1 showed
// 109 gaps of 21 blocks). Tunable per network.
const INCLUSION_LAG_BLOCKS = BigInt(env("INCLUSION_LAG_BLOCKS") ?? String(defaultInclusionLag(CHAIN_ID)));
// Incremental liquidation scan (Phase 4 step 1): full sweep every N blocks and for a few blocks after every oracle push.
const FULL_SWEEP_EVERY_BLOCKS = BigInt(env("FULL_SWEEP_EVERY_BLOCKS") ?? "50");
const SWEEP_AFTER_PUSH_BLOCKS = BigInt(env("SWEEP_AFTER_PUSH_BLOCKS") ?? "4");
const SOURCE_POLL_MS = Number(env("SOURCE_POLL_MS") ?? "1000"); // external price source read at most every 1 s
const BALANCE_EVERY_BLOCKS = BigInt(env("BALANCE_EVERY_BLOCKS") ?? "100");
const BURN_WINDOW_MS = 30 * 60_000; // monPerHour over the last 30 min
const PYTH_MAX_AGE_SEC = 3n; // LANE_B §4
const PYTH_MAX_MOVE_BPS = 5n; // LANE_B §4
const MAX_LIQUIDATIONS_PER_BLOCK = 5;
const READ_BATCH = 20; // concurrent getAccount calls (public RPC: 25 rps, R2)
const LOG_SPAN = BigInt(env("LOG_SPAN") ?? "100"); // public RPC eth_getLogs cap (ARCHITECTURE R2); Alchemy free tier: 10
const LOOKBACK_BLOCKS = BigInt(env("LOOKBACK_BLOCKS") ?? "10000"); // initial PositionChanged scan when startBlock is far back
const MIN_KEEPER_BALANCE = 5n * 10n ** 18n; // alert < 5 MON (TEAM_PLAN §7)
const HEALTH_MAX_SILENCE_MS = 30_000;

type OracleKind = "pyth" | "keeper-fed" | "mock";
interface MarketDeployment {
  ClearingHouse?: Address;
  OracleAdapter?: Address;
}
interface Deployments {
  chainId: number;
  startBlock: number;
  deployed?: boolean;
  /** Oracle of the main market (DeployMeridian); absent on anvil (mock oracle). */
  oracleKind?: OracleKind;
  contracts: MarketDeployment & { MeridianVault?: Address; FundingSwapMarket?: Address; SwapOrderBook?: Address };
  /** MON-PERP-DEMO: separate OB + CH with a keeper-fed test oracle, used only for the crash/liquidation demo. */
  demoMarket?: MarketDeployment & { symbol: string; testMarket: true; oracleKind: OracleKind };
}
const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments;
if (dep.chainId !== CHAIN_ID) throw new Error(`deployments chainId ${dep.chainId} != CHAIN_ID ${CHAIN_ID}`);
const MARKET = env("MARKET") ?? "main";
const market = MARKET === "demo" ? dep.demoMarket : dep.contracts;
if (market === undefined) throw new Error(`MARKET=${MARKET}: no demoMarket in ${DEPLOYMENTS}`);
if (dep.deployed === false || market.ClearingHouse === undefined || market.OracleAdapter === undefined) {
  throw new Error(`${DEPLOYMENTS}: market ${MARKET} is not deployed`);
}
const CH: Address = market.ClearingHouse;
const ORACLE: Address = market.OracleAdapter;
const ORACLE_KIND: OracleKind =
  (env("ORACLE_KIND") as OracleKind | undefined) ?? (MARKET === "demo" ? dep.demoMarket?.oracleKind : dep.oracleKind) ?? "pyth";
if (PRICE_FACTOR_FILE !== undefined && MARKET !== "demo") throw new Error("PRICE_FACTOR_FILE is only allowed with MARKET=demo");
const SWAP: Address | undefined = MARKET === "main" && env("SWAP_DUTIES") !== "0" ? dep.contracts.FundingSwapMarket : undefined;
const SWAP_FULL_EVERY_BLOCKS = BigInt(env("SWAP_FULL_EVERY_BLOCKS") ?? "10");
// Size-bounded swap liquidation (the keeper takes the position and must pass IM afterwards); default = whole position.
// B-01 (PHASES 18): touch the swap market every N quiet blocks while an account is near MM, so the bounded mark keeps
// converging (20 = the contract's MARK_MAX_ELAPSED_BLOCKS ⇒ full 0.5 APR pt/block); 0 disables.
const SWAP_MARK_POKE_EVERY_BLOCKS = BigInt(env("SWAP_MARK_POKE_EVERY_BLOCKS") ?? "20");
const SWAP_LIQ_MAX_SIZE = env("SWAP_LIQ_MAX_SIZE_WAD") === undefined ? maxUint256 : BigInt(env("SWAP_LIQ_MAX_SIZE_WAD") as string);
const SCAN_EVENTS = [...clearingHouseAbi, ...oracleAdapterAbi, ...fundingSwapAbi].filter(
  (x): x is Extract<(typeof clearingHouseAbi)[number] | (typeof oracleAdapterAbi)[number] | (typeof fundingSwapAbi)[number], { type: "event" }> =>
    x.type === "event",
);
const SCAN_ADDRESSES: Address[] = SWAP === undefined ? [CH, ORACLE] : [CH, ORACLE, SWAP];

// ───────────────────────────── clients ─────────────────────────────

const chain = defineChain({
  id: CHAIN_ID,
  name: `meridian-${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(KEEPER_PK, { nonceManager });
const rpcStats = newRpcStats();
const rpcRate = new RateWindow(60_000);
// Every request is counted (rpcCallsPerMin) and 429/5xx are retried with jittered back-off (viem's own retry off).
const fetchFn = createCountingFetch({ stats: rpcStats, onCall: (m) => rpcRate.add(Date.now(), Math.max(1, m.length)) });
const transport = http(RPC_URL, { fetchFn, retryCount: 0 });
// New-block polling (eth_blockNumber) is the largest remaining RPC cost (~240/min at 250 ms, 30 Sep rehearsal); 250 ms
// still sees every 300–400 ms Monad block. Raise it only if liquidation latency may grow by the same amount.
const POLL_MS = Number(env("POLL_MS") ?? "250");
const pub = createPublicClient({ chain, transport, pollingInterval: POLL_MS });
const wallet = createWalletClient({ chain, account, transport });
// Read-only price source: short timeout, no retries (a slow public RPC must fail fast; the push just waits a tick).
const mainnet =
  MAINNET_RPC_URL === undefined ? null : createPublicClient({ transport: http(MAINNET_RPC_URL, { timeout: 2_000, retryCount: 0 }) });

// ───────────────────────────── state ─────────────────────────────

const health = {
  startedAt: Date.now(),
  lastTickAt: 0,
  lastBlock: 0n,
  lastFundingPokeBlock: 0n,
  fundingPokes: 0,
  liquidations: 0,
  pythPushes: 0,
  feedPushes: 0,
  vaultRebalances: 0,
  lastFeedSource: "",
  openPositions: 0,
  liquidationLatency: new LiquidationLatency().summary(),
  errors: 0,
  lastError: "",
  // Phase 4 step 1
  accountReads: 0,
  fullSweeps: 0,
  maxFundingGapBlocks: 0n, // observed from FundingUpdated logs since start
  lastFundingUpdateBlock: -1n,
  monPerHour: null as string | null, // balance decrease over the last 30 min, scaled to 1 h
  // Phase 4 step 2 (funding swaps)
  swapMarket: SWAP ?? null,
  swapTracked: 0,
  swapAccountReads: 0,
  swapLiquidations: 0,
  swapMarkPokes: 0,
  swapLiquidationLatency: new LiquidationLatency().summary(),
  maturity: 0n,
  maturitySettled: false, // snapshot exists (ours or lazy)
  maturitySettledByKeeper: false,
};
const swapTracked = new Set<Address>();
let swapChanged = new Set<Address>();
const swapHot = new Set<Address>();
let swapLastFull = -1n;
const swapLatency = new LiquidationLatency();
let swapLastTouch = -1n; // last block the swap market was touched (B-01 mark poke)
let maturityPending = false;
// chain time ≈ local time + offset (refreshed from a block read every CLOCK_EVERY_BLOCKS): the maturity pre-check must
// not trust the local clock (skew; anvil evm_increaseTime in the rehearsal).
let clockOffsetSec = 0n;
let clockReadBlock = -1n;
const CLOCK_EVERY_BLOCKS = 300n;
const localSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));
let open = new Set<Address>();
let changed = new Set<Address>(); // PositionChanged since the last liquidation check
const checked = new Map<Address, CheckedAccount>();
let lastFullSweepBlock = -1n;
let lastPushBlock = -1n; // block of the newest oracle PriceUpdated seen
let lastUpdateBlock = -1n; // newest FundingUpdated block seen (bootstrapped from fundingState())
let onchainPrice: PricePoint | null = null; // newest oracle point (PriceUpdated logs / our pushes / bootstrap read)
let source: SourcedPrice | null = null;
let sourceReadMs = -1;
let balances: BalanceSample[] = [];
const latency = new LiquidationLatency();
let scannedTo = -1n;
let firstTickBlock = -1n;
let busy = false;
let oracleBusy = false;

const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const alert = (msg: string, extra: Record<string, unknown> = {}): void => log(`ALERT ${msg}`, extra); // TODO(WS-03 D11): route to pager

// ───────────────────────────── actions ─────────────────────────────

/**
 * Estimate (reverts ⇒ throws, nothing mined), then send with limit = estimate × 1.2 (Monad bills the limit, R6).
 * @returns the block the tx landed in if it succeeded, else null
 */
async function send(label: string, to: Address, data: Hex, value = 0n): Promise<bigint | null> {
  const est = await pub.estimateGas({ account, to, data, value });
  const gas = gasLimitFor(est);
  const hash = await wallet.sendTransaction({ to, data, value, gas });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 10_000 });
  log(label, { hash, block: rcpt.blockNumber, status: rcpt.status, gasUsed: rcpt.gasUsed, gasLimit: gas });
  return rcpt.status === "success" ? rcpt.blockNumber : null;
}

/** Demo crash lever: the factor file's decimal (e.g. "0.85"), 1.0 when absent. */
function priceFactor(): bigint {
  if (PRICE_FACTOR_FILE === undefined || !existsSync(PRICE_FACTOR_FILE)) return WAD_ONE;
  const f = decimalToWad(readFileSync(PRICE_FACTOR_FILE, "utf8"));
  if (f === null) throw new Error(`bad factor in ${PRICE_FACTOR_FILE}`);
  return f;
}
const WAD_ONE = 10n ** 18n;

/** Keeper-fed TestnetKeeperOracle: same push rule as Pyth (older than the heartbeat, or moved > 5 bps). */
async function feedStep(): Promise<void> {
  if (PYTH_FEED_ID === undefined) throw new Error("missing env PYTH_MON_USD_FEED_ID (mainnet Pyth source)");
  const nowMs = Date.now();
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  // The source publishes every 10–30 s: read it at most every SOURCE_POLL_MS, not every 0.3 s block.
  if (shouldReadSource(nowMs, sourceReadMs, SOURCE_POLL_MS)) {
    sourceReadMs = nowMs;
    const src = await latestKeylessPrice(mainnet, PYTH_FEED_ID, nowSec, FEED_MAX_SOURCE_AGE_SEC);
    if (src === null) alert("no usable price source: the test oracle will go stale");
    source = src;
  }
  if (source === null) return;
  if (onchainPrice === null) onchainPrice = await readOnchainPrice();
  // Decide on the local clock (no block read per tick); the demo's publish time is re-derived from the chain below.
  const reason = shouldPushPyth({
    nowSec,
    onchain: onchainPrice,
    offchain: feedPoint(source, priceFactor(), nowSec, MARKET === "demo"),
    maxAgeSec: FEED_HEARTBEAT_SEC,
    maxMoveBps: PYTH_MAX_MOVE_BPS,
  });
  if (reason === null) return;
  const block = await pub.getBlock({ blockTag: "latest" });
  const point = feedPoint(source, priceFactor(), block.timestamp, MARKET === "demo");
  if (point.publishTime < onchainPrice.publishTime) return; // never push an older observation (the oracle reverts)
  const data = encodeFunctionData({ abi: oracleAdapterAbi, functionName: "updatePrice", args: [encodeTestOracleUpdate(point)] });
  if ((await send(`feed push (${reason}, ${source.source})`, ORACLE, data)) !== null) {
    health.feedPushes++;
    health.lastFeedSource = source.source;
    onchainPrice = point;
  }
}

async function readOnchainPrice(): Promise<PricePoint> {
  const [, priceWad, publishTime] = await pub.readContract({ address: ORACLE, abi: oracleAdapterAbi, functionName: "tryGetIndexPrice" });
  return { priceWad, publishTime };
}

async function oracleStep(): Promise<void> {
  if (ORACLE_KIND === "keeper-fed") return feedStep();
  if (ORACLE_KIND === "pyth") return pythStep();
  // "mock" (anvil): the smoke scripts move the price
}

async function pythStep(): Promise<void> {
  if (PYTH_API_KEY === undefined || PYTH_FEED_ID === undefined) return; // sponsored push only (R24)
  const [hermes, onchain, block] = await Promise.all([
    fetchHermesLatest(HERMES_URL, PYTH_API_KEY, PYTH_FEED_ID),
    pub.readContract({ address: ORACLE, abi: oracleAdapterAbi, functionName: "tryGetIndexPrice" }),
    pub.getBlock({ blockTag: "latest" }),
  ]);
  const [, priceWad, updatedAt] = onchain;
  const reason = shouldPushPyth({
    nowSec: block.timestamp,
    onchain: { priceWad, publishTime: updatedAt },
    offchain: hermes.point,
    maxAgeSec: PYTH_MAX_AGE_SEC,
    maxMoveBps: PYTH_MAX_MOVE_BPS,
  });
  if (reason === null) return;
  const fee = await pub.readContract({ address: ORACLE, abi: oracleAdapterAbi, functionName: "updateFee", args: [hermes.updateData] });
  if ((await send(`pyth push (${reason})`, ORACLE, encodeFunctionData({ abi: oracleAdapterAbi, functionName: "updatePrice", args: [hermes.updateData] }), fee)) !== null) {
    health.pythPushes++;
  }
}

/**
 * The one eth_getLogs of the tick (chunked by LOG_SPAN): CH PositionChanged + FundingUpdated and oracle PriceUpdated
 * over (scannedTo, block]. Updates the open set, the changed set, the last funding update (+ observed gaps) and the
 * last oracle push. If it throws, `scannedTo` stays behind and the funding step reads fundingState() instead.
 */
async function scanStep(block: bigint): Promise<void> {
  if (scannedTo < 0n) {
    const floor = block > LOOKBACK_BLOCKS ? block - LOOKBACK_BLOCKS : 0n;
    const start = BigInt(dep.startBlock);
    scannedTo = (start > floor ? start : floor) - 1n;
  }
  for (const [fromBlock, toBlock] of blockRanges(scannedTo + 1n, block, LOG_SPAN)) {
    const logs = await pub.getLogs({ address: SCAN_ADDRESSES, events: SCAN_EVENTS, fromBlock, toBlock, strict: true });
    const pos: Array<{ account: Address; newSize: bigint }> = [];
    const fundingBlocks: bigint[] = [];
    for (const l of logs) {
      const fromCh = l.address.toLowerCase() === CH.toLowerCase();
      if (fromCh && l.eventName === "PositionChanged") {
        pos.push({ account: l.args.account, newSize: l.args.newSize });
        changed.add(l.args.account.toLowerCase() as Address);
      } else if (fromCh && l.eventName === "FundingUpdated") {
        fundingBlocks.push(l.blockNumber);
      } else if (l.eventName === "SwapPositionChanged") {
        const a = l.args.account.toLowerCase() as Address;
        swapTracked.add(a); // tracked until a read proves it inert (newSize 0 may still carry a K stream)
        swapChanged.add(a);
        if (l.blockNumber !== null && l.blockNumber > swapLastTouch) swapLastTouch = l.blockNumber;
      } else if (l.eventName === "MaturitySettled") {
        health.maturitySettled = true;
        maturityPending = false;
      } else if (!fromCh && l.eventName === "PriceUpdated") {
        if (l.blockNumber > lastPushBlock) lastPushBlock = l.blockNumber;
        if (onchainPrice === null || l.args.publishTime >= onchainPrice.publishTime) {
          onchainPrice = { priceWad: l.args.priceWad, publishTime: l.args.publishTime };
        }
      }
    }
    open = applyPositionChanges(open, pos);
    // Observed gaps count only between updates since the keeper's first tick (not the history of the initial scan).
    const gap = observedMaxGap(lastUpdateBlock, firstTickBlock, fundingBlocks);
    if (gap > health.maxFundingGapBlocks) health.maxFundingGapBlocks = gap;
    lastUpdateBlock = fundingGaps(lastUpdateBlock, fundingBlocks).last;
    health.lastFundingUpdateBlock = lastUpdateBlock;
    scannedTo = toBlock;
  }
  health.openPositions = open.size;
}

async function fundingStep(block: bigint): Promise<void> {
  // lastUpdateBlock comes from the shared log scan; a fundingState() read only if the scan is behind (it failed).
  let last = lastUpdateBlock;
  if (scannedTo < block || last < 0n) {
    last = (await pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "fundingState", blockNumber: block })).lastUpdateBlock;
  }
  const poke = shouldPokeFunding({
    currentBlock: block,
    lastUpdateBlock: last,
    maxGapBlocks: MAX_FUNDING_GAP_BLOCKS,
    inclusionLagBlocks: INCLUSION_LAG_BLOCKS,
  });
  if (!poke) return;
  const landed = await send("funding poke", CH, encodeFunctionData({ abi: clearingHouseAbi, functionName: "updateFunding" }));
  if (landed !== null) {
    health.fundingPokes++;
    health.lastFundingPokeBlock = block;
    if (landed > lastUpdateBlock && scannedTo >= lastUpdateBlock) {
      // the next scan sees this FundingUpdated too; recording it now stops a second poke before that scan runs
      const gap = observedMaxGap(lastUpdateBlock, firstTickBlock, [landed]);
      if (gap > health.maxFundingGapBlocks) health.maxFundingGapBlocks = gap;
      lastUpdateBlock = fundingGaps(lastUpdateBlock, [landed]).last;
    }
  }
}

async function liquidationStep(block: bigint): Promise<void> {
  if (open.size === 0) return;
  for (const a of [...checked.keys()]) if (!open.has(a)) checked.delete(a);
  const markWad = await pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "markPrice", blockNumber: block });
  const pick = accountsToCheck({
    block,
    open,
    changed,
    checked,
    markWad,
    lastFullSweepBlock,
    fullSweepEvery: FULL_SWEEP_EVERY_BLOCKS,
    forceFull: forceSweepAfterPush(block, lastPushBlock, SWEEP_AFTER_PUSH_BLOCKS),
  });
  changed = new Set();
  if (pick.full) {
    lastFullSweepBlock = block;
    health.fullSweeps++;
  }
  if (pick.accounts.length === 0) return;
  // Plain eth_calls in bounded batches: no Multicall3 dependency (address not in ARCHITECTURE §Research).
  const snaps: AccountSnapshot[] = [];
  for (let i = 0; i < pick.accounts.length; i += READ_BATCH) {
    const batch = pick.accounts.slice(i, i + READ_BATCH);
    const views = await Promise.allSettled(
      batch.map((a) => pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "getAccount", args: [a], blockNumber: block })),
    );
    health.accountReads += batch.length;
    views.forEach((r, j) => {
      const a = batch[j];
      if (a === undefined) return;
      if (r.status !== "fulfilled") {
        changed.add(a); // retry next block
        return;
      }
      const v = r.value;
      const s = { account: a, size: v.size, equity: v.equity, maintenanceMargin: v.maintenanceMargin, liquidatable: v.liquidatable };
      snaps.push(s);
      checked.set(a, checkedFrom(s, markWad));
    });
  }
  // Every eligible account is re-read each block (headroom ≤ 0 ⇒ needsRecheck), so the latency tracker sees it.
  latency.observe(block, snaps.filter(isLiquidationCandidate).map((s) => s.account));
  // The liquidator takes over the position and must hold margin in this market (IClearingHouse.liquidate).
  for (const s of selectLiquidations(snaps, MAX_LIQUIDATIONS_PER_BLOCK, account.address)) {
    try {
      const landed = await send("liquidate", CH, encodeFunctionData({ abi: clearingHouseAbi, functionName: "liquidate", args: [s.account, maxUint256] }));
      if (landed !== null) {
        health.liquidations++;
        // B7: blocks from first seen eligible to landed (target ≤ 3)
        log("liquidation latency", { account: s.account, firstSeen: latency.firstSeen(s.account), landed, blocks: latency.liquidated(s.account, landed) });
        health.liquidationLatency = latency.summary();
      }
    } catch (e) {
      fail(`liquidate ${s.account}`, e); // someone else got there first, or margin moved: keep going
    }
    changed.add(s.account.toLowerCase() as Address);
  }
}

async function swapLiquidationStep(block: bigint): Promise<void> {
  if (SWAP === undefined || swapTracked.size === 0) return;
  const pick = swapAccountsToCheck({ block, tracked: swapTracked, changed: swapChanged, hot: swapHot, lastFullBlock: swapLastFull, fullEvery: SWAP_FULL_EVERY_BLOCKS });
  swapChanged = new Set();
  if (pick.full) swapLastFull = block;
  const snaps: SwapSnapshot[] = [];
  for (let i = 0; i < pick.accounts.length; i += READ_BATCH) {
    const batch = pick.accounts.slice(i, i + READ_BATCH);
    const views = await Promise.allSettled(
      batch.map((a) => pub.readContract({ address: SWAP, abi: fundingSwapAbi, functionName: "getAccount", args: [a], blockNumber: block })),
    );
    health.swapAccountReads += batch.length;
    views.forEach((r, j) => {
      const a = batch[j];
      if (a === undefined) return;
      if (r.status !== "fulfilled") {
        swapChanged.add(a);
        return;
      }
      const v = r.value;
      const s: SwapSnapshot = { account: a, size: v.size, unrealizedPnl: v.unrealizedPnl, equity: v.equity, maintenanceMargin: v.maintenanceMargin, liquidatable: v.liquidatable };
      snaps.push(s);
      if (swapIsHot(s)) swapHot.add(a);
      else swapHot.delete(a);
      if (swapAccountIsInert(s) && v.collateral === 0n) swapTracked.delete(a);
    });
  }
  health.swapTracked = swapTracked.size;
  swapLatency.observe(block, snaps.filter((s) => s.liquidatable).map((s) => s.account));
  for (const s of swapLiquidationCandidates(snaps, MAX_LIQUIDATIONS_PER_BLOCK, account.address)) {
    try {
      const data = encodeFunctionData({ abi: fundingSwapAbi, functionName: "liquidate", args: [s.account, SWAP_LIQ_MAX_SIZE] });
      const landed = await send("swap liquidate", SWAP, data);
      if (landed !== null) {
        health.swapLiquidations++;
        log("swap liquidation latency", { account: s.account, firstSeen: swapLatency.firstSeen(s.account), landed, blocks: swapLatency.liquidated(s.account, landed) });
        health.swapLiquidationLatency = swapLatency.summary();
      }
    } catch (e) {
      fail(`swap liquidate ${s.account}`, e); // someone else first, or the keeper lacks swap-market margin (RUNBOOK)
    }
    swapChanged.add(s.account);
    swapTracked.add(account.address.toLowerCase() as Address); // the keeper now holds (part of) the position
  }
  if (shouldPokeSwapMark({ block, anyHot: swapHot.size > 0, lastTouchBlock: swapLastTouch, everyBlocks: SWAP_MARK_POKE_EVERY_BLOCKS })) {
    swapLastTouch = block; // one attempt per window, landed or not
    try {
      const landed = await send("swap mark poke", SWAP, encodeFunctionData({ abi: fundingSwapAbi, functionName: "settle", args: [account.address] }));
      if (landed !== null) health.swapMarkPokes++;
    } catch (e) {
      fail("swap mark poke", e);
    }
  }
}

async function readClock(block: bigint): Promise<void> {
  const blk = await pub.getBlock({ blockNumber: block });
  clockOffsetSec = blk.timestamp - localSec();
  clockReadBlock = block;
}

/** settleMaturity() exactly once: at/after maturity, no snapshot yet (a trade may have taken it lazily), none pending. */
async function maturityStep(): Promise<void> {
  if (SWAP === undefined || health.maturitySettled || maturityPending) return;
  if (localSec() + clockOffsetSec + 2n < health.maturity) return; // chain-clock pre-check: no block read per tick
  const blk = await pub.getBlock({ blockTag: "latest" });
  clockOffsetSec = blk.timestamp - localSec();
  if (!shouldSettleMaturity({ nowSec: blk.timestamp, maturity: health.maturity, snapped: health.maturitySettled, pending: maturityPending })) return;
  maturityPending = true;
  try {
    const landed = await send("settleMaturity", SWAP, encodeFunctionData({ abi: fundingSwapAbi, functionName: "settleMaturity" }));
    if (landed !== null) {
      health.maturitySettled = true;
      health.maturitySettledByKeeper = true;
    }
  } finally {
    maturityPending = false;
  }
}

async function vaultStep(block: bigint): Promise<void> {
  const v = dep.contracts.MeridianVault;
  if (!VAULT_REBALANCE || MARKET !== "main" || v === undefined) return;
  // Read every VAULT_EVERY_BLOCKS, and right after an oracle push (MarginLow can only follow a price move).
  if (!shouldCheckVault(block, VAULT_EVERY_BLOCKS, forceSweepAfterPush(block, lastPushBlock, SWEEP_AFTER_PUSH_BLOCKS))) return;
  const reason = await pub.readContract({ address: v, abi: meridianVaultAbi, functionName: "needsRebalance" });
  const a = vaultAction(reason);
  if (!a.act) return;
  const data =
    VAULT_ROUTE === "flow"
      ? await flowRebalanceData(v)
      : encodeFunctionData({ abi: meridianVaultAbi, functionName: "rebalance" });
  if ((await send(`vault rebalance (${a.name}, ${VAULT_ROUTE})`, v, data)) !== null) {
    health.vaultRebalances++;
  }
}

let flow: FlowClient | undefined;
let hedgerWiring: { hedger: Address; entry: Address; base: Address; quote: Address } | undefined;

/** rebalanceWithRoute calldata: the vault's exact spot amount from a trace, a Kuru Flow quote for it (− haircut). */
async function flowRebalanceData(v: Address): Promise<Hex> {
  if (hedgerWiring === undefined) {
    const hedger = await pub.readContract({ address: v, abi: meridianVaultAbi, functionName: "hedger" });
    const [entry, base, quote] = await Promise.all([
      pub.readContract({ address: hedger, abi: kuruHedgerAbi, functionName: "flowEntrypoint" }),
      pub.readContract({ address: hedger, abi: kuruHedgerAbi, functionName: "baseToken" }),
      pub.readContract({ address: hedger, abi: kuruHedgerAbi, functionName: "quoteToken" }),
    ]);
    hedgerWiring = { hedger, entry, base, quote };
  }
  const w = hedgerWiring;
  flow ??= new FlowClient(fetch as never, w.hedger, { staticJwt: env("KURU_FLOW_JWT"), apiKey: env("KURU_API_KEY") });
  const probe = encodeFunctionData({ abi: meridianVaultAbi, functionName: "rebalanceWithRoute", args: ["0x00"] });
  const trace = (await pub.request({
    method: "debug_traceCall" as never,
    params: [{ from: account.address, to: v, data: probe }, "latest", { tracer: "callTracer" }] as never,
  })) as CallFrame;
  const r = routeAmount(findHedgerCalls(trace, w.hedger), KURU_FLOW_HAIRCUT_BPS);
  // no spot leg in this rebalance (e.g. MarginLow topped up from idle): the empty route is never used
  if (r === null) return encodeFunctionData({ abi: meridianVaultAbi, functionName: "rebalance" });
  const [tokenIn, tokenOut] = r.kind === "buy" ? [w.quote, w.base] : [w.base, w.quote];
  const q = await flow.quote(quoteRequest({ hedger: w.hedger, tokenIn, tokenOut, amountIn: r.amountIn, slippageBps: KURU_FLOW_SLIPPAGE_BPS }));
  const route = parseQuote(q, w.entry);
  log("kuru flow route", { kind: r.kind, amountIn: r.amountIn, expectedOut: route.expectedOut, bytes: (route.data.length - 2) / 2 });
  return encodeFunctionData({ abi: meridianVaultAbi, functionName: "rebalanceWithRoute", args: [route.data] });
}

async function balanceStep(): Promise<void> {
  const bal = await pub.getBalance({ address: account.address });
  const now = Date.now();
  balances = pruneSamples([...balances, { tMs: now, wei: bal }], now, BURN_WINDOW_MS);
  const burn = burnPerHourWei(balances);
  health.monPerHour = burn === null ? null : formatEther(burn);
  if (bal < MIN_KEEPER_BALANCE) alert("keeper balance low", { balance: formatEther(bal) });
}

function fail(step: string, e: unknown): void {
  health.errors++;
  health.lastError = `${step}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  log("error", { step, error: health.lastError });
}

async function tick(block: bigint): Promise<void> {
  if (busy) return; // never overlap ticks; the next block retries
  busy = true;
  try {
    health.lastBlock = block;
    if (firstTickBlock < 0n) firstTickBlock = block;
    // One log scan shared by every step. Then liquidations first (latency-critical, ≤ 3 blocks), then the funding
    // poke (any liquidation already touched F). The oracle push runs on its own loop (oracleTick): the Phase 3
    // rehearsal showed a stalled external price read blocking a whole tick for 56 s.
    await scanStep(block).catch((e: unknown) => fail("scan", e));
    const steps: Array<[string, () => Promise<void>]> = [
      ["liquidation", () => (scannedTo >= block ? liquidationStep(block) : Promise.resolve())],
      ["funding", () => fundingStep(block)],
      ["swap liquidation", () => (scannedTo >= block ? swapLiquidationStep(block) : Promise.resolve())],
      ["maturity", () => maturityStep()],
      ["clock", () => (SWAP !== undefined && (clockReadBlock < 0n || block - clockReadBlock >= CLOCK_EVERY_BLOCKS) ? readClock(block) : Promise.resolve())],
      ["vault", () => vaultStep(block)],
    ];
    for (const [name, fn] of steps) await fn().catch((e: unknown) => fail(name, e));
    if (block % BALANCE_EVERY_BLOCKS === 0n) await balanceStep().catch((e: unknown) => fail("balance", e));
    health.lastTickAt = Date.now();
  } finally {
    busy = false;
  }
}

/** Oracle pushes on their own non-overlapping loop: never delay liquidations or funding pokes. */
async function oracleTick(): Promise<void> {
  if (oracleBusy) return;
  oracleBusy = true;
  try {
    await oracleStep().catch((e: unknown) => fail("oracle", e));
  } finally {
    oracleBusy = false;
  }
}

// ───────────────────────────── main ─────────────────────────────

createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  const ok = Date.now() - health.lastTickAt < HEALTH_MAX_SILENCE_MS;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  const rpc = { rpcCalls: rpcStats.calls, rpcCallsPerMin: rpcRate.perMinute(Date.now()), rpcErrors: rpcStats.errors, rpcRateLimited: rpcStats.rateLimited, rpcRetries: rpcStats.retries, rpcByMethod: rpcStats.byMethod };
  res.end(JSON.stringify({ ok, keeper: account.address, ...health, ...rpc }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}).listen(HEALTH_PORT);

log("keeper start", {
  chainId: CHAIN_ID,
  market: MARKET,
  clearingHouse: CH,
  oracle: ORACLE,
  oracleKind: ORACLE_KIND,
  keeper: account.address,
  pyth: PYTH_API_KEY !== undefined,
  mainnetSource: MAINNET_RPC_URL !== undefined,
  health: HEALTH_PORT,
  inclusionLagBlocks: INCLUSION_LAG_BLOCKS,
  fullSweepEveryBlocks: FULL_SWEEP_EVERY_BLOCKS,
  logSpan: LOG_SPAN,
});
await balanceStep().catch((e: unknown) => fail("balance", e));
if (SWAP !== undefined) {
  health.maturity = await pub.readContract({ address: SWAP, abi: fundingSwapAbi, functionName: "maturity" });
  const [snapped] = await pub.readContract({ address: SWAP, abi: fundingSwapImplAbi, functionName: "maturitySnapshot" });
  health.maturitySettled = snapped;
  log("swap duties on", { swapMarket: SWAP, maturity: health.maturity, snapped, fullEveryBlocks: SWAP_FULL_EVERY_BLOCKS });
}
pub.watchBlockNumber({
  emitOnBegin: true,
  onBlockNumber: (b) => {
    void oracleTick();
    void tick(b);
  },
  onError: (e) => fail("watchBlockNumber", e),
});
