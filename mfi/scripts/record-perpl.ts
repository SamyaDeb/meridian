// Record real Perpl public market-data responses as fixtures (run where perpl.xyz is reachable).
//   pnpm --filter @meridian/mfi record:perpl [testnet|mainnet] [SYMBOL=MON]
// Writes fixtures/recorded/<network>/{context,ticker-<id>,funding-<id>}.json with the raw bodies plus `_recorded` metadata.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERPL_API_URL } from "../src/perpl/transport";
import { matchMarket } from "../src/perpl/client";
import { parseContext } from "../src/perpl/validate";

const network = (process.argv[2] ?? "testnet") as keyof typeof PERPL_API_URL;
const symbol = (process.argv[3] ?? "MON").toUpperCase();
const base = process.env.PERPL_API_URL ?? PERPL_API_URL[network];
if (!base) throw new Error(`unknown network ${network}`);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "recorded", network);
mkdirSync(out, { recursive: true });

async function rec(name: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  const body = (await res.json()) as Record<string, unknown>;
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ ...body, _recorded: { url: `${base}${path}`, status: res.status, at: new Date().toISOString() } }, null, 2)}\n`);
  console.log(`${res.status} ${path} → ${name}.json`);
  return body;
}

const ctx = parseContext(await rec("context", "/v1/pub/context"));
const m = matchMarket(ctx.markets, symbol);
if (!m) throw new Error(`no market ${symbol}; symbol/name: ${ctx.markets.map((x) => x.symbol || x.name).join(", ")}`);
const now = Date.now();
await rec(`ticker-${m.id}`, `/v1/market-data/${m.id}/ticker`);
await rec(`funding-${m.id}`, `/v1/market-data/${m.id}/funding/${now - 24 * 3600_000}-${now + m.funding_interval_sec * 1000}`);
