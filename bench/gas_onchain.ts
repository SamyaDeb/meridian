// B1/B2 on a live chain (BENCHMARKS_PLAN): replay the MM op mix and a funding touch, read receipts, write CSV.
// Foundry models the Ethereum schedule; Monad's MIP-8 page pricing only shows in real receipts (B3).
//   CHAIN_ID=10143 RPC_URL=$MONAD_TESTNET_RPC_URL BENCH_PK=0x… DEPLOYMENTS=../deployments/10143.json pnpm gas
//   (anvil: CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8546 …; the account needs tAUSD for margin)
// Output: bench/out/gas_onchain_<chainId>_<date>.csv + a table vs contracts/bench-out/real_engine_gas.csv.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  nonceManager,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GAS_CSV_HEADER, type GasRow, gasCsvRow, gasLimitFor, meanBlockTimeMs, networkLabel, parseFoundryCsv } from "./src/stats.js";

const need = (k: string): string => {
  const v = process.env[k];
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const CHAIN_ID = Number(need("CHAIN_ID"));
const RPC_URL = need("RPC_URL");
const REPS = Number(process.env.REPS ?? "5");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const dep = JSON.parse(readFileSync(process.env.DEPLOYMENTS ?? `${HERE}../deployments/${CHAIN_ID}.json`, "utf8")) as {
  chainId: number;
  deployed?: boolean;
  contracts: { ClearingHouse: Address; OrderBook: Address; AUSD: Address };
};
if (dep.deployed === false || dep.chainId !== CHAIN_ID) throw new Error("deployments: not deployed or chain mismatch");
const { ClearingHouse: CH, OrderBook: OB, AUSD } = dep.contracts;

const obAbi = parseAbi([
  "function placeLimitOrder(bool isBid, uint32 tick, uint64 lots, uint8 flags) returns (uint64 orderId, uint64 filledLots)",
  "function cancelOrder(uint64 orderId)",
  "function replaceOrder(uint64 orderId, uint32 newTick, uint64 newLots, uint8 flags) returns (uint64 newOrderId, uint64 filledLots)",
  "function placeMarketOrder(bool isBid, uint64 lots, uint32 limitTick, uint64 minFilledLots, bool reduceOnly) returns (uint64 filledLots, uint256 avgPriceWad)",
  "function bestBid() view returns (uint32)",
  "function bestAsk() view returns (uint32)",
  "event OrderPlaced(uint64 indexed orderId, address indexed maker, bool isBid, uint32 tick, uint64 lots, uint8 flags)",
]);
const chAbi = parseAbi([
  "function updateFunding() returns (int256)",
  "function deposit(uint256 amountToken)",
  "event FundingUpdated(uint64 indexed blockNumber, int256 premium, int256 emaPremium, int256 rate, int256 cumFunding, int256 cumIndexTime, uint256 indexPrice, uint256 markPrice)",
]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const chain = defineChain({ id: CHAIN_ID, name: `pulse-${CHAIN_ID}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const account = privateKeyToAccount(need("BENCH_PK") as Hex, { nonceManager });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ chain, account, transport: http(RPC_URL) });
const rows: GasRow[] = [];

async function send(op: string, to: Address, data: Hex) {
  const gas = gasLimitFor(await pub.estimateGas({ account, to, data }));
  const hash = await wallet.sendTransaction({ to, data, gas });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${op} reverted: ${hash}`);
  rows.push({ op, gasUsed: r.gasUsed, gasLimit: gas, block: r.blockNumber, txHash: hash });
  return r;
}

function placedId(logs: readonly { data: Hex; topics: readonly Hex[] }[]): bigint {
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi: obAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "OrderPlaced") return ev.args.orderId;
    } catch {
      /* other events */
    }
  }
  throw new Error("no OrderPlaced");
}

