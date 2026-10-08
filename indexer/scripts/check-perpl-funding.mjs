#!/usr/bin/env node
// K2.0 unit check: every onchain FundingEventCompleted for one Perpl market vs Perpl's REST funding series
// (GET /v1/market-data/:id/funding/:fromMs-:toMs), joined on fundingEventBlock = feb.
//   ENVIO_API_TOKEN=… node scripts/check-perpl-funding.mjs <chainId> <perpId> [blocksBack=245000] [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// viem from envio's own dependency (no extra package in the indexer; envio 3.12.1 ships viem 2.54)
const { decodeEventLog, toEventSelector } = createRequire(import.meta.resolve("envio"))("viem");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEXER = resolve(HERE, "..");
const [chainId, perpId] = [Number(process.argv[2] ?? 10143), BigInt(process.argv[3] ?? 64)];
const blocksBack = Number(process.argv[4] ?? 245_000);
const perpl = JSON.parse(readFileSync(resolve(INDEXER, "../deployments/perpl.json"), "utf8"));
const chain = perpl.chains[String(chainId)];
const abi = JSON.parse(readFileSync(resolve(INDEXER, "abis/PerplExchange.json"), "utf8"));
const ev = abi.find((x) => x.type === "event" && x.name === "FundingEventCompleted");
const token = process.env.ENVIO_API_TOKEN;
/** HyperSync request; 429 / 5xx back off exponentially (1 s → 32 s, 6 tries). */
const hs = async (path, body) => {
  for (let i = 0; ; i++) {
    const res = await fetch(`https://${chainId}.hypersync.xyz${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < 6) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      continue;
    }
    throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  }
};
const { height } = await hs("/height");
let next = height - blocksBack;
const onchain = [];
while (next < height) {
  const r = await hs("/query", {
    from_block: next,
    to_block: height,
    logs: [{ address: [chain.exchange], topics: [[toEventSelector(ev)]] }],
    field_selection: { log: ["block_number", "log_index", "transaction_hash", "topic0", "data"], block: ["number", "timestamp"] },
  });
  const ts = new Map();
  for (const p of r.data) for (const b of p.blocks ?? []) ts.set(Number(b.number), Number(b.timestamp));
  for (const p of r.data)
    for (const l of p.logs) {
      const { args } = decodeEventLog({ abi: [ev], data: l.data, topics: [l.topic0], strict: true });
      if (args.perpId === perpId) onchain.push({ block: l.block_number, logIndex: l.log_index, tx: l.transaction_hash, timestamp: ts.get(Number(l.block_number)), ...args });
    }
  if (!(r.next_block > next)) break;
  next = r.next_block;
}
const t0 = Math.min(...onchain.map((o) => o.timestamp)) * 1000 - 3_600_000;
// the REST window is capped (3 days → 400 Bad Request; 2 days → OK): page in 1-day windows
const rows = [];
const now = Date.now() - 1_000; // a future "to" is a 400
for (let f = t0; f < now; f += 86_400_000) {
  const url = `${chain.contextUrl.replace("/pub/context", "")}/market-data/${perpId}/funding/${f}-${Math.min(f + 86_400_000 - 1, now)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  rows.push(...((await r.json()).d ?? []));
}
const byFeb = new Map(rows.map((r) => [String(r.feb), r]));
let matched = 0;
let rateEq = 0;
let rateX10 = 0;
let pplEq = 0;
let sumEq = 0;
const out = [];
for (const o of onchain) {
  const a = byFeb.get(String(o.fundingEventBlock));
  if (!a) continue;
  matched++;
  const rate = BigInt(a.rate);
  if (o.actualRatePct100k === rate) rateEq++;
  if (o.actualRatePct100k * 10n === rate) rateX10++;
  if (BigInt(o.fundingPaymentPNS) === BigInt(a.ppl)) pplEq++;
  if (BigInt(o.fundingSumPNS) === BigInt(a.sum)) sumEq++;
  out.push({ feb: String(o.fundingEventBlock), block: o.block, onchainRatePct100k: String(o.actualRatePct100k), specifiedRatePct100k: String(o.specifiedRatePct100k), apiRateMicros: a.rate, fundingPricePNS: String(o.fundingPricePNS), apiIdx: a.idx, ppl: o.fundingPaymentPNS, apiPpl: a.ppl, sum: o.fundingSumPNS, apiSum: a.sum, allowOverwrite: o.allowOverwrite });
}
const res = { chainId, perpId: String(perpId), onchainEvents: onchain.length, distinctFeb: new Set(onchain.map((o) => String(o.fundingEventBlock))).size, apiRows: rows.length, matched, rateEqualMicros: rateEq, rateTimes10EqualMicros: rateX10, pplEqual: pplEq, sumEqual: sumEq, rows: out };
if (process.argv[5]) writeFileSync(process.argv[5], JSON.stringify(res, null, 2) + "\n");
console.log(JSON.stringify({ ...res, rows: out.slice(0, 6) }, null, 2));
