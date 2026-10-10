// MFI v0 service: `pnpm --filter @meridian/mfi start`. Env (never hard-coded, CONTRIBUTING.md §7):
//   MFI_CHAIN_ID           10143 (default) | 143; picks deployments/<id>.json and the RPC env below
//   MONAD_TESTNET_RPC_URL  / MONAD_RPC_URL  RPC for 10143 / 143 (required)
//   PERPL_API_URL          default: Perpl's documented URL for the matching network (transport.ts)
//   PERPL_WS_URL           market-data WebSocket base (default: Perpl's documented URL for the network, ws.ts);
//                          PERPL_WS=0 disables it (REST polling only, the v0 behaviour)
//   PERPL_WS_MAX_SILENCE_MS  feed silent longer than this ⇒ the cycle reads Perpl over REST instead (default 10000)
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
import { MarketDataFeed, MarketDataSocket, PERPL_API_URL, PERPL_WS_URL, createPerplClient, httpTransport, readPerplLive, type Market } from "./perpl";

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

// Live Perpl feed (K3.1): one market-data connection; a funding event triggers a cycle at once, so the MFI moves within
// one message of Perpl publishing a rate. REST stays for context, funding backfill and fallback (readPerplLive).
const wsEnabled = process.env.PERPL_WS !== "0";
const wsBase = process.env.PERPL_WS_URL ?? (chainId === 143 ? PERPL_WS_URL.mainnet : PERPL_WS_URL.testnet);
const wsMaxSilenceMs = Number(process.env.PERPL_WS_MAX_SILENCE_MS ?? "10000");
let feed: MarketDataFeed | undefined;
let socket: MarketDataSocket | undefined;
const wsStats = { opens: 0, closes: 0, lastClose: "", fundingUpdates: 0, wsReads: 0, restReads: 0 };
function follow(m: Market): void {
  if (!wsEnabled || feed?.marketId === m.id) return;
  socket?.stop();
  feed = new MarketDataFeed(m.id);
  socket = new MarketDataSocket({
    baseUrl: wsBase,
    chainId,
    feed,
    onFunding: (u) => {
      wsStats.fundingUpdates++;
      console.log(JSON.stringify({ at: new Date().toISOString(), perplFunding: u.kind, feb: u.event.feb, rate: u.event.rate }));
      void runCycle("perpl-funding");
    },
    onEvent: (e) => {
      if (e.kind === "open") wsStats.opens++;
      if (e.kind === "close") {
        wsStats.closes++;
        wsStats.lastClose = `${e.code} ${e.reason}`;
      }
      if (e.kind !== "subscribed" || e.subs.some((x) => x.code !== 0)) console.log(JSON.stringify({ at: new Date().toISOString(), perplWs: e }));
    },
  });
  socket.start();
}

async function cycle() {
  const nowMs = Date.now();
  const meridian = await readMeridianVenue(client, clearingHouse, { withFees: true });
  let p: Parameters<MfiService["cycle"]>[0]["perpl"];
  try {
    market ??= await perpl.findMarket(symbol);
    follow(market);
    const read = await readPerplLive(perpl, feed, market, nowMs, { wsMaxSilenceMs });
    if (read.source === "ws") wsStats.wsReads++;
    else wsStats.restReads++;
    p = { ok: true, read };
  } catch (error) {
    market = undefined; // re-resolve next cycle (interval or decimals may have changed)
    p = { ok: false, error };
  }
  const s = svc.cycle({ nowMs, meridian, perpl: p });
  lastCycleMs = nowMs;
  console.log(JSON.stringify({ at: new Date(nowMs).toISOString(), index: s.index, spread: s.spread?.aprWad ?? null, venues: s.venues.map((v) => `${v.id}:${v.status}${v.source ? `/${v.source}` : ""}`) }));
}

// One cycle at a time; a trigger while one runs queues exactly one more.
let running = false;
let queued = false;
async function runCycle(why: string): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    await cycle();
  } catch (e) {
    console.error(`cycle (${why}) failed`, e);
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void runCycle("queued");
    }
  }
}

const period = Number(process.env.MFI_CYCLE_MS ?? "60000");
const loop = async () => {
  await runCycle("timer");
  setTimeout(loop, period);
};
void loop();
// context (interval, decimals, fees) can change: re-resolve the market hourly
setInterval(() => (market = undefined), 3_600_000).unref();
process.on("SIGTERM", () => {
  socket?.stop();
  process.exit(0);
});

const port = Number(process.env.PORT ?? "8787");
createServer((req, res) => {
  const r = handle(svc, req.method ?? "GET", req.url ?? "/", Date.now(), () => ({ ok: lastCycleMs > 0, lastCycleMs, venues: Object.fromEntries((svc.current()?.venues ?? []).map((v) => [v.id, v.status])), perplWs: wsEnabled ? { connected: socket?.connected ?? false, silentForMs: socket?.silentForMs() ?? null, headBlock: feed?.head?.block ?? null, heartbeatGaps: feed?.heartbeatGaps ?? 0, ...wsStats } : "disabled" }));
  res.writeHead(r.status, r.headers);
  res.end(r.body === null ? undefined : JSON.stringify(r.body));
}).listen(port, () => console.log(`MFI API on :${port} (chain ${chainId}, ClearingHouse ${clearingHouse})`));
