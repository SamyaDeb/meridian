// Read-only: samples mainnet Pyth MON/USD (primary) and Chainlink MON/USD (guard) at historical blocks exactly as
// PythChainlinkOracleAdapter sees them, to choose `oracle.maxDeviationWad` and `maxStalenessSec` (Phase 5 B3).
// deviation = |p − s| / s (adapter: |p − s|·1e18 > maxDeviation·s), counted only while Chainlink is fresh
// (block time − updatedAt ≤ GUARD_STALENESS_SEC, the adapter's secondaryMaxStaleness). Also reports the age of the
// sponsored Pyth price at each sample (what `maxStalenessSec` must tolerate without our own Hermes pushes).
// Usage: MONAD_RPC_URL=<mainnet> PYTH_MON_USD_FEED_ID=0x3149…6cd1 HOURS=72 STEP=100 OUT=dev.csv pnpm oracle-deviation
import { writeFileSync } from "node:fs";
import { type Hex, createPublicClient, http, parseAbi } from "viem";

// Addresses: docs/ARCHITECTURE.md §0 R11 (Chainlink MON/USD, 8 dp) and R12 (Pyth contract, expo −8).
const PYTH = "0x2880aB155794e7179c9eE2e38200202908C17B43";
const CL_MON_USD = "0xBcD78f76005B7515837af6b50c7C52BCf73822fb";
const pythAbi = parseAbi([
  "struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }",
  "function getPriceUnsafe(bytes32 id) view returns (Price)",
]);
const clAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);

export interface Sample {
  block: bigint;
  ts: bigint;
  pyth: number; // USD
  pythAge: number; // s
  cl: number; // USD
  clAge: number; // s
}

/** |p − s| / s, the adapter's deviation measure (s = Chainlink). */
export function deviation(p: number, s: number): number {
  return Math.abs(p - s) / s;
}

/** Nearest-rank percentile of an ascending array (q in [0, 1]). */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] as number;
}

async function main(): Promise<void> {
  const rpc = process.env.MONAD_RPC_URL;
  const feed = process.env.PYTH_MON_USD_FEED_ID as Hex | undefined;
  if (rpc === undefined || feed === undefined) throw new Error("need MONAD_RPC_URL and PYTH_MON_USD_FEED_ID");
  const hours = Number(process.env.HOURS ?? "72");
  const step = BigInt(process.env.STEP ?? "100");
  const guardStaleness = Number(process.env.GUARD_STALENESS_SEC ?? "3600");
  const conc = Number(process.env.CONCURRENCY ?? "8");
  const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 0 }) });
  if ((await client.getChainId()) !== 143) throw new Error("not Monad mainnet (143)");

  const head = await client.getBlockNumber();
  const headTs = (await client.getBlock({ blockNumber: head })).timestamp;
  const probe = head - 100_000n;
  const probeTs = (await client.getBlock({ blockNumber: probe })).timestamp;
  const msPerBlock = (Number(headTs - probeTs) * 1000) / 100_000;
  const span = BigInt(Math.ceil((hours * 3_600_000) / msPerBlock));
  const blocks: bigint[] = [];
  for (let b = head - span; b <= head; b += step) blocks.push(b);
  console.error(`head ${head}, ${msPerBlock.toFixed(1)} ms/block, ${blocks.length} samples over ${hours} h`);

  const samples: Sample[] = [];
  let next = 0;
  let done = 0;
  let skipped = 0;
  const worker = async (): Promise<void> => {
    while (next < blocks.length) {
      const blockNumber = blocks[next++] as bigint;
      const read = () =>
        Promise.all([
          client.getBlock({ blockNumber }),
          client.readContract({ address: PYTH, abi: pythAbi, functionName: "getPriceUnsafe", args: [feed], blockNumber }),
          client.readContract({ address: CL_MON_USD, abi: clAbi, functionName: "latestRoundData", blockNumber }),
        ]);
      let got: Awaited<ReturnType<typeof read>> | undefined;
      for (let attempt = 0; got === undefined && attempt < 8; ++attempt) {
        try {
          got = await read();
        } catch {
          await new Promise((res) => setTimeout(res, 1000 * 2 ** Math.min(attempt, 5))); // public RPC 429 back-off
        }
      }
      if (got === undefined) {
        skipped++;
        continue;
      }
      const [blk, p, r] = got;
      samples.push({
        block: blockNumber,
        ts: blk.timestamp,
        pyth: Number(p.price) * 10 ** p.expo,
        pythAge: Number(blk.timestamp - p.publishTime),
        cl: Number(r[1]) / 1e8,
        clAge: Number(blk.timestamp - r[3]),
      });
      if (++done % 500 === 0) console.error(`${done}/${blocks.length}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  samples.sort((a, b) => (a.block < b.block ? -1 : 1));

  const out = process.env.OUT;
  if (out !== undefined) {
    const rows = samples.map((s) => [s.block, s.ts, s.pyth, s.pythAge, s.cl, s.clAge, deviation(s.pyth, s.cl)].join(","));
    writeFileSync(out, ["block,timestamp,pyth_usd,pyth_age_s,chainlink_usd,chainlink_age_s,deviation", ...rows].join("\n") + "\n");
  }
  const guarded = samples.filter((s) => s.clAge <= guardStaleness);
  const dev = guarded.map((s) => deviation(s.pyth, s.cl)).sort((a, b) => a - b);
  const age = samples.map((s) => s.pythAge).sort((a, b) => a - b);
  const clAge = samples.map((s) => s.clAge).sort((a, b) => a - b);
  const pct = (x: number): string => `${(x * 100).toFixed(4)}%`;
  const share = (arr: number[], f: (x: number) => boolean): string => `${((100 * arr.filter(f).length) / arr.length).toFixed(2)}%`;
  console.log(
    JSON.stringify(
      {
        window: { fromBlock: String(blocks[0]), toBlock: String(head), hours, stepBlocks: Number(step), samples: samples.length, skipped },
        deviationWhileGuardFresh: {
          n: dev.length,
          p50: pct(percentile(dev, 0.5)),
          p90: pct(percentile(dev, 0.9)),
          p99: pct(percentile(dev, 0.99)),
          p999: pct(percentile(dev, 0.999)),
          max: pct(dev[dev.length - 1] ?? Number.NaN),
          over1pct: share(dev, (d) => d > 0.01),
          over2pct: share(dev, (d) => d > 0.02),
        },
        pythSponsoredAgeSec: {
          p50: percentile(age, 0.5),
          p90: percentile(age, 0.9),
          p99: percentile(age, 0.99),
          max: age[age.length - 1],
          over10s: share(age, (a) => a > 10),
          over30s: share(age, (a) => a > 30),
          over60s: share(age, (a) => a > 60),
        },
        chainlinkAgeSec: { p50: percentile(clAge, 0.5), p99: percentile(clAge, 0.99), max: clAge[clAge.length - 1] },
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
