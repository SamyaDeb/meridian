// Counting JSON-RPC proxy for bot evidence (Phase 4 step 1): measures a bot from the outside, so the "before"
// (main) and "after" builds are compared with the same instrument.
//   PORT=18546 UPSTREAM=http://127.0.0.1:8546 OUT=runs/p4-step1/keeper-before.jsonl pnpm --filter @meridian/bot-rpc proxy
// Point the bot's RPC_URL at http://127.0.0.1:$PORT. Every 60 s (and on SIGINT) one JSON line is appended to OUT:
// calls by method in that minute, and for eth_sendRawTransaction the tx count and Σ gas LIMIT (what Monad bills, R6)
// decoded from the signed bytes.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { type Hex, parseTransaction } from "viem";
import { rpcMethods } from "../src/index.js";

const PORT = Number(process.env.PORT ?? "18546");
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:8546";
const OUT = process.env.OUT;

let minute = { start: Date.now(), calls: 0, byMethod: {} as Record<string, number>, txs: 0, gasLimit: 0n };
const total = { calls: 0, txs: 0, gasLimit: 0n, minutes: 0, start: Date.now() };

function rawTxs(body: string): Hex[] {
  try {
    const j = JSON.parse(body) as unknown;
    const arr = (Array.isArray(j) ? j : [j]) as Array<{ method?: string; params?: unknown[] }>;
    return arr.filter((x) => x.method === "eth_sendRawTransaction").map((x) => x.params?.[0] as Hex);
  } catch {
    return [];
  }
}

function flush(final = false): void {
  const line = {
    t: new Date().toISOString(),
    seconds: Math.round((Date.now() - minute.start) / 1000),
    calls: minute.calls,
    byMethod: minute.byMethod,
    txs: minute.txs,
    gasLimit: minute.gasLimit.toString(),
    ...(final
      ? { total: { ...total, gasLimit: total.gasLimit.toString(), callsPerMin: (total.calls * 60_000) / Math.max(1, Date.now() - total.start) } }
      : {}),
  };
  if (OUT) appendFileSync(OUT, `${JSON.stringify(line)}\n`);
  else console.log(JSON.stringify(line));
  total.minutes++;
  minute = { start: Date.now(), calls: 0, byMethod: {}, txs: 0, gasLimit: 0n };
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const methods = rpcMethods(body);
    minute.calls += Math.max(1, methods.length);
    total.calls += Math.max(1, methods.length);
    for (const m of methods) minute.byMethod[m] = (minute.byMethod[m] ?? 0) + 1;
    for (const raw of rawTxs(body)) {
      try {
        const gas = parseTransaction(raw).gas ?? 0n;
        minute.txs++;
        total.txs++;
        minute.gasLimit += gas;
        total.gasLimit += gas;
      } catch {
        /* not a tx we can decode: counted as a call only */
      }
    }
    fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body })
      .then(async (r) => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(await r.text());
      })
      .catch((e: unknown) => {
        res.writeHead(502).end(String(e));
      });
  });
}).listen(PORT, () => console.log(`count-proxy :${PORT} → ${UPSTREAM}${OUT ? ` → ${OUT}` : ""}`));

setInterval(() => flush(), 60_000).unref();
process.on("SIGINT", () => {
  flush(true);
  process.exit(0);
});
process.on("SIGTERM", () => {
  flush(true);
  process.exit(0);
});
