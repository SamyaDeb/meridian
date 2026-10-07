#!/usr/bin/env node
// K2.5: check a hosted endpoint against the app and measure it.
//   node scripts/measure-indexer.mjs <graphql-url> [runs=20]
// 1. introspects the root fields (every entity the app reads must exist);
// 2. runs every query the app sends (the exact text, read from app/src/data/indexer/*.ts) with real variables,
//    and fails on a GraphQL error;
// 3. p50 / p95 latency over `runs` calls for the Trade, Rates and Stats queries;
// 4. sync state: Envio's chain metadata root field when exposed, and lag at head vs HyperSync's height.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const url = process.argv[2];
const runs = Number(process.argv[3] ?? 20);
if (!url) throw new Error("usage: measure-indexer.mjs <graphql-url> [runs]");

const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments/10143.json"), "utf8"));
const perpl = JSON.parse(readFileSync(resolve(ROOT, "deployments/perpl.json"), "utf8"));
const VARS = {
  chainId: 10143,
  market: dep.contracts.ClearingHouse,
  ch: dep.contracts.ClearingHouse,
  oracle: dep.contracts.OracleAdapter,
  vault: dep.contracts.MeridianVault,
  a: dep.mmAccounts[0],
  me: dep.mmAccounts[0],
  limit: 50,
};

async function gql(query, variables) {
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const ms = performance.now() - t0;
  const body = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}` }] }));
  return { ms, body };
}

/** Exact query text from the app's readers (template literals; `${monPerpId}` filled per chain). */
function appQueries() {
  const dir = resolve(ROOT, "app/src/data/indexer");
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
    const src = readFileSync(resolve(dir, f), "utf8");
    for (const m of src.matchAll(/`(query (\w+)[ (][^`]*?)`/gs)) {
      let text = m[1].replaceAll("${monPerpId}", String(perpl.chains["10143"].monMarketId));
      if (text.includes("${table}")) {
        for (const t of ["Candle1m", "Candle1h"]) out.push({ file: f, name: `${m[2]}:${t}`, text: text.replaceAll("${table}", t) });
        continue;
      }
      out.push({ file: f, name: m[2], text });
    }
  }
  return out;
}

const declared = (text) => [...text.matchAll(/\$(\w+):/g)].map((m) => m[1]);
const varsFor = (text) => Object.fromEntries(declared(text).map((k) => [k, VARS[k]]));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// 1. root fields
const intro = await gql("{ __schema { queryType { fields { name } } } }");
const roots = new Set((intro.body.data?.__schema?.queryType?.fields ?? []).map((f) => f.name));
const needed = ["Market", "FundingWindow", "FundingPayment", "CrossVenueFunding", "ProtocolDaily", "InsuranceFundEvent", "PerplMarket", "PerplFunding", "PerplLiquidation", "VaultSnapshot", "AccountMarket", "ProtocolStats", "Candle1m"];
const missing = needed.filter((n) => !roots.has(n));
console.log(`root fields: ${roots.size}; aggregate fields: ${[...roots].filter((r) => r.endsWith("_aggregate")).length}; missing: ${missing.join(", ") || "none"}`);

// 2. every app query
let failed = 0;
for (const q of appQueries()) {
  const { ms, body } = await gql(q.text, varsFor(q.text));
  const err = body.errors?.[0]?.message;
  const counts = body.data ? Object.entries(body.data).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : "?"}`).join(" ") : "";
  if (err) failed++;
  console.log(`${err ? "FAIL" : "ok  "} ${q.name.padEnd(32)} ${ms.toFixed(0).padStart(5)} ms  ${err ?? counts}`);
}

// 3. latency of the screen queries
const byName = Object.fromEntries(appQueries().map((q) => [q.name, q.text]));
const screens = { Trade: "MeridianFundingWindow", Rates: "MeridianCrossVenue", Stats: "MeridianStats" };
for (const [screen, name] of Object.entries(screens)) {
  const text = byName[name];
  if (!text) continue;
  const ms = [];
  for (let i = 0; i < runs; i++) ms.push((await gql(text, varsFor(text))).ms);
  console.log(`latency ${screen.padEnd(6)} (${name}): p50 ${pct(ms, 50).toFixed(0)} ms, p95 ${pct(ms, 95).toFixed(0)} ms over ${runs}`);
}

// 4. sync state
const metaField = ["chain_metadata", "_meta"].find((f) => roots.has(f));
if (metaField) {
  const t = await gql(`{ __type(name: "${metaField}") { fields { name type { kind name ofType { name } } } } }`);
  const scalars = (t.body.data?.__type?.fields ?? []).filter((f) => f.type.kind === "SCALAR" || f.type.ofType?.name).map((f) => f.name);
  const m = await gql(`{ ${metaField} { ${scalars.join(" ")} } }`);
  for (const c of m.body.data?.[metaField] ?? []) {
    const lag = c.block_height !== undefined && c.latest_processed_block !== undefined ? c.block_height - c.latest_processed_block : "?";
    console.log(`chain ${c.chain_id}: start ${c.start_block}, processed ${c.latest_processed_block} / head ${c.block_height} (lag ${lag} blocks), events ${c.num_events_processed}, caught up at ${c.timestamp_caught_up_to_head_or_endblock ?? "not yet"}`);
  }
}
const token = process.env.ENVIO_API_TOKEN;
for (const chain of [10143, 143]) {
  if (!token) break;
  const h = await (await fetch(`https://${chain}.hypersync.xyz/height`, { headers: { authorization: `Bearer ${token}` } })).json();
  console.log(`chain ${chain} head (HyperSync): ${h.height}`);
}
process.exit(failed || missing.length ? 1 : 0);
