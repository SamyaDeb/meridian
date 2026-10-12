// PS (CR-017): keeper for the funding-swap market that settles on Perpl's funding (`swapMarkets[]` entry with
// fundingSource "perpl", AddSwapMarket.s.sol). A separate small process, so the main keeper's MON-PERP duties are not
// duplicated. Duties:
//   1. poke   — PerplFundingSource.poke() once per Perpl funding event (~every 8,571 blocks / 43 min), when Perpl's
//               fundingEventBlock passes the source's last snapshot (src/perplsource.ts shouldPokePerpl). A reverted
//               poke (StalePerplPrice) backs off POKE_RETRY_BLOCKS. Gas limit = estimate × 1.2 (Monad bills the limit).
//   2. maturity — settleMaturity() exactly once at/after maturity (src/swap.ts shouldSettleMaturity).
//   3. liquidations (SWAP_LIQUIDATE=1; the keeper must hold swap collateral, it takes the position): accounts from
//               SwapPositionChanged, a full getAccount read every SWAP_FULL_EVERY_BLOCKS, at most 5 per block, most
//               under water first (src/swap.ts). Off by default on testnet: the swap MM and the keeper collateral are
//               owner actions (keepers/RUNBOOK.md §7g).
//   /health on HEALTH_PORT (default 8790): source lag, pokes, failures, MON balance.
// Env: CHAIN_ID, RPC_URL, KEEPER_PK (never printed), DEPLOYMENTS (default ../../deployments/<chain>.json),
//      SWAP_MARKET (default "perpl"), POLL_MS (2000), POKE_RETRY_BLOCKS (30), LOG_SPAN (100), SWAP_LIQUIDATE (0).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, formatEther, http, maxUint256, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fundingSwapAbi, fundingSwapImplAbi, perplExchangeAbi, perplFundingSourceAbi } from "./abi.js";
import { gasLimitFor, resolveSwapMarket, shouldPokePerpl, sourceLagBlocks, type SwapMarketRecord } from "./perplsource.js";
import { type SwapSnapshot, shouldSettleMaturity, swapAccountIsInert, swapLiquidationCandidates } from "./swap.js";

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === "" ? undefined : v;
};
const need = (k: string): string => {
  const v = env(k);
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const CHAIN_ID = Number(need("CHAIN_ID"));
const RPC_URL = need("RPC_URL");
const KEEPER_PK = need("KEEPER_PK") as Hex;
const DEPLOYMENTS = env("DEPLOYMENTS") ?? fileURLToPath(new URL(`../../../deployments/${CHAIN_ID}.json`, import.meta.url));
const SWAP_KEY = env("SWAP_MARKET") ?? "perpl";
const POLL_MS = Number(env("POLL_MS") ?? "2000");
const POKE_RETRY_BLOCKS = BigInt(env("POKE_RETRY_BLOCKS") ?? "30");
const LOG_SPAN = BigInt(env("LOG_SPAN") ?? "100");
const SWAP_LIQUIDATE = env("SWAP_LIQUIDATE") === "1";
const SWAP_FULL_EVERY_BLOCKS = BigInt(env("SWAP_FULL_EVERY_BLOCKS") ?? "50");
const MAX_LIQUIDATIONS_PER_BLOCK = 5;
const HEALTH_PORT = Number(env("HEALTH_PORT") ?? "8790");

const rec = JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as { chainId: number; swapMarkets?: SwapMarketRecord[] };
if (rec.chainId !== CHAIN_ID) throw new Error(`deployments chainId ${rec.chainId} != CHAIN_ID ${CHAIN_ID}`);
const m = resolveSwapMarket(rec, SWAP_KEY, DEPLOYMENTS);
const SRC = m.PerplFundingSource;
const FS = m.FundingSwapMarket;
const PERPL = m.perplExchange;
const PERP = BigInt(m.perplPerpId);

const chain = defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL), cacheTime: 0 });
const account = privateKeyToAccount(KEEPER_PK, { nonceManager });
const wallet = createWalletClient({ chain, transport: http(RPC_URL), account });

const health = {
  market: m.symbol,
  source: SRC,
  swapMarket: FS,
  keeper: account.address,
  block: 0n,
  perplFeb: 0n,
  sourceFeb: 0n,
  sourceLagBlocks: 0n,
  pokes: 0,
  pokeFailures: 0,
  lastPokeTx: null as Hex | null,
  lastError: null as string | null,
  matured: false,
  tracked: 0,
  liquidations: 0,
  balanceMon: "?",
  updatedAt: 0,
};

let pending = false;
let lastFailedBlock = -1n;
let maturityPending = false;
let scannedTo = BigInt(m.startBlock) - 1n;
let lastFull = -1n;
const tracked = new Set<Address>();

