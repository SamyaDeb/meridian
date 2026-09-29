// Thin RPC wiring for the Pulse TS fallback keeper. All decisions live in decide.ts (pure, unit-tested).
// Per block: (a) Pyth push (only with PYTH_API_KEY), (b) funding poke, (c) perp liquidations.
// Next (LANE_B §4): swap-market liquidations, settleMaturity, vault rebalanceWithRoute.
import { readFileSync } from "node:fs";
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
import { clearingHouseAbi, oracleAdapterAbi } from "./abi.js";
import {
  type AccountSnapshot,
  applyPositionChanges,
  isLiquidationCandidate,
  blockRanges,
  gasLimitFor,
  selectLiquidations,
  shouldPokeFunding,
  shouldPushPyth,
} from "./decide.js";
import { DEFAULT_HERMES_URL, fetchHermesLatest } from "./hermes.js";
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

const MAX_FUNDING_GAP_BLOCKS = BigInt(env("MAX_FUNDING_GAP_BLOCKS") ?? "20"); // WS-03 acceptance
const INCLUSION_LAG_BLOCKS = 1n;
const PYTH_MAX_AGE_SEC = 3n; // LANE_B §4
const PYTH_MAX_MOVE_BPS = 5n; // LANE_B §4
const MAX_LIQUIDATIONS_PER_BLOCK = 5;
const READ_BATCH = 20; // concurrent getAccount calls (public RPC: 25 rps, R2)
const LOG_SPAN = 100n; // public RPC eth_getLogs cap (ARCHITECTURE R2)
const LOOKBACK_BLOCKS = BigInt(env("LOOKBACK_BLOCKS") ?? "10000"); // initial PositionChanged scan when startBlock is far back
const MIN_KEEPER_BALANCE = 5n * 10n ** 18n; // alert < 5 MON (TEAM_PLAN §7)
const HEALTH_MAX_SILENCE_MS = 30_000;

interface Deployments {
  chainId: number;
  startBlock: number;
  contracts: { ClearingHouse: Address; OracleAdapter: Address };
}
const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments;
if (dep.chainId !== CHAIN_ID) throw new Error(`deployments chainId ${dep.chainId} != CHAIN_ID ${CHAIN_ID}`);
const CH = dep.contracts.ClearingHouse;
const ORACLE = dep.contracts.OracleAdapter;

// ───────────────────────────── clients ─────────────────────────────

const chain = defineChain({
  id: CHAIN_ID,
  name: `pulse-${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(KEEPER_PK, { nonceManager });
const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 250 });
const wallet = createWalletClient({ chain, account, transport: http(RPC_URL) });

// ───────────────────────────── state ─────────────────────────────

const health = {
  startedAt: Date.now(),
  lastTickAt: 0,
  lastBlock: 0n,
  lastFundingPokeBlock: 0n,
  fundingPokes: 0,
  liquidations: 0,
  pythPushes: 0,
  openPositions: 0,
  liquidationLatency: new LiquidationLatency().summary(),
  errors: 0,
  lastError: "",
};
let open = new Set<Address>();
const latency = new LiquidationLatency();
let scannedTo = -1n;
let busy = false;

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

async function fundingStep(block: bigint): Promise<void> {
  const fs = await pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "fundingState", blockNumber: block });
  const poke = shouldPokeFunding({
    currentBlock: block,
    lastUpdateBlock: fs.lastUpdateBlock,
    maxGapBlocks: MAX_FUNDING_GAP_BLOCKS,
    inclusionLagBlocks: INCLUSION_LAG_BLOCKS,
  });
  if (!poke) return;
  if ((await send("funding poke", CH, encodeFunctionData({ abi: clearingHouseAbi, functionName: "updateFunding" }))) !== null) {
    health.fundingPokes++;
    health.lastFundingPokeBlock = block;
  }
}

async function scanPositions(block: bigint): Promise<void> {
  if (scannedTo < 0n) {
    const floor = block > LOOKBACK_BLOCKS ? block - LOOKBACK_BLOCKS : 0n;
    const start = BigInt(dep.startBlock);
    scannedTo = (start > floor ? start : floor) - 1n;
  }
  for (const [fromBlock, toBlock] of blockRanges(scannedTo + 1n, block, LOG_SPAN)) {
    const logs = await pub.getContractEvents({ address: CH, abi: clearingHouseAbi, eventName: "PositionChanged", fromBlock, toBlock, strict: true });
    open = applyPositionChanges(
      open,
      logs.map((l) => ({ account: l.args.account, newSize: l.args.newSize })),
    );
    scannedTo = toBlock;
  }
  health.openPositions = open.size;
}

async function liquidationStep(block: bigint): Promise<void> {
  await scanPositions(block);
  if (open.size === 0) return;
  // Plain eth_calls in bounded batches: no Multicall3 dependency (address not in ARCHITECTURE §Research).
  const accounts = [...open];
  const snaps: AccountSnapshot[] = [];
  for (let i = 0; i < accounts.length; i += READ_BATCH) {
    const batch = accounts.slice(i, i + READ_BATCH);
    const views = await Promise.allSettled(
      batch.map((a) => pub.readContract({ address: CH, abi: clearingHouseAbi, functionName: "getAccount", args: [a], blockNumber: block })),
    );
    views.forEach((r, j) => {
      const a = batch[j];
      if (r.status !== "fulfilled" || a === undefined) return;
      const v = r.value;
      snaps.push({ account: a, size: v.size, equity: v.equity, maintenanceMargin: v.maintenanceMargin, liquidatable: v.liquidatable });
    });
  }
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
  }
}

async function balanceStep(): Promise<void> {
  const bal = await pub.getBalance({ address: account.address });
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
    // Independent steps: one failing must not starve the others. Order: fresh price first (the CH needs it),
    // then liquidations (latency-critical, ≤ 3 blocks), then the funding poke (any liquidation already touched F).
    const steps: Array<[string, () => Promise<void>]> = [
      ["pyth", pythStep],
      ["liquidation", () => liquidationStep(block)],
      ["funding", () => fundingStep(block)],
    ];
    for (const [name, fn] of steps) await fn().catch((e: unknown) => fail(name, e));
    if (block % 100n === 0n) await balanceStep().catch((e: unknown) => fail("balance", e));
    health.lastTickAt = Date.now();
  } finally {
    busy = false;
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
  res.end(JSON.stringify({ ok, keeper: account.address, ...health }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}).listen(HEALTH_PORT);

log("keeper start", { chainId: CHAIN_ID, clearingHouse: CH, oracle: ORACLE, keeper: account.address, pyth: PYTH_API_KEY !== undefined, health: HEALTH_PORT });
await balanceStep().catch((e: unknown) => fail("balance", e));
pub.watchBlockNumber({
  emitOnBegin: true,
  onBlockNumber: (b) => void tick(b),
  onError: (e) => fail("watchBlockNumber", e),
});
