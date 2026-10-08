#!/usr/bin/env node
// K2.2 evidence: pull every position event of one Perpl market over a block window (HyperSync), check the event
// semantics we rely on (lots continuity: an event's startLotLNS = the previous endLotLNS; side of PositionInverted),
// read the contract's own getPosition at the window's last block for the accounts that moved, and write a replay
// fixture for test/replay-perpl.test.ts (accounts whose whole position history is inside the window + every
// liquidation, plus the market's funding events and the contract answers).
//   ENVIO_API_TOKEN=… RPC_URL=… node scripts/verify-perpl-positions.mjs <chainId> <perpId> [blocksBack] [maxAccounts=12]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { createPublicClient, decodeEventLog, http, toEventSelector, getAddress } = createRequire(import.meta.resolve("envio"))("viem");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEXER = resolve(HERE, "..");
const chainId = Number(process.argv[2] ?? 10143);
const perpId = BigInt(process.argv[3] ?? 64);
const blocksBack = Number(process.argv[4] ?? 245_000);
const maxAccounts = Number(process.argv[5] ?? 12);
const perpl = JSON.parse(readFileSync(resolve(INDEXER, "../deployments/perpl.json"), "utf8"));
const exchange = perpl.chains[String(chainId)].exchange;
const abi = JSON.parse(readFileSync(resolve(INDEXER, "abis/PerplExchange.json"), "utf8"));
const POS = [
  "PositionOpenedV2", "PositionIncreasedV2", "PositionDecreased", "PositionClosed", "PositionInverted", "PositionLiquidated",
  "IncreasePositionCollateral", "PositionCollateralDecreased",
];
const EVENTS = [...POS, "FundingEventCompleted", "AccountCreated", "CollateralDeposit", "CollateralWithdrawal"];
const evAbi = (n) => abi.find((x) => x.type === "event" && x.name === n);
const token = process.env.ENVIO_API_TOKEN;
const hs = async (path, body) => {
  for (let i = 0; ; i++) {
    const r = await fetch(`https://${chainId}.hypersync.xyz${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < 6) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
      continue;
    }
    throw new Error(`${path} ${r.status}`);
  }
};

const { height } = await hs("/height");
const from = height - blocksBack;
let next = from;
const logs = [];
const ts = new Map();
const txs = new Map();
while (next < height) {
  const r = await hs("/query", {
    from_block: next,
    to_block: height,
    logs: [{ address: [exchange], topics: [EVENTS.map((n) => toEventSelector(evAbi(n)))] }],
    field_selection: {
      log: ["block_number", "log_index", "transaction_hash", "topic0", "data"],
      block: ["number", "timestamp"],
    },
  });
  for (const p of r.data) {
    for (const b of p.blocks ?? []) ts.set(Number(b.number), Number(b.timestamp));
    for (const l of p.logs) {
      const d = decodeEventLog({ abi, data: l.data, topics: [l.topic0], strict: true });
      if (d.args.perpId !== undefined && d.args.perpId !== perpId) continue;
      logs.push({ name: d.eventName, block: Number(l.block_number), logIndex: Number(l.log_index), tx: l.transaction_hash, args: d.args });
    }
  }
  if (!(r.next_block > next)) break;
  next = r.next_block;
  process.stderr.write(`\r${next}/${height} ${logs.length}`);
}
process.stderr.write("\n");
const end = Math.max(...logs.map((l) => l.block));
logs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

// ── semantics checks over the whole window ──
const acct = (a) => String(a.accountId ?? a.posAccountId);
const state = new Map(); // accountId -> { lots, side, deposit, entry }
const breaks = [];
const depositBreaks = [];
const inversions = [];
let n = 0;
for (const l of logs) {
  if (!POS.includes(l.name)) continue;
  n++;
  const a = l.args;
  const k = acct(a);
  const s = state.get(k);
  const start = a.startLotLNS;
  if (s && start !== undefined && s.lots !== start) breaks.push({ k, name: l.name, block: l.block, have: String(s.lots), start: String(start) });
  if (s && a.startDepositCNS !== undefined && s.deposit !== undefined && s.deposit !== a.startDepositCNS) {
    depositBreaks.push({ k, name: l.name, block: l.block, have: String(s.deposit), start: String(a.startDepositCNS) });
  }
  // a collateral top-up carries no lots: for a position not seen yet it says nothing about lots (the handler skips it too)
  if (l.name === "IncreasePositionCollateral" && !s) continue;
  if (l.name === "PositionInverted") inversions.push({ k, block: l.block, before: s ? { side: s.side, lots: String(s.lots) } : null, positionType: a.positionType, startLot: String(a.startLotLNS), endLot: String(a.endLotLNS) });
  const lots =
    l.name === "PositionOpenedV2" ? a.lotLNS
    : l.name === "PositionClosed" ? 0n
    : l.name === "PositionLiquidated" ? a.posLotLNS
    : a.endLotLNS ?? s?.lots ?? 0n;
  const deposit =
    l.name === "PositionOpenedV2" ? a.depositCNS
    : l.name === "PositionClosed" ? 0n
    : l.name === "PositionLiquidated" ? a.posDepositCNS
    : l.name === "IncreasePositionCollateral" ? a.positionDepositCNS
    : a.endDepositCNS;
  const entry = a.endEntryPricePNS ?? a.pricePNS ?? (lots === 0n ? 0n : s?.entry);
  state.set(k, { lots, side: a.positionType ?? s?.side, deposit, entry });
}

// ── the contract's answer at `end` for accounts that moved in the window ──
const client = createPublicClient({ transport: http(process.env.RPC_URL) });
const touched = [...state.keys()];
const chosen = [];
for (const k of touched) {
  const evs = logs.filter((l) => POS.includes(l.name) && acct(l.args) === k);
  if (evs[0].name === "PositionOpenedV2" && chosen.length < maxAccounts) chosen.push(k);
}
const liquidated = [...new Set(logs.filter((l) => l.name === "PositionLiquidated").map((l) => acct(l.args)))];
const keep = [...new Set([...chosen, ...liquidated])];
const answers = {};
const viewFn = abi.find((x) => x.type === "function" && x.name === "getPosition");
const mismatches = [];
for (const k of keep) {
  const [pos] = await client.readContract({ address: exchange, abi: [viewFn], functionName: "getPosition", args: [perpId, BigInt(k)], blockNumber: BigInt(end) });
  answers[k] = { positionType: Number(pos.positionType), lotLNS: pos.lotLNS, depositCNS: pos.depositCNS, pricePNS: pos.pricePNS };
  const s = state.get(k);
  const bad =
    s.lots !== pos.lotLNS ||
    (pos.lotLNS > 0n && (Number(s.side) !== Number(pos.positionType) || s.deposit !== pos.depositCNS || s.entry !== pos.pricePNS));
  if (bad) {
    mismatches.push({
      k,
      model: { lots: String(s.lots), side: Number(s.side), deposit: String(s.deposit), entry: String(s.entry) },
      contract: { lots: String(pos.lotLNS), side: Number(pos.positionType), deposit: String(pos.depositCNS), entry: String(pos.pricePNS) },
    });
  }
}
const info = await client.readContract({
  address: exchange,
  abi: [abi.find((x) => x.type === "function" && x.name === "getPerpetualInfo")],
  functionName: "getPerpetualInfo",
  args: [perpId],
  blockNumber: BigInt(end),
});

// ── replay fixture (Envio simulate items) ──
const keepSet = new Set(keep);
const accountsOf = new Set(keep);
const items = logs
  .filter((l) => (POS.includes(l.name) ? keepSet.has(acct(l.args)) : l.name === "FundingEventCompleted" || accountsOf.has(String(l.args.accountId ?? l.args.id))))
  .map((l) => ({
    contract: "PerplExchange",
    event: l.name,
    srcAddress: getAddress(exchange),
    logIndex: l.logIndex,
    block: { number: l.block, timestamp: ts.get(l.block) },
    transaction: { hash: l.tx },
    params: Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, typeof v === "number" ? BigInt(v) : v])),
  }));
const big = (_, v) => (typeof v === "bigint" ? `${v}n` : v);
const dir = resolve(INDEXER, `test/fixtures/perpl-${chainId}`);
mkdirSync(dir, { recursive: true });
const counts = Object.fromEntries(EVENTS.map((e) => [e, logs.filter((l) => l.name === e).length]));
const report = {
  chainId,
  perpId: String(perpId),
  exchange,
  fromBlock: from,
  atBlock: end,
  recordedAt: new Date().toISOString(),
  counts,
  positionEvents: n,
  accountsTouched: touched.length,
  continuityBreaks: breaks.length,
  depositContinuityBreaks: depositBreaks.length,
  inversions,
  contractCheckedAccounts: keep.length,
  contractMismatches: mismatches,
  contractOpenInterest: { longLNS: String(info.longOpenInterestLNS), shortLNS: String(info.shortOpenInterestLNS) },
};
writeFileSync(resolve(dir, `replay-${perpId}.json`), JSON.stringify({ ...report, answers, items }, big, 2) + "\n");
console.log(JSON.stringify({ ...report, breaks: breaks.slice(0, 10), depositBreaks: depositBreaks.slice(0, 10), fixtureItems: items.length }, big, 2));
