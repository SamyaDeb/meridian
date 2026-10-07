// K3.0: record a READ-ONLY Perpl trading-WebSocket session (sign-in, wallet snapshot, account/orders/positions, heartbeats)
// as a replay fixture. Sends the signed mt: 29 sign-in and NOTHING else (no orders), and by default no pings either, to
// measure whether a signed-in socket survives the idle window (README: 10 s on testnet) without client frames.
//   cd mm-bot && set -a && source ../.env && set +a && node_modules/.bin/tsx scripts/perpl-record-trading.ts [seconds=60] [pingMs=0]
// Writes fixtures/recorded/testnet/trading-session.jsonl ({ recvMs, frame }). Inbound frames only: our key and signature
// never reach the file.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { newNonce, parseSecret, signInFrame } from "../src/perpl/auth.js";

const seconds = Number(process.argv[2] ?? "60");
const pingMs = Number(process.argv[3] ?? "0");
const key = process.env.PERPL_API_KEY;
const secretHex = process.env.PERPL_API_KEY_SECRET;
if (!key || !secretHex) throw new Error("PERPL_API_KEY / PERPL_API_KEY_SECRET not set");
const t0 = Date.now();
const lines: string[] = [];
const kinds = new Map<number, number>();
const ws = new WebSocket("wss://testnet.perpl.xyz/ws/v1/trading");
let closed = "";
ws.onopen = async () => {
  ws.send(JSON.stringify(await signInFrame(key, parseSecret(secretHex), { chainId: 10143, timestampMs: Date.now(), nonce: newNonce(randomBytes) })));
  if (pingMs > 0) setInterval(() => ws.send(JSON.stringify({ mt: 1, t: Date.now() })), pingMs);
};
ws.onmessage = (e) => {
  const frame = JSON.parse(String(e.data)) as { mt: number };
  kinds.set(frame.mt, (kinds.get(frame.mt) ?? 0) + 1);
  if (frame.mt !== 100 || (kinds.get(100) ?? 0) <= 30) lines.push(JSON.stringify({ recvMs: Date.now(), frame }));
};
ws.onclose = (e) => {
  closed = `${e.code} "${e.reason}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  finish();
};
const finish = () => {
  const dir = new URL("../fixtures/recorded/testnet/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}trading-session.jsonl`, `${lines.join("\n")}\n`);
  console.log(JSON.stringify({ pingMs, closed: closed || `still open after ${seconds} s (closed by us)`, frames: Object.fromEntries(kinds) }));
  process.exit(0);
};
setTimeout(() => { ws.onclose = null; ws.close(1000); finish(); }, seconds * 1000);
