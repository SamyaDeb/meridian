// K3.4: measure the Perpl hedge, hedge OFF vs ON with the same house flow (docs/PERPL_HEDGE.md "Measurement").
//
//   sample: CHAIN_ID=10143 RPC_URL=… PHASE=off|on MINUTES=30 [SAMPLE_MS=5000] [MM_ADDRESS=0x…] \
//           [PERPL_API_KEY=… PERPL_API_KEY_SECRET=… PERPL_MARKET_ID=64]  pnpm perpl-hedge sample
//     → appends rows to bench/out/perpl_hedge_<phase>_<chain>_<date>.csv: Meridian best bid/ask, inner spread, depth
//       within ±1% of the index per side, one-sided flag, MM Meridian position, MM Perpl position (signed REST
//       GET /v1/trading/positions when the key is set). Reads only; never sends a transaction or an order.
//   report: OFF_CSV=… ON_CSV=… [EVIDENCE_OFF=…] EVIDENCE_ON=… [PERPL_FILLS=…json] [PERPL_MARKET_ID=64] [OFF_FROM=iso ON_FROM=iso] pnpm perpl-hedge report
//     → markdown before/after table (stdout + bench/out/perpl_hedge_report_<date>.md). Evidence is counted inside each
//       phase's sample window; PERPL_FILLS (mm-bot scripts/perpl-history.ts output) gives the Perpl fill count.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { monadTestnet } from "viem/chains";
import { CSV_HEADER, bookMetrics, countEvidence, countPerplFills, fromCsv, markdownTable, summarize, toCsv, type Row } from "./src/hedgeMetrics";
import { newNonce, parseSecret, restHeaders } from "../mm-bot/src/perpl/auth";
import { PerplState } from "../mm-bot/src/perpl/state";

