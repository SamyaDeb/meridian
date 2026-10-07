#!/usr/bin/env node
// Seeds deployments/perpl.json with Perpl's market metadata (name, decimals, funding interval) from its public context
// endpoint, once, so handlers never hard-code it and never call the network (K2.2). Then run gen-config, which turns
// the snapshot into src/perpl.gen.ts.
//   node scripts/seed-perpl.mjs            # every chain in deployments/perpl.json
// The exchange address must match the endpoint's instance (a mismatch is an error, never silently replaced).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FILE = resolve(HERE, "../../deployments/perpl.json");

/** Pure: context response → the snapshot we keep (markets keyed by perpetual id). */
export function snapshotFromContext(ctx, chainId, exchange) {
  if (Number(ctx?.chain?.chain_id) !== Number(chainId)) throw new Error(`context chain ${ctx?.chain?.chain_id} != ${chainId}`);
  const inst = (ctx.instances ?? []).find((i) => String(i.address).toLowerCase() === exchange.toLowerCase());
  if (!inst) throw new Error(`exchange ${exchange} is not an instance in the ${chainId} context`);
  const token = (ctx.tokens ?? []).find((t) => t.id === inst.collateral_token_id);
  if (!token || !Number.isInteger(token.decimals)) throw new Error(`no collateral token for instance ${inst.id}`);
  const markets = {};
  for (const m of ctx.markets ?? []) {
    if (m.instance_id !== inst.id) continue;
    const c = m.config ?? {};
    for (const k of ["price_decimals", "size_decimals", "funding_sum_scaling_exp"]) {
      if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 18) throw new Error(`market ${m.id}: bad ${k} ${c[k]}`);
    }
    if (!(Number.isInteger(m.funding_interval_sec) && m.funding_interval_sec > 0)) throw new Error(`market ${m.id}: bad funding_interval_sec`);
    markets[String(m.perpetual_id)] = {
      name: m.name,
      symbol: m.symbol,
      priceDecimals: c.price_decimals,
      sizeDecimals: c.size_decimals,
      fundingSumScalingExp: c.funding_sum_scaling_exp,
      fundingIntervalSec: m.funding_interval_sec,
      fundingIntervalBlocks: m.funding_interval_blocks,
      contractVersion: c.contract_version,
    };
  }
  return { collateralSymbol: token.symbol, collateralDecimals: token.decimals, collateralToken: token.address, markets };
}

/** Pure: the MON market; mainnet lists it with an empty symbol and name "MON" (docs/MFI.md §2 (d)). */
export function findMon(markets) {
  const hit = Object.entries(markets).filter(([, m]) => (m.symbol || m.name).toUpperCase().replace(/ PERP$/, "") === "MON");
  if (hit.length !== 1) throw new Error(`expected exactly one MON market, found ${hit.length}`);
  return Number(hit[0][0]);
}

async function main() {
  const doc = JSON.parse(readFileSync(FILE, "utf8"));
  for (const [chainId, c] of Object.entries(doc.chains)) {
    const res = await fetch(c.contextUrl);
    if (!res.ok) throw new Error(`${c.contextUrl}: HTTP ${res.status}`);
    const snap = snapshotFromContext(await res.json(), chainId, c.exchange);
    const mon = findMon(snap.markets);
    doc.chains[chainId] = { ...c, fetched: new Date().toISOString().slice(0, 10), monMarketId: mon, ...snap };
    console.log(`${chainId}: ${Object.keys(snap.markets).length} markets, MON = ${mon}`);
  }
  writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
