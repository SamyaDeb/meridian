// B4 skeleton (BENCHMARKS_PLAN): fire the 70% place/cancel + 30% market mix at K markets from W wallets with
// nonce pipelining and tight gas limits (one estimate per op type × 1.2, R6), then report included tx/block and
// landed latency p50/p95 per K. Runs against anvil now; testnet only with a paid RPC and a MON budget (R2/R29 caps).
//   CHAIN_ID=10143 RPC_URL=http://127.0.0.1:8546 DEPLOYMENTS=… LOAD_PKS=0x…,0x… TXS=60 K=1,2 pnpm load
// Markets: deployments `contracts` (+ `demoMarket`), or MARKETS_FILE = JSON [{ClearingHouse, OrderBook}] for K > 2.
// Every wallet must hold tAUSD (it deposits LOAD_DEPOSIT_TOKEN into each market once).
// DRY_RUN=1 (Phase 3 P6): no key, no send. Checks the RPC's chain id, reads its gas price and prints what the run would
// send and its projected MON from measured billed gas (bench/out/gas_onchain_10143_*.csv; BILLED_CSV overrides).
// LOAD_WALLETS=<n> replaces LOAD_PKS. Outputs record the RPC tier (local | public | private), never the URL.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { billedGasFromCsv, planLoad, rpcTier } from "./src/dryrun.js";
import { gasLimitFor, hasSide, loadMix, networkLabel, summarizeLoad } from "./src/stats.js";

const need = (k: string): string => {
  const v = process.env[k];
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CHAIN_ID = Number(need("CHAIN_ID"));
const RPC_URL = need("RPC_URL");
const TXS = Number(process.env.TXS ?? "60");
const KS = (process.env.K ?? "1").split(",").map(Number);
const DEPOSIT = BigInt(process.env.LOAD_DEPOSIT_TOKEN ?? "500000000"); // 500 tAUSD

type Market = { ClearingHouse: Address; OrderBook: Address };
const dep = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? `${HERE}../deployments/${CHAIN_ID}.json`, "utf8"));
const markets: Market[] = process.env.MARKETS_FILE
  ? JSON.parse(readFileSync(process.env.MARKETS_FILE, "utf8"))
  : [dep.contracts, ...(dep.demoMarket ? [dep.demoMarket] : [])];
const AUSD = dep.contracts.AUSD as Address;

const obAbi = parseAbi([
  "function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags) returns (uint64, uint64)",
  "function cancelOrder(uint64 orderId)",
  "function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly) returns (uint64, uint256)",
  "function bestBid() view returns (uint32)",
  "function bestAsk() view returns (uint32)",
  "event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags)",
]);
const chAbi = parseAbi(["function deposit(uint256)"]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)"]);