const mode = process.argv[2];
const out = new URL("./out/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const date = new Date().toISOString().slice(0, 10);

const ob = parseAbi([
  "function getDepth(bool isBid, uint256 maxLevels) view returns (uint32[] ticks, uint64[] lots)",
  "function tickSize() view returns (uint256)",
  "function lotSize() view returns (uint256)",
]);
const ch = parseAbi([
  "struct AccountView { uint256 collateral; int256 size; uint256 entryPrice; int256 unrealizedPnl; int256 pendingFunding; int256 equity; uint256 initialMargin; uint256 maintenanceMargin; uint256 reservedOrderMargin; uint256 liquidationPrice; bool liquidatable; }",
  "function getAccount(address account) view returns (AccountView)",
]);
const oracle = parseAbi(["function tryGetIndexPrice() view returns (bool ok, uint256 priceWad, uint256 updatedAt)"]);

async function sample(): Promise<void> {
  const chainId = Number(process.env.CHAIN_ID ?? "10143");
  if (chainId !== 10143) throw new Error("perpl-hedge sample is a testnet (10143) measurement");
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL required");
  const phase = process.env.PHASE;
  if (phase !== "off" && phase !== "on") throw new Error("PHASE=off|on");
  const dep = JSON.parse(readFileSync(new URL(`../deployments/${chainId}.json`, import.meta.url), "utf8")) as { contracts: Record<string, Address>; mmAccounts: Address[] };
  const mm = (process.env.MM_ADDRESS ?? dep.mmAccounts[0]) as Address;
  const OB = dep.contracts.OrderBook!;
  const CH = dep.contracts.ClearingHouse!;
  const ORACLE = dep.contracts.OracleAdapter!;
  const pub = createPublicClient({ chain: monadTestnet, transport: http(rpc) });
  const [tickSize, lotSize] = await Promise.all([pub.readContract({ address: OB, abi: ob, functionName: "tickSize" }), pub.readContract({ address: OB, abi: ob, functionName: "lotSize" })]);
  const key = process.env.PERPL_API_KEY;
  const secret = process.env.PERPL_API_KEY_SECRET ? parseSecret(process.env.PERPL_API_KEY_SECRET) : undefined;
  const marketId = Number(process.env.PERPL_MARKET_ID ?? "64");
  const perplPos = async (): Promise<number | null> => {
    if (!key || !secret) return null;
    const target = "/v1/trading/positions";
    const h = await restHeaders(key, secret, { chainId, method: "GET", target, timestampMs: Date.now(), nonce: newNonce((n) => crypto.getRandomValues(new Uint8Array(n))), body: "" });
    const r = await fetch(`https://testnet.perpl.xyz/api${target}`, { headers: { ...h, accept: "application/json" } });
    if (r.status !== 200) return null;
    const s = new PerplState(marketId);
    s.apply(await r.json(), Date.now());
    return s.netSize(); // size_decimals 0 on MON (recorded): scaled size = MON
  };
  const file = `${out}perpl_hedge_${phase}_${chainId}_${date}.csv`;
  if (!existsSync(file)) writeFileSync(file, `${CSV_HEADER}\n`);
  const minutes = Number(process.env.MINUTES ?? "30");
  const every = Number(process.env.SAMPLE_MS ?? "5000");
  const end = Date.now() + minutes * 60_000;
  console.log(`sampling ${phase} for ${minutes} min every ${every} ms → ${file} (MM ${mm}, perpl positions: ${key ? "yes" : "no"})`);
  let n = 0;
  while (Date.now() < end) {
    try {
      const block = await pub.getBlockNumber();
      const [[ok, index], bids, asks, acct, pp] = await Promise.all([
        pub.readContract({ address: ORACLE, abi: oracle, functionName: "tryGetIndexPrice", blockNumber: block }),
        pub.readContract({ address: OB, abi: ob, functionName: "getDepth", args: [true, 20n], blockNumber: block }),
        pub.readContract({ address: OB, abi: ob, functionName: "getDepth", args: [false, 20n], blockNumber: block }),
        pub.readContract({ address: CH, abi: ch, functionName: "getAccount", args: [mm], blockNumber: block }),
        perplPos().catch(() => null),
      ]);
      if (ok && index > 0n) {
        const lv = (d: readonly [readonly number[], readonly bigint[]]) => d[0].map((tick, i) => ({ tick, lots: d[1][i]! }));
        const m = bookMetrics(lv(bids), lv(asks), tickSize, index);
        const row: Row = { t: Date.now(), phase, block, ...m, merPosMon: Number((acct.size * 1_000n) / 10n ** 18n) / 1_000, perplPosMon: pp };
        appendFileSync(file, `${toCsv(row)}\n`);
        if (++n % 12 === 0) console.log(`${n} samples; last: spread ${m.innerSpreadBps} bps, one-sided ${m.oneSided}, mer ${row.merPosMon} MON, perpl ${pp}`);
      } else console.log(`block ${block}: oracle index stale (keeper not pushing?): sample skipped`);
    } catch (e) {
      console.error("sample failed", String(e).split("\n")[0]);
    }
    await new Promise((r) => setTimeout(r, every));
  }
  console.log(`done: ${n} samples (lot = ${lotSize} WAD)`);
}

function report(): void {
  const rows = (p: string | undefined) => (p ? readFileSync(p, "utf8").split("\n").slice(1).filter(Boolean).map(fromCsv) : []);
  const ev = (p: string | undefined) => (p && existsSync(p) ? readFileSync(p, "utf8").split("\n") : []);
  const off = rows(process.env.OFF_CSV);
  const on = rows(process.env.ON_CSV);
  if (!off.length || !on.length) throw new Error("OFF_CSV and ON_CSV with samples required");
  const commit = (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim();
    } catch {
      return "?";
    }
  })();
  // a phase starts when its MM starts (OFF_FROM / ON_FROM, ISO), which can be a little before the sampler's first row
  const from = (iso: string | undefined, r: Row[]) => (iso ? Date.parse(iso) : r[0]!.t);
  const win = (r: Row[], iso?: string) => ({ fromMs: from(iso, r), toMs: r.at(-1)!.t });
  const wOff = win(off, process.env.OFF_FROM);
  const wOn = win(on, process.env.ON_FROM);
  const counts = { off: countEvidence(ev(process.env.EVIDENCE_OFF), wOff), on: countEvidence(ev(process.env.EVIDENCE_ON), wOn) };
  if (process.env.PERPL_FILLS) {
    const pages = (JSON.parse(readFileSync(process.env.PERPL_FILLS, "utf8")) as { pages: Parameters<typeof countPerplFills>[0] }).pages;
    const mkt = Number(process.env.PERPL_MARKET_ID ?? "64");
    counts.off.perplFills = countPerplFills(pages, mkt, wOff.fromMs, wOff.toMs);
    counts.on.perplFills = countPerplFills(pages, mkt, wOn.fromMs, wOn.toMs);
  }
  const span = (r: Row[]) => `samples ${new Date(r[0]!.t).toISOString()} → ${new Date(r.at(-1)!.t).toISOString()}, blocks ${r[0]!.block}–${r.at(-1)!.block}`;
  const md = [
    `### Perpl hedge: before / after (10143, ${date}, commit ${commit})`,
    "",
    `- off: ${span(off)}`,
    `- on: ${span(on)}`,
    `- evidence and Perpl fills counted from the phase start: off ${new Date(wOff.fromMs).toISOString()}, on ${new Date(wOn.fromMs).toISOString()}`,
    "",
    markdownTable(summarize(off), summarize(on), counts),
    "",
  ].join("\n");
  writeFileSync(`${out}perpl_hedge_report_${date}.md`, md);
  console.log(md);
}

if (mode === "sample") await sample();
else if (mode === "report") report();
else throw new Error("usage: perpl_hedge.ts sample|report");
