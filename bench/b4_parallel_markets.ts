// B4 (K7, BENCHMARKS_PLAN): two perp markets loaded at the same time from separate keys.
// Phases: a = load on market A only, b = market B only, ab = both at once. Each phase runs ROUNDS rounds; in a round every
// active wallet sends ONE op at the same moment (place a resting bid / cancel one of its orders / 1-lot market order
// against its market's maker ladder), so in phase ab both markets' txs target the same blocks. Inclusion is detected by
// polling blocks (one call per poll, not per tx). Measured per (phase, market): txs per block, inclusion blocks and
// wall-clock latency (p50/p95), gas per op; plus the storage both markets' txs touch (debug_traceTransaction
// prestateTracer), the direct test of "no shared hot storage".
//   CHAIN_ID=10143 RPC_URL=… KEYS_A=0xmakerA,0xw1,… KEYS_B=0xmakerB,0xw1,… FEEDER_PK=0x… PYTH_API_KEY=… \
//   PYTH_MON_USD_FEED_ID=0x… MARKET_A=main MARKET_B=eth ROUNDS=10 pnpm b4
// FUND=1 mints tAUSD (testnet/anvil MockERC20) and deposits DEPOSIT_TOKEN per wallet per market; ANVIL=1 also sets MON
// balances with anvil_setBalance. Outputs bench/out/b4_parallel_<net>_<date>.{csv,json}: the RPC tier, never the URL.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, parseAbi } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { B4_CSV_HEADER, type B4Op, type B4Phase, type B4Tx, type Prestate, b4CsvRow, b4Schedule, interference, sharedBlocks, storageOverlap, summarizeB4 } from "./src/b4.js";
import { rpcTier } from "./src/dryrun.js";
import { gasLimitFor, networkLabel } from "./src/stats.js";