const first = await pub.getBlock();
// margin for the resting orders and a 1-lot market order
const bal = await pub.readContract({ address: AUSD, abi: erc20, functionName: "balanceOf", args: [account.address] });
const dep0 = bal > 1_000_000_000n ? 1_000_000_000n : bal; // ≤ 1,000 tAUSD
// rerunnable: with no tAUSD left in the wallet, trade on the margin already deposited by an earlier run
if (dep0 > 0n) {
  await send("approve", AUSD, encodeFunctionData({ abi: erc20, functionName: "approve", args: [CH, dep0] }));
  await send("deposit", CH, encodeFunctionData({ abi: chAbi, functionName: "deposit", args: [dep0] }));
}
const bid = await pub.readContract({ address: OB, abi: obAbi, functionName: "bestBid" });
const ask = await pub.readContract({ address: OB, abi: obAbi, functionName: "bestAsk" });
const far = bid > 200 ? bid - 200 : 1; // rests, never crosses
for (let i = 0; i < REPS; ++i) {
  const r = await send("place", OB, encodeFunctionData({ abi: obAbi, functionName: "placeLimitOrder", args: [true, far, 1n, 0] }));
  const id = placedId(r.logs);
  const r2 = await send("replace", OB, encodeFunctionData({ abi: obAbi, functionName: "replaceOrder", args: [id, far - 1, 1n, 0] }));
  await send("cancel", OB, encodeFunctionData({ abi: obAbi, functionName: "cancelOrder", args: [placedId(r2.logs)] }));
}
// one market order of 1 lot (1 fill) and back out
await send("match_1_fill", OB, encodeFunctionData({ abi: obAbi, functionName: "placeMarketOrder", args: [true, 1n, ask + 50, 1n, false] }));
await send("close_1_fill", OB, encodeFunctionData({ abi: obAbi, functionName: "placeMarketOrder", args: [false, 1n, bid > 50 ? bid - 50 : 1, 1n, true] }));
// B2: updateFunding — first touch of its block iff it emitted FundingUpdated
for (let i = 0; i < REPS; ++i) {
  const r = await send("updateFunding", CH, encodeFunctionData({ abi: chAbi, functionName: "updateFunding" }));
  const firstTouch = r.logs.some((l) => l.address.toLowerCase() === CH.toLowerCase());
  rows[rows.length - 1]!.op = firstTouch ? "funding_first_touch_tx" : "funding_later_touch_tx";
}
const last = await pub.getBlock();

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: HERE }).toString().trim();
} catch {
  /* not a git checkout */
}
const date = new Date().toISOString().slice(0, 10);
const blockTimeMs = meanBlockTimeMs(first, last);
mkdirSync(`${HERE}out`, { recursive: true });
const net = networkLabel(CHAIN_ID, await pub.request({ method: "web3_clientVersion" }));
const file = `${HERE}out/gas_onchain_${net}_${date}.csv`;
writeFileSync(file, [GAS_CSV_HEADER, ...rows.map((r) => gasCsvRow(r, { commit, date, chainId: CHAIN_ID, blockTimeMs }))].join("\n") + "\n");

// summary vs Foundry (Ethereum schedule). Receipts include the 21k base + calldata; Foundry rows are execution only.
const byOp = new Map<string, bigint[]>();
for (const r of rows) byOp.set(r.op, [...(byOp.get(r.op) ?? []), r.gasUsed]);
const foundryFile = `${HERE}../contracts/bench-out/real_engine_gas.csv`;
const foundry = existsSync(foundryFile) ? parseFoundryCsv(readFileSync(foundryFile, "utf8")) : new Map();
console.log(`chain ${CHAIN_ID}, blocks ${first.number}..${last.number}, mean block ${blockTimeMs.toFixed(0)} ms, commit ${commit} → ${file}`);
console.log("op | receipt gasUsed (median) | Foundry execution gas | target");
for (const [op, xs] of byOp) {
  const s = [...xs].sort((a, b) => (a < b ? -1 : 1));
  const med = s[Math.floor(s.length / 2)]!;
  const f = foundry.get(op === "funding_first_touch_tx" ? "funding_first_touch_tx" : op);
  console.log(`${op} | ${med} | ${f ? f.gas : "—"} | ${f?.target ?? ""}`);
}
