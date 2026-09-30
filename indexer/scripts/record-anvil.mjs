#!/usr/bin/env node
// Records every event the local stack emitted on anvil into an Envio replay fixture (brief C2 §6: the live
// Envio run needs Docker; until then test/replay.test.ts replays this recording through createTestIndexer).
// Also records the contract's own answers at the last block (averageFundingApr, fundingState, openInterest)
// so the replay can check the indexer's realized APR against averageFundingApr at the same block.
//   RPC_URL=http://127.0.0.1:8546 node scripts/record-anvil.mjs [out.json]
// Testnet (after the DeployPulse broadcast; public RPC caps eth_getLogs at 100 blocks, R2/R29):
//   RPC_URL=$MONAD_TESTNET_RPC_URL DEPLOYMENTS=../deployments/10143.json LOG_SPAN=100 \
//     node scripts/record-anvil.mjs test/fixtures/testnet-10143.json
// The labelled demo market (deployments.demoMarket) is recorded too.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, http } from "viem";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const OUT = resolve(process.argv[2] ?? resolve(HERE, "../test/fixtures/anvil-e2e.json"));
const SPAN = BigInt(process.env.LOG_SPAN ?? "20000");

const dep = JSON.parse(readFileSync(resolve(process.env.DEPLOYMENTS ?? resolve(ROOT, "deployments/31337.json")), "utf8"));
if (dep.deployed === false) throw new Error("deployments file is a NOT DEPLOYED placeholder");
const abi = (n) => JSON.parse(readFileSync(resolve(ROOT, `abis/${n}.json`), "utf8"));
// Envio contract name → (deployments key, ABI). The oracle on anvil is the mock (same events as IOracleAdapter).
const SOURCES = [
  ["ClearingHouse", "ClearingHouse", abi("ClearingHouse")],
  ["OrderBook", "OrderBook", abi("OrderBook")],
  ["InsuranceFund", "InsuranceFund", abi("InsuranceFund")],
  ["OracleAdapter", "OracleAdapter", abi("IOracleAdapter")],
  ["MarketFactory", "MarketFactory", abi("MarketFactory")],
];
// the labelled demo market's contracts (DeployPulse on 10143), same event sources under the same Envio names
const DEMO = dep.demoMarket
  ? [
      ["ClearingHouse", dep.demoMarket.ClearingHouse, abi("ClearingHouse")],
      ["OrderBook", dep.demoMarket.OrderBook, abi("OrderBook")],
      ["OracleAdapter", dep.demoMarket.OracleAdapter, abi("IOracleAdapter")],
    ]
  : [];

const pub = createPublicClient({ transport: http(RPC_URL) });
const head = await pub.getBlockNumber();
const start = BigInt(dep.startBlock ?? 0);

const raw = [];
for (const [contract, keyOrAddress, contractAbi] of [...SOURCES, ...DEMO]) {
  const address = keyOrAddress.startsWith("0x") ? keyOrAddress : dep.contracts[keyOrAddress];
  if (address === undefined) continue;
  for (let s = start; s <= head; s += SPAN) {
    const e = s + SPAN - 1n < head ? s + SPAN - 1n : head;
    for (const l of await pub.getLogs({ address, fromBlock: s, toBlock: e })) {
      let ev;
      try {
        ev = decodeEventLog({ abi: contractAbi, data: l.data, topics: l.topics });
      } catch {
        continue; // e.g. OZ Ownable events not indexed
      }
      raw.push({ contract, event: ev.eventName, srcAddress: address, l, params: ev.args });
    }
  }
}
raw.sort((a, b) => (a.l.blockNumber === b.l.blockNumber ? a.l.logIndex - b.l.logIndex : a.l.blockNumber < b.l.blockNumber ? -1 : 1));

const ts = new Map();
for (const b of new Set(raw.map((r) => r.l.blockNumber))) ts.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp));

const items = raw.map((r) => ({
  contract: r.contract,
  event: r.event,
  srcAddress: r.srcAddress,
  logIndex: r.l.logIndex,
  block: { number: Number(r.l.blockNumber), timestamp: ts.get(r.l.blockNumber) },
  transaction: { hash: r.l.transactionHash },
  params: r.params,
}));

// Contract answers at the recording's last FundingUpdated block (the indexer's latest state)
const lastFunding = [...items].reverse().find((i) => i.event === "FundingUpdated");
const at = BigInt(lastFunding.block.number);
const CH = dep.contracts.ClearingHouse;
const chAbi = abi("ClearingHouse");
const read = (functionName, args = []) => pub.readContract({ address: CH, abi: chAbi, functionName, args, blockNumber: at });
const apr = {};
for (const [name, blocks] of [["1h", 12_000n], ["8h", 96_000n], ["24h", 288_000n]]) {
  try {
    apr[name] = await read("averageFundingApr", [blocks]);
  } catch {
    apr[name] = null; // ObservationTooOld: not enough history
  }
}
// 1 h APR at every 10th checkpoint with ≥ 1 h of history: the contract's answer at that block vs the indexer's
// FundingCheckpoint.realizedApr1hWad (same semantics: latest F/G at the block vs the checkpoint ≤ block − 12,000).
const cps = items.filter((i) => i.event === "FundingCheckpoint" && i.block.number >= Number(start) + 12_000 + 200);
const checkpointApr1h = [];
for (let k = 0; k < cps.length; k += 10) {
  const b = BigInt(cps[k].block.number);
  try {
    checkpointApr1h.push({ block: Number(b), slot: cps[k].params.slot, apr: await pub.readContract({ address: CH, abi: chAbi, functionName: "averageFundingApr", args: [12_000n], blockNumber: b }) });
  } catch {
    /* anvil pruned that block's state: historical eth_call unavailable */
  }
}
const [longOI, shortOI] = await read("openInterest");
const fs = await read("fundingState");

const out = {
  chainId: Number(dep.chainId),
  rpc: RPC_URL,
  startBlock: Number(start),
  endBlock: Number(head),
  atBlock: Number(at),
  counts: Object.fromEntries([...new Set(items.map((i) => `${i.contract}.${i.event}`))].map((k) => [k, items.filter((i) => `${i.contract}.${i.event}` === k).length])),
  expected: { averageFundingApr: apr, checkpointApr1h, longOI, shortOI, cumFunding: fs.cumFunding, cumIndexTime: fs.cumIndexTime },
  items,
};
// bigint → "123n" (revived by test/replay.test.ts)
writeFileSync(OUT, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
console.log(`wrote ${OUT}: ${items.length} events, blocks ${start}..${head}, APR at ${at}:`, apr);
console.log(out.counts);