const env = (k: string): string | undefined => (process.env[k] === undefined || process.env[k] === "" ? undefined : process.env[k]);
const need = (k: string): string => {
  const v = env(k);
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CHAIN_ID = Number(need("CHAIN_ID"));
const RPC_URL = need("RPC_URL");
const ROUNDS = Number(env("ROUNDS") ?? "10");
const PHASES = (env("PHASES") ?? "a,b,ab").split(",") as B4Phase[];
const DEPOSIT = BigInt(env("DEPOSIT_TOKEN") ?? "200000000"); // 200 tAUSD per wallet per market
const LADDER_LOTS = BigInt(env("LADDER_LOTS") ?? "10"); // maker lots per level, 3 levels a side
const PLACE_OFFSET_TICKS = Number(env("PLACE_OFFSET_TICKS") ?? "100"); // resting bids 100 ticks (≈ 0.4%) under the index
const TOUCH_ALLOWANCE = BigInt(env("TOUCH_ALLOWANCE_GAS") ?? (CHAIN_ID === 10143 ? "70000" : "0"));
const POLL_MS = Number(env("POLL_MS") ?? "150");
const FEED_EVERY_MS = Number(env("FEED_EVERY_MS") ?? "20000");
const HERMES = env("HERMES_URL") ?? "https://pyth.dourolabs.app/hermes"; // keepers/ts-fallback DEFAULT_HERMES_URL (R24)

// ─── record ───
interface Mkt {
  ClearingHouse: Address;
  OrderBook: Address;
  OracleAdapter: Address;
  symbol: string;
  pythFeedId?: Hex;
}
interface Rec {
  chainId: number;
  symbol?: string;
  contracts: Mkt & { AUSD: Address };
  demoMarket?: Mkt;
  markets?: Mkt[];
}
const rec = JSON.parse(readFileSync(env("DEPLOYMENTS") ?? `${HERE}../deployments/${CHAIN_ID}.json`, "utf8")) as Rec;
if (rec.chainId !== CHAIN_ID) throw new Error(`record chain ${rec.chainId} != ${CHAIN_ID}`);
function resolve(key: string): Mkt {
  if (key === "main") return { ...rec.contracts, symbol: rec.symbol ?? "MON-PERP", ...(env("PYTH_MON_USD_FEED_ID") ? { pythFeedId: env("PYTH_MON_USD_FEED_ID") as Hex } : {}) };
  if (key === "demo" && rec.demoMarket) return rec.demoMarket;
  const m = (rec.markets ?? []).find((x) => x.symbol.toUpperCase() === key.toUpperCase() || x.symbol.split("-")[0]!.toUpperCase() === key.toUpperCase());
  if (m === undefined) throw new Error(`market ${key} not in the record`);
  return m;
}
const A = resolve(env("MARKET_A") ?? "main");
const B = resolve(env("MARKET_B") ?? "eth");

const obAbi = parseAbi([
  "function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags) returns (uint64, uint64)",
  "function cancelOrder(uint64 orderId)",
  "function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly) returns (uint64, uint256)",
  "function tickSize() view returns (uint256)",
  "event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags)",
]);
const chAbi = parseAbi(["function deposit(uint256)", "function getAccount(address) view returns ((uint256 collateral,int256 size,uint256 entryPrice,int256 unrealizedPnl,int256 pendingFunding,int256 equity,uint256 initialMargin,uint256 maintenanceMargin,uint256 reservedOrderMargin,uint256 liquidationPrice,bool liquidatable))"]);
const oracleAbi = parseAbi(["function tryGetIndexPrice() view returns (bool, uint256, uint256)", "function latest() view returns (uint256, uint256)", "function pushPrice(uint256 priceWad, uint256 publishTime)"]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)", "function mint(address, uint256)", "function balanceOf(address) view returns (uint256)"]);

const chain = defineChain({ id: CHAIN_ID, name: `meridian-${CHAIN_ID}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
// cacheTime 0: viem caches getBlockNumber for 4 s by default, which would skew both sentBlock and the latency
const pub = createPublicClient({ chain, cacheTime: 0, pollingInterval: POLL_MS, transport: http(RPC_URL, { retryCount: 3, retryDelay: 300 }) });
const keys = (k: string): PrivateKeyAccount[] => need(k).split(",").map((pk) => privateKeyToAccount(pk as Hex));
const accA = keys("KEYS_A");
const accB = keys("KEYS_B");
if (accA.length < 2 || accB.length < 2) throw new Error("KEYS_A / KEYS_B: maker + at least one load wallet each");
const feeder = env("FEEDER_PK") ? privateKeyToAccount(env("FEEDER_PK") as Hex) : undefined;
const nonces = new Map<Address, number>();
let gasPrice = 0n;

async function send(acc: PrivateKeyAccount, to: Address, data: Hex, gasCacheKey?: string): Promise<{ hash: Hex; gas: bigint; est: bigint }> {
  const cached = gasCacheKey ? estCache.get(gasCacheKey) : undefined;
  const est = cached ?? (await pub.estimateGas({ account: acc, to, data }));
  if (gasCacheKey && cached === undefined) estCache.set(gasCacheKey, est);
  const gas = gasLimitFor(est, TOUCH_ALLOWANCE);
  if (!nonces.has(acc.address)) nonces.set(acc.address, await pub.getTransactionCount({ address: acc.address, blockTag: "pending" }));
  const nonce = nonces.get(acc.address)!;
  nonces.set(acc.address, nonce + 1);
  const wallet = createWalletClient({ chain, account: acc, transport: http(RPC_URL) });
  const hash = await wallet.sendTransaction({ to, data, gas, gasPrice, nonce });
  return { hash, gas, est };
}
const estCache = new Map<string, bigint>();
async function sendWait(acc: PrivateKeyAccount, to: Address, data: Hex): Promise<void> {
  const { hash } = await send(acc, to, data);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 300 });
  if (r.status !== "success") throw new Error(`setup tx reverted ${hash}`);
}

// ─── price feed (keeper-fed oracles: the bench keeps both fresh with Hermes prices) ───
async function hermes(feed: Hex): Promise<{ price: bigint; t: bigint }> {
  const res = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${feed}&parsed=true`, { headers: { Authorization: `Bearer ${need("PYTH_API_KEY")}` } });
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const p = ((await res.json()) as { parsed: Array<{ price: { price: string; expo: number; publish_time: number } }> }).parsed[0]!.price;
  return { price: BigInt(p.price) * 10n ** BigInt(18 + p.expo), t: BigInt(p.publish_time) };
}
// Hermes keys are entitled per feed (8 Oct: the key serves ETH/USD, not MON/USD): fall back to mainnet Pyth onchain,
// the keeper's keyless source (keepers/ts-fallback/src/pricesource.ts MAINNET_PYTH, ARCHITECTURE R12).
const MAINNET_PYTH: Address = "0x2880aB155794e7179c9eE2e38200202908C17B43";
const pythAbi = parseAbi(["function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))"]);
const mainnet = env("MONAD_RPC_URL") ? createPublicClient({ transport: http(env("MONAD_RPC_URL")) }) : undefined;
async function source(feed: Hex): Promise<{ price: bigint; t: bigint }> {
  try {
    return await hermes(feed);
  } catch (e) {
    if (mainnet === undefined) throw e;
    const p = await mainnet.readContract({ address: MAINNET_PYTH, abi: pythAbi, functionName: "getPriceUnsafe", args: [feed] });
    return { price: BigInt(p.price) * 10n ** BigInt(18 + p.expo), t: p.publishTime };
  }
}
let lastFeed = 0;
async function feed(force = false): Promise<void> {
  if (feeder === undefined || (!force && Date.now() - lastFeed < FEED_EVERY_MS)) return;
  lastFeed = Date.now();
  await Promise.all(
    [A, B].map(async (m) => {
      if (m.pythFeedId === undefined) throw new Error(`${m.symbol}: no feed id (PYTH_MON_USD_FEED_ID for main)`);
      const [{ price, t }, [, onchainT]] = await Promise.all([source(m.pythFeedId), pub.readContract({ address: m.OracleAdapter, abi: oracleAbi, functionName: "latest" })]);
      if (t <= onchainT) return;
      await sendWait(feeder, m.OracleAdapter, encodeFunctionData({ abi: oracleAbi, functionName: "pushPrice", args: [price, t] }));
    }),
  );
}

async function indexTick(m: Mkt): Promise<{ tick: number; ts: bigint }> {
  const [[ok, px], ts] = await Promise.all([
    pub.readContract({ address: m.OracleAdapter, abi: oracleAbi, functionName: "tryGetIndexPrice" }),
    pub.readContract({ address: m.OrderBook, abi: obAbi, functionName: "tickSize" }),
  ]);
  if (!ok) throw new Error(`${m.symbol}: oracle stale (FEEDER_PK + PYTH_API_KEY keep it fresh)`);
  return { tick: Number(px / ts), ts };
}

const MARKET_LIMIT_TICKS = Number(env("MARKET_LIMIT_TICKS") ?? "30"); // IOC limit: index ± 30 ticks (MON: ±12 bp)

/** Maker ladder: 3 levels a side around the CURRENT index (re-quoted every phase so market ops always find it). */
async function ladder(m: Mkt, maker: PrivateKeyAccount): Promise<void> {
  const { tick } = await indexTick(m);
  for (const d of [1, 2, 3]) {
    await sendWait(maker, m.OrderBook, encodeFunctionData({ abi: obAbi, functionName: "placeLimitOrder", args: [false, tick + d, LADDER_LOTS, 0] }));
    await sendWait(maker, m.OrderBook, encodeFunctionData({ abi: obAbi, functionName: "placeLimitOrder", args: [true, tick - d, LADDER_LOTS, 0] }));
  }
}

// ─── setup: collateral ───
async function setup(m: Mkt, accs: PrivateKeyAccount[]): Promise<void> {
  for (const acc of accs) {
    if (env("ANVIL") === "1") await pub.request({ method: "anvil_setBalance" as never, params: [acc.address, "0x56BC75E2D63100000"] as never });
    if (env("FUND") === "1") {
      const have = (await pub.readContract({ address: m.ClearingHouse, abi: chAbi, functionName: "getAccount", args: [acc.address] })).collateral;
      if (have < DEPOSIT * 10n ** 12n) {
        await sendWait(acc, rec.contracts.AUSD, encodeFunctionData({ abi: erc20, functionName: "mint", args: [acc.address, DEPOSIT] }));
        await sendWait(acc, rec.contracts.AUSD, encodeFunctionData({ abi: erc20, functionName: "approve", args: [m.ClearingHouse, DEPOSIT] }));
        await sendWait(acc, m.ClearingHouse, encodeFunctionData({ abi: chAbi, functionName: "deposit", args: [DEPOSIT] }));
      }
    }
  }
}

// ─── load ───
const txs: B4Tx[] = [];
const openOrders = new Map<string, bigint[]>(); // `${symbol}:${wallet}` → order ids (from receipts)

async function phase(ph: B4Phase): Promise<void> {
  const active: Array<{ m: Mkt; accs: PrivateKeyAccount[] }> = [];
  if (ph !== "b") active.push({ m: A, accs: accA.slice(1) });
  if (ph !== "a") active.push({ m: B, accs: accB.slice(1) });
  await feed(true);
  for (const { m } of active) await ladder(m, m === A ? accA[0]! : accB[0]!);
  const sched = new Map<string, ReturnType<typeof b4Schedule>>();
  for (const { m, accs } of active) accs.forEach((_, w) => sched.set(`${m.symbol}:${w}`, b4Schedule(ROUNDS, 11 + w + (m === B ? 100 : 0) + ph.length)));
  for (let r = 0; r < ROUNDS; ++r) {
    await feed();
    const ticks = await Promise.all(active.map(({ m }) => indexTick(m)));
    const sentBlock = await pub.getBlockNumber();
    const round: B4Tx[] = [];
    await Promise.all(
      active.flatMap(({ m, accs }, i) =>
        accs.map(async (acc, w) => {
          const key = `${m.symbol}:${w}`;
          let { op, buy } = sched.get(key)![r]!;
          const ids = openOrders.get(key) ?? [];
          if (op === "cancel" && ids.length === 0) op = "place";
          const t = ticks[i]!.tick;
          const data =
            op === "place"
              ? encodeFunctionData({ abi: obAbi, functionName: "placeLimitOrder", args: [true, t - PLACE_OFFSET_TICKS, 1n, 0] })
              : op === "cancel"
                ? encodeFunctionData({ abi: obAbi, functionName: "cancelOrder", args: [ids.shift()!] })
                : encodeFunctionData({ abi: obAbi, functionName: "placeMarketOrder", args: [buy, 1n, buy ? t + MARKET_LIMIT_TICKS : t - MARKET_LIMIT_TICKS, 0n, false] });
          const sentMs = Date.now();
          const s = await send(acc, m.OrderBook, data, `${m.symbol}:${op}`);
          round.push({ phase: ph, market: m.symbol, op: op as B4Op, wallet: w, hash: s.hash, sentBlock, sentMs, gasLimit: s.gas, estimate: s.est });
        }),
      ),
    );
    await waitIncluded(round);
    for (const t of round) {
      const rc = await pub.getTransactionReceipt({ hash: t.hash as Hex });
      t.status = rc.status;
      t.gasUsed = rc.gasUsed;
      for (const l of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: obAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "OrderPlaced") {
            const key = `${t.market}:${t.wallet}`;
            openOrders.set(key, [...(openOrders.get(key) ?? []), ev.args.orderId]);
          }
        } catch {
          /* other events */
        }
      }
    }
    txs.push(...round);
    console.log(`${ph} round ${r + 1}/${ROUNDS}: ${round.map((t) => `${t.market.split("-")[0]}:${t.op}@+${t.block! - t.sentBlock}${t.status === "reverted" ? "!" : ""}`).join(" ")}`);
  }
}