async function send(fn: "poke" | "settleMaturity" | "liquidate", args: readonly unknown[] = []): Promise<Hex> {
  const isSource = fn === "poke";
  const address = isSource ? SRC : FS;
  const abi = isSource ? perplFundingSourceAbi : fundingSwapAbi;
  const req = { address, abi, functionName: fn, args, account } as never;
  const est = await pub.estimateContractGas(req);
  const hash = await wallet.writeContract({ ...(req as object), gas: gasLimitFor(est) } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted in ${hash}`);
  console.log(`${fn} ${hash} block ${r.blockNumber} gasUsed ${r.gasUsed} limit ${gasLimitFor(est)}`);
  return hash;
}

async function pokeStep(block: bigint): Promise<void> {
  const [[, perplFeb], [, , sourceFeb]] = await Promise.all([
    pub.readContract({ address: PERPL, abi: perplExchangeAbi, functionName: "getFundingSumAtBlock", args: [PERP, block], blockNumber: block }),
    pub.readContract({ address: SRC, abi: perplFundingSourceAbi, functionName: "latestObservation", blockNumber: block }),
  ]);
  Object.assign(health, { perplFeb, sourceFeb: BigInt(sourceFeb), sourceLagBlocks: sourceLagBlocks(perplFeb, BigInt(sourceFeb)) });
  if (!shouldPokePerpl({ perplFeb, sourceFeb: BigInt(sourceFeb), pending, block, lastFailedBlock, retryAfterBlocks: POKE_RETRY_BLOCKS })) return;
  pending = true;
  try {
    health.lastPokeTx = await send("poke");
    health.pokes++;
  } catch (e) {
    lastFailedBlock = block;
    health.pokeFailures++;
    health.lastError = `poke: ${(e as Error).message.split("\n")[0]}`;
    console.error(health.lastError);
  } finally {
    pending = false;
  }
}

async function maturityStep(): Promise<void> {
  const blk = await pub.getBlock();
  const [snapped] = await pub.readContract({ address: FS, abi: fundingSwapImplAbi, functionName: "maturitySnapshot" });
  health.matured = snapped;
  if (!shouldSettleMaturity({ nowSec: blk.timestamp, maturity: BigInt(m.maturity), snapped, pending: maturityPending })) return;
  maturityPending = true;
  try {
    await send("settleMaturity");
  } catch (e) {
    health.lastError = `settleMaturity: ${(e as Error).message.split("\n")[0]}`;
  } finally {
    maturityPending = false;
  }
}

async function liquidationStep(block: bigint): Promise<void> {
  // bounded catch-up: at most 20 log pages per tick
  for (let i = 0; i < 20 && scannedTo < block; i++) {
    const from = scannedTo + 1n;
    const to = from + LOG_SPAN - 1n < block ? from + LOG_SPAN - 1n : block;
    const logs = await pub.getContractEvents({ address: FS, abi: fundingSwapAbi, eventName: "SwapPositionChanged", fromBlock: from, toBlock: to });
    for (const l of logs) if (l.args.account !== undefined) tracked.add(l.args.account);
    scannedTo = to;
  }
  health.tracked = tracked.size;
  if (scannedTo < block || (lastFull >= 0n && block - lastFull < SWAP_FULL_EVERY_BLOCKS)) return;
  lastFull = block;
  const snaps: SwapSnapshot[] = [];
  for (const a of tracked) {
    const v = await pub.readContract({ address: FS, abi: fundingSwapAbi, functionName: "getAccount", args: [a], blockNumber: block });
    const s = { account: a, size: v.size, unrealizedPnl: v.unrealizedPnl, equity: v.equity, maintenanceMargin: v.maintenanceMargin, liquidatable: v.liquidatable };
    if (swapAccountIsInert(s)) tracked.delete(a);
    else snaps.push(s);
  }
  for (const c of swapLiquidationCandidates(snaps, MAX_LIQUIDATIONS_PER_BLOCK, account.address)) {
    try {
      await send("liquidate", [c.account, maxUint256]);
      health.liquidations++;
    } catch (e) {
      health.lastError = `liquidate ${c.account}: ${(e as Error).message.split("\n")[0]}`;
    }
  }
}

async function tick(): Promise<void> {
  const block = await pub.getBlockNumber({ cacheTime: 0 });
  health.block = block;
  await pokeStep(block);
  await maturityStep();
  if (SWAP_LIQUIDATE) await liquidationStep(block);
  health.balanceMon = formatEther(await pub.getBalance({ address: account.address }));
  health.updatedAt = Date.now();
}

createServer((_, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(health, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}).listen(HEALTH_PORT);
console.log(`perpl-swap keeper: ${m.symbol} source ${SRC} swap ${FS} keeper ${account.address} health :${HEALTH_PORT}`);

for (;;) {
  try {
    await tick();
  } catch (e) {
    health.lastError = (e as Error).message.split("\n")[0] ?? "error";
    console.error(health.lastError);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
