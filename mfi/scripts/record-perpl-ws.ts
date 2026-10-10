// Record real frames from Perpl's PUBLIC market-data WebSocket as replay fixtures (no auth, no keys).
//   pnpm --filter @meridian/mfi record:perpl-ws [testnet|mainnet] [seconds=90] [marketId=64]   (WS_FIXTURE_DIR=ws)
// Subscribes (one mt: 5 frame, websocket.md "Subscribing") to heartbeat, market-config, market-state and funding for the
// chain, plus order-book and trades for the market, and writes fixtures/recorded/<network>/ws/<stream>.jsonl: one line
// per frame `{ "recvMs": <local ms>, "frame": <raw JSON> }`. Order-book/heartbeat updates are capped per file so the
// fixtures stay small; funding frames are always kept (two per interval, keyed by `feb`, types.md "FundingEvent").
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERPL_WS_URL } from "../src/perpl/ws";

const network = (process.argv[2] ?? "testnet") as keyof typeof PERPL_WS_URL;
const seconds = Number(process.argv[3] ?? "90");
const marketId = Number(process.argv[4] ?? (network === "mainnet" ? "10" : "64"));
const chainId = network === "mainnet" ? 143 : 10143;
const base = process.env.PERPL_WS_URL ?? PERPL_WS_URL[network];
if (!base) throw new Error(`unknown network ${network}`);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "recorded", network, process.env.WS_FIXTURE_DIR ?? "ws");
mkdirSync(out, { recursive: true });

const CAP: Record<string, number> = { heartbeat: 40, "order-book": 30, "market-state": 40, trades: 40, "market-config": 10, funding: 1_000, control: 50 };
const streams = [`heartbeat@${chainId}`, `market-config@${chainId}`, `market-state@${chainId}`, `funding@${chainId}`, `order-book@${marketId}`, `trades@${marketId}`];
// Bucket by message type, not by `sid`: on testnet (7 Oct 2026) the mt: 6 reply listed funding@10143 under sid 3000
// (market-state's) while the funding frames (mt: 10) arrived on sid 4000.
const BY_MT: Record<number, string> = { 3: "control", 6: "control", 8: "market-config", 9: "market-state", 10: "funding", 15: "order-book", 16: "order-book", 17: "trades", 18: "trades", 100: "heartbeat" };
const files = new Map<string, string[]>();

function keep(name: string, recvMs: number, frame: unknown): void {
  const lines = files.get(name) ?? [];
  if (lines.length < (CAP[name] ?? 50)) lines.push(JSON.stringify({ recvMs, frame }));
  files.set(name, lines);
}

const ws = new WebSocket(`${base}/ws/v1/market-data`);
ws.onopen = () => {
  console.log(`open ${base}/ws/v1/market-data, subscribing ${streams.join(", ")}`);
  ws.send(JSON.stringify({ mt: 5, subs: streams.map((stream) => ({ stream, subscribe: true })) }));
};
ws.onmessage = (ev) => {
  const recvMs = Date.now();
  const frame = JSON.parse(String(ev.data)) as { mt: number };
  keep(BY_MT[frame.mt] ?? "control", recvMs, frame);
};
ws.onclose = (ev) => console.log(`close ${ev.code} ${ev.reason}`);
ws.onerror = (ev) => console.error("ws error", ev);

await new Promise((r) => setTimeout(r, seconds * 1000));
ws.close(1000);
for (const [name, lines] of files) {
  writeFileSync(join(out, `${name}.jsonl`), `${lines.join("\n")}\n`);
  console.log(`${name}.jsonl: ${lines.length} frames`);
}
writeFileSync(join(out, "_recorded.json"), `${JSON.stringify({ url: `${base}/ws/v1/market-data`, streams, seconds, at: new Date().toISOString() }, null, 2)}\n`);
process.exit(0);