/** Polls new blocks until every tx of the round is in one; sets block + seenMs. */
async function waitIncluded(round: B4Tx[], timeoutMs = 60_000): Promise<void> {
  const want = new Map(round.map((t) => [t.hash.toLowerCase(), t]));
  let next = round[0]!.sentBlock + 1n;
  const t0 = Date.now();
  while (want.size > 0) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`round not included after ${timeoutMs} ms: ${[...want.keys()].join(",")}`);
    const head = await pub.getBlockNumber();
    while (next <= head && want.size > 0) {
      const b = await pub.getBlock({ blockNumber: next });
      const seen = Date.now();
      for (const h of b.transactions) {
        const t = want.get((h as string).toLowerCase());
        if (t) {
          t.block = next;
          t.seenMs = seen;
          want.delete((h as string).toLowerCase());
        }
      }
      next++;
    }
    if (want.size > 0) await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function prestate(hash: string): Promise<Prestate | null> {
  try {
    return (await pub.request({ method: "debug_traceTransaction" as never, params: [hash, { tracer: "prestateTracer" }] as never })) as Prestate;
  } catch {
    return null;
  }
}

// ─── main ───
gasPrice = (await pub.getGasPrice()) * BigInt(env("GAS_PRICE_PCT") ?? "100") / 100n;
const startBlock = await pub.getBlockNumber();
const balBefore = await Promise.all([...accA, ...accB, ...(feeder ? [feeder] : [])].map((a) => pub.getBalance({ address: a.address })));
console.log(`B4 on chain ${CHAIN_ID} (${rpcTier(RPC_URL)} RPC), ${A.symbol} vs ${B.symbol}, ${accA.length - 1}+${accB.length - 1} load wallets, ${ROUNDS} rounds × ${PHASES.join("/")}, gas price ${gasPrice}`);
await feed(true);
await setup(A, accA);
await setup(B, accB);
for (const ph of PHASES) await phase(ph);
const endBlock = await pub.getBlockNumber();
const balAfter = await Promise.all([...accA, ...accB, ...(feeder ? [feeder] : [])].map((a) => pub.getBalance({ address: a.address })));
// Monad bills the gas limit (CONTRIBUTING §7): billed MON of the load txs = Σ limit × price. The wallet balance delta
// (setup + feeder included) is reported too, except on anvil where anvil_setBalance makes it meaningless.
const billedLoadMon = Number(txs.reduce((s, t) => s + t.gasLimit * gasPrice, 0n)) / 1e18;
const monSpent = env("ANVIL") === "1" ? null : Number(balBefore.reduce((s, b, i) => s + b - balAfter[i]!, 0n)) / 1e18;

