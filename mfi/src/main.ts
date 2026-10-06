// MFI v0 service: `pnpm --filter @meridian/mfi start`. Env (never hard-coded, CLAUDE.md §7):
//   MFI_CHAIN_ID           10143 (default) | 143; picks deployments/<id>.json and the RPC env below
//   MONAD_TESTNET_RPC_URL  / MONAD_RPC_URL  RPC for 10143 / 143 (required)
//   PERPL_API_URL          default: Perpl's documented URL for the matching network (transport.ts)
//   PERPL_SYMBOL           Perpl market symbol (default MON; > VERIFY in docs/MFI.md §2)
//   PORT                   default 8787;  MFI_CYCLE_MS default 60000
//   MFI_HISTORY_PATH       append-only JSONL history (decision D7), default mfi/data/history.jsonl (gitignored);
//                          reloaded on start, trimmed to 7 days
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createPublicClient, http, type Address } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { handle } from "./api/handler";
import { readMeridianVenue } from "./meridian/read";
import { JsonlHistory } from "./mfi/historyStore";
import { MfiService } from "./mfi/service";
import { fileURLToPath } from "node:url";
import { PERPL_API_URL, createPerplClient, httpTransport, readPerplVenue, type Market } from "./perpl";

const chainId = Number(process.env.MFI_CHAIN_ID ?? "10143");
if (chainId !== 10143 && chainId !== 143) throw new Error("MFI_CHAIN_ID must be 10143 or 143");
const rpc = chainId === 143 ? process.env.MONAD_RPC_URL : process.env.MONAD_TESTNET_RPC_URL;
if (!rpc) throw new Error(`missing ${chainId === 143 ? "MONAD_RPC_URL" : "MONAD_TESTNET_RPC_URL"}`);
const dep = JSON.parse(readFileSync(new URL(`../../deployments/${chainId}.json`, import.meta.url), "utf8")) as { contracts: Record<string, Address> };
const ch = dep.contracts.ClearingHouse;
if (!ch) throw new Error(`no ClearingHouse in deployments/${chainId}.json`);
const clearingHouse: Address = ch;

const client = createPublicClient({ chain: chainId === 143 ? monad : monadTestnet, transport: http(rpc) });
const perpl = createPerplClient({ transport: httpTransport(process.env.PERPL_API_URL ?? (chainId === 143 ? PERPL_API_URL.mainnet : PERPL_API_URL.testnet)) });
const symbol = process.env.PERPL_SYMBOL ?? "MON";
const store = new JsonlHistory(process.env.MFI_HISTORY_PATH ?? fileURLToPath(new URL("../data/history.jsonl", import.meta.url)));
const loaded = store.load(Date.now());
console.log(`history ${store.path}: ${loaded.points.length} points kept, ${loaded.expired} older than 7 d dropped, ${loaded.corrupt} corrupt lines skipped`);
const svc = new MfiService({ chainId, initialHistory: loaded.points, onHistoryPoint: (p, retained) => store.append(p, retained) });
let market: Market | undefined;
let lastCycleMs = 0;

async function cycle() {
  const nowMs = Date.now();
  const meridian = await readMeridianVenue(client, clearingHouse);
  let p: Parameters<MfiService["cycle"]>[0]["perpl"];
  try {
    market ??= await perpl.findMarket(symbol);
    p = { ok: true, read: await readPerplVenue(perpl, market, nowMs) };
  } catch (error) {
    market = undefined; // re-resolve next cycle (interval or decimals may have changed)
    p = { ok: false, error };
  }
  const s = svc.cycle({ nowMs, meridian, perpl: p });
  lastCycleMs = nowMs;
  console.log(JSON.stringify({ at: new Date(nowMs).toISOString(), index: s.index, venues: s.venues.map((v) => `${v.id}:${v.status}`) }));
}

const period = Number(process.env.MFI_CYCLE_MS ?? "60000");
const loop = async () => {
  try {
    await cycle();
  } catch (e) {
    console.error("cycle failed", e);
  }
  setTimeout(loop, period);
};
void loop();

const port = Number(process.env.PORT ?? "8787");
createServer((req, res) => {
  const r = handle(svc, req.method ?? "GET", req.url ?? "/", Date.now(), () => ({ ok: lastCycleMs > 0, lastCycleMs, venues: Object.fromEntries((svc.current()?.venues ?? []).map((v) => [v.id, v.status])) }));
  res.writeHead(r.status, r.headers);
  res.end(r.body === null ? undefined : JSON.stringify(r.body));
}).listen(port, () => console.log(`MFI API on :${port} (chain ${chainId}, ClearingHouse ${clearingHouse})`));