const chain = defineChain({ id: CHAIN_ID, name: `pulse-${CHAIN_ID}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });

if (process.env.DRY_RUN === "1") {
  const rpcChain = await pub.getChainId();
  if (rpcChain !== CHAIN_ID) throw new Error(`RPC chain id ${rpcChain} != CHAIN_ID ${CHAIN_ID}`);
  const gasPrice = await pub.getGasPrice();
  const csv = process.env.BILLED_CSV ?? `${HERE}out/gas_onchain_10143_2026-09-30.csv`;
  const nW = process.env.LOAD_WALLETS ? Number(process.env.LOAD_WALLETS) : need("LOAD_PKS").split(",").length;
  const maxK = Math.max(...KS);
  if (maxK > markets.length) console.log(`note: K=${maxK} needs ${maxK} markets, deployments has ${markets.length} (MARKETS_FILE)`);
  const plan = planLoad({ ks: KS, txs: TXS, wallets: nW, billed: billedGasFromCsv(readFileSync(csv, "utf8")), gasPriceWei: gasPrice });
  console.log(`DRY RUN (nothing sent): chain ${CHAIN_ID}, RPC tier ${rpcTier(RPC_URL)}, gas price ${gasPrice} wei, ${nW} wallets, K=${KS.join(",")}, ${TXS} txs per K`);
  console.table(plan.perK.map((r) => ({ ...r, gasLimit: r.gasLimit.toString() })));
  console.log(`load txs ${plan.loadTxs}, Σ gas limit ${plan.loadGasLimit} ⇒ ≈ ${Number(plan.loadMonMilli) / 1000} MON (billed limits from ${csv.split("/").pop()}, ×2 as load.ts sets them)`);
  console.log(`setup txs ${plan.setupTxs} (approve + deposit, not measured on testnet: unpriced, > VERIFY before a budget)`);
  process.exit(0);
}

const wallets = need("LOAD_PKS")
  .split(",")
  .map((pk) => {
    const account = privateKeyToAccount(pk as Hex);
    return { account, client: createWalletClient({ chain, account, transport: http(RPC_URL) }) };
  });

async function setup(k: number): Promise<void> {
  for (const w of wallets) {
    for (const m of markets.slice(0, k)) {
      for (const [to, data] of [
        [AUSD, encodeFunctionData({ abi: erc20, functionName: "approve", args: [m.ClearingHouse, DEPOSIT] })],
        [m.ClearingHouse, encodeFunctionData({ abi: chAbi, functionName: "deposit", args: [DEPOSIT] })],
      ] as const) {
        const hash = await w.client.sendTransaction({ to, data, gas: gasLimitFor(await pub.estimateGas({ account: w.account, to, data })) });
        await pub.waitForTransactionReceipt({ hash });
      }
    }
  }
}

async function run(k: number) {
  await setup(k);
  const mix = loadMix(TXS, 42 + k);
  // resting orders far from mid; a "cancel" cancels an order whose OrderPlaced receipt already landed (ids are
  // recycled from a free list, so they can't be predicted for pipelined txs)
  const open = new Map<string, bigint[]>();
  const track = (key: string, hash: Hex): void => {
    void pub.waitForTransactionReceipt({ hash }).then((r) => {
      for (const l of r.logs) {
        try {
          const ev = decodeEventLog({ abi: obAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "OrderPlaced") open.set(key, [...(open.get(key) ?? []), ev.args.orderId]);
        } catch {
          /* other events */
        }
      }
    }, () => undefined);
  };
  const nonces = await Promise.all(wallets.map((w) => pub.getTransactionCount({ address: w.account.address, blockTag: "pending" })));
  const gasCache = new Map<string, bigint>();
  const sent: Array<{ hash: Hex; t0: number }> = [];
  const firstBlock = await pub.getBlockNumber();
  for (let i = 0; i < mix.length; ++i) {
    const wi = i % wallets.length;
    const w = wallets[wi]!;
    const m = markets[i % k]!;
    const key = `${wi}-${m.OrderBook}`;
    const bid = await pub.readContract({ address: m.OrderBook, abi: obAbi, functionName: "bestBid" });
    const ask = await pub.readContract({ address: m.OrderBook, abi: obAbi, functionName: "bestAsk" });
    let op = mix[i]!;
    if (op === "cancel" && (open.get(key)?.length ?? 0) === 0) op = "place";
    // an empty side reads 0 (bid) or the uint32 sentinel (ask): a market order there has nothing to take
    const buy = i % 2 === 0;
    if (op === "market" && (buy ? !hasSide(ask) : !hasSide(bid))) op = "place";
    let data: Hex;
    if (op === "place") {
      data = encodeFunctionData({ abi: obAbi, functionName: "placeLimitOrder", args: [true, bid > 300 ? bid - 300 : 1, 1n, 0] });
    } else if (op === "cancel") {
      const ids = open.get(key)!;
      data = encodeFunctionData({ abi: obAbi, functionName: "cancelOrder", args: [ids.shift()!] });
    } else {
      data = encodeFunctionData({ abi: obAbi, functionName: "placeMarketOrder", args: [buy, 1n, buy ? ask + 50 : bid > 50 ? bid - 50 : 1, 0n, false] });
    }
    const gk = `${op}`;
    if (!gasCache.has(gk)) gasCache.set(gk, gasLimitFor(await pub.estimateGas({ account: w.account, to: m.OrderBook, data })) * 2n);
    const t0 = Date.now();
    const hash = await w.client.sendTransaction({ to: m.OrderBook, data, gas: gasCache.get(gk)!, nonce: nonces[wi]!++ });
    sent.push({ hash, t0 });
    if (op === "place") track(key, hash);
  }
  const lat: number[] = [];
  let lastBlock = firstBlock;
  for (const s of sent) {
    const r = await pub.waitForTransactionReceipt({ hash: s.hash }).catch(() => null);
    if (r === null) continue;
    const b = await pub.getBlock({ blockNumber: r.blockNumber });
    lat.push(Math.max(0, Number(b.timestamp) * 1000 - s.t0));
    if (r.blockNumber > lastBlock) lastBlock = r.blockNumber;
  }
  return summarizeLoad(k, lat, sent.length, firstBlock + 1n, lastBlock);
}

const results = [];
for (const k of KS) {
  if (k > markets.length) throw new Error(`K=${k} > ${markets.length} markets (use MARKETS_FILE)`);
  results.push(await run(k));
}
mkdirSync(`${HERE}out`, { recursive: true });
const net = networkLabel(CHAIN_ID, await pub.request({ method: "web3_clientVersion" }));
const file = `${HERE}out/load_${net}_${new Date().toISOString().slice(0, 10)}.json`;
// the RPC tier only: a paid URL carries its API key and must never land in bench/out
writeFileSync(file, JSON.stringify({ chainId: CHAIN_ID, rpcTier: rpcTier(RPC_URL), txs: TXS, wallets: wallets.length, results }, null, 2));
console.table(results);
console.log(`→ ${file} (skeleton: latency uses 1 s block timestamps; B4 proper = testnet + paid RPC)`);