const summaries = PHASES.flatMap((ph) => [A, B].map((m) => summarizeB4(txs, ph, m.symbol)).filter((s) => s.sent > 0));
const get = (ph: B4Phase, m: Mkt) => summaries.find((s) => s.phase === ph && s.market === m.symbol);
const cmp = (m: Mkt, alone: B4Phase) => {
  const a = get(alone, m);
  const j = get("ab", m);
  if (!a || !j) return undefined;
  return {
    market: m.symbol,
    inclusionBlocksP50: interference(a.inclusionBlocksP50, j.inclusionBlocksP50),
    latencyMsP50: interference(a.latencyMsP50, j.latencyMsP50),
    latencyMsP95: interference(a.latencyMsP95, j.latencyMsP95),
    txPerBlockMean: interference(a.txPerBlockMean, j.txPerBlockMean),
  };
};
// storage: per op, the heaviest successful tx of each market in the joint phase
const overlap: Record<string, unknown> = {};
for (const op of ["place", "market", "cancel"] as const) {
  // the heaviest successful tx of the op per market: the most storage touched (a filled market order, not a miss)
  const heaviest = (sym: string) =>
    txs.filter((t) => t.phase === "ab" && t.market === sym && t.op === op && t.status === "success").sort((x, y) => Number((y.gasUsed ?? 0n) - (x.gasUsed ?? 0n)))[0];
  const ta = heaviest(A.symbol);
  const tb = heaviest(B.symbol);
  if (!ta || !tb) continue;
  const [pa, pb] = await Promise.all([prestate(ta.hash), prestate(tb.hash)]);
  overlap[op] = pa && pb ? { txA: ta.hash, txB: tb.hash, ...storageOverlap(pa, pb) } : "debug_traceTransaction prestateTracer unavailable on this RPC";
}

