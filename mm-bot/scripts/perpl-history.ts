// K3 evidence: READ the hedge account's Perpl trading history (signed GET only; never places or cancels anything).
// GET /v1/trading/{fills,order-history,position-history} (rest-endpoints.md "Trading History Endpoints": newest first,
// `count` ≤ 100, cursor `np`). Pages until the oldest item is older than `sinceMs`.
//   cd mm-bot && set -a && source ../.env && set +a && node_modules/.bin/tsx scripts/perpl-history.ts [sinceIso] [maxPages=20]
// Writes fixtures/recorded/testnet/history-{fills,order-history,position-history}.json (responses as returned; the
// key, timestamp, nonce and signature are request headers and never reach the files).
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { newNonce, parseSecret, restHeaders } from "../src/perpl/auth.js";

const sinceMs = Date.parse(process.argv[2] ?? "2026-10-07T19:00:00Z");
const maxPages = Number(process.argv[3] ?? "20");
const key = process.env.PERPL_API_KEY;
const secretHex = process.env.PERPL_API_KEY_SECRET;
if (!key || !secretHex) throw new Error("PERPL_API_KEY / PERPL_API_KEY_SECRET not set");
const secret = parseSecret(secretHex);
const base = "https://testnet.perpl.xyz/api";

type Page = { d: { at?: { t?: number } }[]; np?: string };
async function get(target: string): Promise<Page> {
  const h = await restHeaders(key!, secret, { chainId: 10143, method: "GET", target, timestampMs: Date.now(), nonce: newNonce(randomBytes), body: "" });
  const r = await fetch(`${base}${target}`, { headers: { ...h, accept: "application/json" } });
  if (r.status !== 200) throw new Error(`${target}: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as Page;
}

const dir = new URL("../fixtures/recorded/testnet/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
for (const kind of ["fills", "order-history", "position-history"]) {
  const pages: Page[] = [];
  let np: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ count: "100" });
    if (np) q.set("page", np);
    const p = await get(`/v1/trading/${kind}?${q.toString()}`);
    pages.push(p);
    np = p.np;
    const oldest = p.d.at(-1)?.at?.t;
    if (!np || !p.d.length || (oldest !== undefined && oldest < sinceMs)) break;
  }
  writeFileSync(`${dir}history-${kind}.json`, `${JSON.stringify({ recordedAt: new Date().toISOString(), since: new Date(sinceMs).toISOString(), pages }, null, 1)}\n`);
  console.log(kind, pages.reduce((n, p) => n + p.d.length, 0), "items in", pages.length, "page(s)");
}
