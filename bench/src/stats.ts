// Pure helpers for the onchain benchmarks (BENCHMARKS_PLAN B1, B2, B4). No RPC; unit-tested.

/** Nearest-rank percentile (p in [0, 100]) of a non-empty list. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new Error("empty");
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * s.length);
  return s[Math.max(rank, 1) - 1]!;
}

/** Mean block time (ms) over a block range from (number, timestamp s) pairs: Δtimestamp / Δnumber. */
export function meanBlockTimeMs(first: { number: bigint; timestamp: bigint }, last: { number: bigint; timestamp: bigint }): number {
  const dn = Number(last.number - first.number);
  if (dn <= 0) return 0;
  return (Number(last.timestamp - first.timestamp) * 1000) / dn;
}

export interface GasRow {
  op: string;
  gasUsed: bigint;
  gasLimit: bigint;
  block: bigint;
  txHash: string;
}

export const GAS_CSV_HEADER = "op,gasUsed,gasLimit,block,txHash,commit,date,chainId,blockTimeMs";

export function gasCsvRow(r: GasRow, meta: { commit: string; date: string; chainId: number; blockTimeMs: number }): string {
  return [r.op, r.gasUsed, r.gasLimit, r.block, r.txHash, meta.commit, meta.date, meta.chainId, meta.blockTimeMs.toFixed(1)].join(",");
}

/** Foundry reference (contracts/bench-out/real_engine_gas.csv: op,gas,target) → map. */
export function parseFoundryCsv(csv: string): Map<string, { gas: number; target: number | null }> {
  const out = new Map<string, { gas: number; target: number | null }>();
  for (const line of csv.trim().split("\n").slice(1)) {
    const [op, gas, target] = line.split(",");
    if (op === undefined || gas === undefined) continue;
    out.set(op, { gas: Number(gas), target: target === undefined || target === "" ? null : Number(target) });
  }
  return out;
}

/** Monad bills the gas limit (ARCHITECTURE R6): limit = ceil(estimate × 1.2). */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n;
}

export interface LoadResult {
  markets: number;
  sent: number;
  included: number;
  blocks: number;
  txPerBlock: number;
  latencyMsP50: number;
  latencyMsP95: number;
}

/** B4 summary for one K. */
export function summarizeLoad(markets: number, latenciesMs: readonly number[], sent: number, firstBlock: bigint, lastBlock: bigint): LoadResult {
  const blocks = Number(lastBlock - firstBlock) + 1;
  return {
    markets,
    sent,
    included: latenciesMs.length,
    blocks,
    txPerBlock: blocks > 0 ? latenciesMs.length / blocks : 0,
    latencyMsP50: latenciesMs.length ? percentile(latenciesMs, 50) : 0,
    latencyMsP95: latenciesMs.length ? percentile(latenciesMs, 95) : 0,
  };
}

/** B4 tx mix (BENCHMARKS_PLAN): 70% place/cancel, 30% market, deterministic from a seed. */
export function loadMix(n: number, seed: number): Array<"place" | "cancel" | "market"> {
  const out: Array<"place" | "cancel" | "market"> = [];
  let x = seed >>> 0 || 1;
  let open = 0;
  for (let i = 0; i < n; ++i) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    const r = x % 100;
    if (r < 30) out.push("market");
    else if (r < 65 || open === 0) {
      out.push("place");
      ++open;
    } else {
      out.push("cancel");
      --open;
    }
  }
  return out;
}