const date = new Date().toISOString().slice(0, 10);
const net = networkLabel(CHAIN_ID, await pub.request({ method: "web3_clientVersion" }));
let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: HERE }).toString().trim();
} catch {
  /* not a checkout */
}
const meta = { chainId: CHAIN_ID, rpcTier: rpcTier(RPC_URL), commit, date };
mkdirSync(`${HERE}out`, { recursive: true });
const base = `${HERE}out/b4_parallel_${net}_${date}`;
writeFileSync(`${base}.csv`, [B4_CSV_HEADER, ...txs.map((t) => b4CsvRow(t, meta))].join("\n") + "\n");
const out = {
  ...meta,
  markets: { A: { symbol: A.symbol, ClearingHouse: A.ClearingHouse, OrderBook: A.OrderBook }, B: { symbol: B.symbol, ClearingHouse: B.ClearingHouse, OrderBook: B.OrderBook } },
  wallets: { A: accA.length - 1, B: accB.length - 1 },
  rounds: ROUNDS,
  blocks: { start: Number(startBlock), end: Number(endBlock) },
  gasPriceWei: gasPrice.toString(),
  billedLoadMon,
  monSpent,
  summaries,
  sharedBlocks: sharedBlocks(txs, A.symbol, B.symbol),
  interference: { A: cmp(A, "a"), B: cmp(B, "b") },
  storageOverlap: overlap,
};
writeFileSync(`${base}.json`, JSON.stringify(out, null, 2) + "\n");
console.table(summaries.map(({ gasUsedP50ByOp, estimateP50ByOp, ...s }) => ({ ...s, gasUsed: JSON.stringify(gasUsedP50ByOp), estimate: JSON.stringify(estimateP50ByOp) })));
console.log("joint ÷ alone:", JSON.stringify(out.interference));
console.log("blocks with both markets (phase ab):", JSON.stringify(out.sharedBlocks));
console.log("storage overlap:", JSON.stringify(overlap, (_k, v) => (Array.isArray(v) && v.length > 6 ? [...v.slice(0, 6), `… ${v.length}`] : v)));
console.log(`billed MON (load txs, limit × price) ${billedLoadMon.toFixed(4)}; wallet MON delta ${monSpent === null ? "n/a (anvil)" : monSpent.toFixed(4)} → ${base}.{csv,json}`);
