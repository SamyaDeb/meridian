// Evidence for an unattended keeper + MM run (gate G3). Read-only.
//   sample: every 60 s, append {t, block, bestBid, bestAsk, keeper/MM balances} to $OUT/book-<market>.jsonl
//   report: FundingUpdated max gap over [FROM, latest] (getLogs chunked to 100 blocks, R2) + book summary + MON spent
// env: CHAIN_ID, RPC_URL, DEPLOYMENTS, MARKET (main|demo), OUT, WATCH (comma-separated addresses), FROM (report)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { type Address, createPublicClient, formatEther, http, parseAbi } from "viem";
import { blockRanges } from "../src/decide.js";
import { type BookSample, maxFundingGap, summarizeBook } from "../src/evidence.js";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const mode = process.argv[2] ?? "report";
const dep = JSON.parse(readFileSync(env("DEPLOYMENTS"), "utf8")) as {
  contracts: { ClearingHouse: Address; OrderBook: Address };
  demoMarket?: { ClearingHouse: Address; OrderBook: Address };
};
const market = env("MARKET", "main");
const m = market === "demo" ? dep.demoMarket! : dep.contracts;
const out = env("OUT");
const watch = (process.env.WATCH ?? "").split(",").filter((a) => a !== "") as Address[];
const pub = createPublicClient({ transport: http(env("RPC_URL")) });
const obAbi = parseAbi(["function bestBid() view returns (uint32)", "function bestAsk() view returns (uint32)"]);
const chAbi = parseAbi([
  "event FundingUpdated(uint64 indexed blockNumber, int256 premium, int256 emaPremium, int256 rate, int256 cumFunding, int256 cumIndexTime, uint256 indexPrice, uint256 markPrice)",
]);
const bookFile = `${out}/book-${market}.jsonl`;

async function sample(): Promise<void> {
  const [block, bid, ask, ...bals] = await Promise.all([
    pub.getBlockNumber(),
    pub.readContract({ address: m.OrderBook, abi: obAbi, functionName: "bestBid" }),
    pub.readContract({ address: m.OrderBook, abi: obAbi, functionName: "bestAsk" }),
    ...watch.map((a) => pub.getBalance({ address: a })),
  ]);
  const row = {
    t: Math.floor(Date.now() / 1000),
    block: block.toString(),
    bestBidTick: bid === 0 ? null : bid,
    bestAskTick: ask === 0xffffffff ? null : ask,
    balances: Object.fromEntries(watch.map((a, i) => [a, formatEther(bals[i] as bigint)])),
  };
  appendFileSync(bookFile, JSON.stringify(row) + "\n");
}

async function report(): Promise<void> {
  const from = BigInt(env("FROM"));
  const to = await pub.getBlockNumber();
  const blocks: bigint[] = [];
  for (const [a, b] of blockRanges(from, to, 100n)) {
    const logs = await pub.getContractEvents({ address: m.ClearingHouse, abi: chAbi, eventName: "FundingUpdated", fromBlock: a, toBlock: b, strict: true });
    for (const l of logs) blocks.push(l.args.blockNumber);
  }
  const rows = existsSync(bookFile) ? readFileSync(bookFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const samples: BookSample[] = rows.map((r) => ({ t: r.t, block: BigInt(r.block), bestBidTick: r.bestBidTick, bestAskTick: r.bestAskTick }));
  const first = rows[0]?.balances ?? {};
  const last = rows[rows.length - 1]?.balances ?? {};
  const spent = Object.fromEntries(Object.keys(first).map((a) => [a, (Number(first[a]) - Number(last[a] ?? first[a])).toFixed(6)]));
  const firstT = rows[0]?.t;
  const lastT = rows[rows.length - 1]?.t;
  console.log(
    JSON.stringify(
      {
        market,
        blocks: { from: from.toString(), to: to.toString() },
        fundingUpdated: { count: blocks.length, maxGapBlocks: maxFundingGap(blocks, from, to).toString() },
        book: summarizeBook(samples, 20),
        durationSec: firstT !== undefined && lastT !== undefined ? lastT - firstT : 0,
        monSpent: spent,
      },
      null,
      2,
    ),
  );
}

if (mode === "sample") {
  await sample();
  setInterval(() => void sample().catch((e: unknown) => console.error(String(e))), 60_000);
} else {
  await report();
}
