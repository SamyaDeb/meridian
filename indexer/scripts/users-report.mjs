#!/usr/bin/env node
// K6 B3: print the user / product counts for docs/outputs/USERS.md from a hosted indexer (read-only GraphQL).
//   INDEXER_URL=https://… [CHAIN_ID=10143] node indexer/scripts/users-report.mjs [--json | --raw]
//   --raw prints { data, head } as returned (to record a test fixture: indexer/test/fixtures/metrics/).
// Excludes: operators (indexer, from deployments) and the labelled test wallets in docs/outputs/test-wallets.json.
// Lists an address only if it is in docs/outputs/users-consent.json (users who agreed to be named).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEAD_QUERY, METRICS_QUERY, computeMetrics, usersMarkdown } from "./lib/users.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const url = process.env.INDEXER_URL;
if (!url) throw new Error("INDEXER_URL required (the hosted GraphQL endpoint)");
const chainId = Number(process.env.CHAIN_ID ?? "10143");
const readList = (f, key) => {
  const p = join(root, "docs/outputs", f);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8"))[key].map((x) => (typeof x === "string" ? x : x.address)) : [];
};

async function gql(query, variables) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error(`indexer: HTTP ${r.status}`);
  const b = await r.json();
  if (b.errors?.length) throw new Error(`indexer: ${b.errors[0].message}`);
  return b.data;
}

const [data, head] = await Promise.all([gql(METRICS_QUERY, { chainId }), gql(HEAD_QUERY)]);
if (process.argv.includes("--raw")) {
  console.log(JSON.stringify({ recordedAt: new Date().toISOString(), chainId, data, head }, null, 1));
  process.exit(0);
}
const m = computeMetrics(data, head, { chainId, testWallets: readList("test-wallets.json", "wallets") });
if (process.argv.includes("--json")) console.log(JSON.stringify(m, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
else console.log(usersMarkdown(m, { consented: readList("users-consent.json", "consented"), accounts: data.Account.map((a) => a.id) }));
