#!/usr/bin/env node
// Records Perpl Exchange logs from Envio HyperSync and decodes them with the vendored ABI (abis/PerplExchange.json),
// so we only index events the deployed contract really emits with the ABI's exact signatures (K2.0 VERIFY).
//   ENVIO_API_TOKEN=… node scripts/record-perpl.mjs <chainId> [blocksBack=120000] [samplesPerEvent=4] [Event,Event,…]
// The optional event list filters on topic0 (HyperSync side), e.g. the events the indexer handles.
// Writes test/fixtures/perpl-<chainId>/summary.json (count per event name, undecoded topic0s, range) and one
// <Event>.json per seen event with up to `samplesPerEvent` raw logs + decoded args (bigints as "123n").
// The address comes from deployments/perpl.json (never hard-coded).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// viem from envio's own dependency (no extra package in the indexer; envio 3.12.1 ships viem 2.54)
const { decodeEventLog, toEventSelector } = createRequire(import.meta.resolve("envio"))("viem");

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEXER = resolve(HERE, "..");
const chainId = Number(process.argv[2] ?? 10143);
const blocksBack = Number(process.argv[3] ?? 120_000);
const samples = Number(process.argv[4] ?? 4);
const only = process.argv[5] ? process.argv[5].split(",") : undefined;
const MAX_LOGS = Number(process.env.MAX_LOGS ?? 400_000); // stop paging past this many logs (busy ranges)

const perpl = JSON.parse(readFileSync(resolve(INDEXER, "../deployments/perpl.json"), "utf8"));
const address = perpl.chains[String(chainId)]?.exchange;
if (!address) throw new Error(`deployments/perpl.json has no exchange for chain ${chainId}`);
const token = process.env.ENVIO_API_TOKEN;
if (!token) throw new Error("ENVIO_API_TOKEN is required (HyperSync)");
const base = `https://${chainId}.hypersync.xyz`;
const abi = JSON.parse(readFileSync(resolve(INDEXER, "abis/PerplExchange.json"), "utf8"));
const bySelector = new Map(abi.filter((x) => x.type === "event").map((e) => [toEventSelector(e), e.name]));
const topic0 = only?.map((n) => {
  const e = abi.find((x) => x.type === "event" && x.name === n);
  if (!e) throw new Error(`no event ${n} in the ABI`);
  return toEventSelector(e);
});

/** HyperSync request; 429 / 5xx back off exponentially (1 s → 32 s, 6 tries). */
const post = async (path, body) => {
  for (let i = 0; ; i++) {
    const res = await fetch(base + path, {
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

const { height } = await post("/height");
const to = height;
const from = Math.max(0, to - blocksBack);
const counts = {};
const unknown = {};
const kept = {};
const ts = new Map();
let next = from;
let total = 0;
while (next < to && total < MAX_LOGS) {
  const r = await post("/query", {
    from_block: next,
    to_block: to,
    logs: [topic0 ? { address: [address], topics: [topic0] } : { address: [address] }],
    field_selection: {
      log: ["block_number", "log_index", "transaction_hash", "address", "topic0", "topic1", "topic2", "topic3", "data"],
      block: ["number", "timestamp"],
    },
  });
  for (const page of r.data ?? []) {
    for (const b of page.blocks ?? []) ts.set(Number(b.number), Number(b.timestamp));
    for (const l of page.logs ?? []) {
      total++;
      const name = bySelector.get(l.topic0);
      if (!name) {
        unknown[l.topic0] = (unknown[l.topic0] ?? 0) + 1;
        continue;
      }
      const topics = [l.topic0, l.topic1, l.topic2, l.topic3].filter(Boolean);
      let args;
      try {
        args = decodeEventLog({ abi, data: l.data, topics, strict: true }).args;
      } catch (e) {
        counts[`${name} (DECODE FAILED)`] = (counts[`${name} (DECODE FAILED)`] ?? 0) + 1;
        continue;
      }
      counts[name] = (counts[name] ?? 0) + 1;
      const k = (kept[name] ??= []);
      if (k.length < samples) k.push({ ...l, args });
    }
  }
  if (!(r.next_block > next)) break;
  next = r.next_block;
  process.stderr.write(`\r${chainId}: block ${next} / ${to}, ${total} logs`);
}
process.stderr.write("\n");

const big = (_, v) => (typeof v === "bigint" ? `${v}n` : v);
const dir = resolve(INDEXER, `test/fixtures/perpl-${chainId}`);
mkdirSync(dir, { recursive: true });
for (const [name, logs] of Object.entries(kept)) {
  const withTs = logs.map((l) => ({ ...l, timestamp: ts.get(Number(l.block_number)) ?? null }));
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(withTs, big, 2) + "\n");
}
const summary = {
  chainId,
  address,
  fromBlock: from,
  filter: only ?? "all events",
  toBlock: next,
  head: to,
  recordedAt: new Date().toISOString(),
  totalLogs: total,
  truncated: total >= MAX_LOGS,
  counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
  unknownTopic0: unknown,
};
writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
