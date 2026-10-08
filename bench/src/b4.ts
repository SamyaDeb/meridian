// B4 (K7): two perp markets under load at the same time, from separate keys. Pure helpers; no RPC; unit-tested.
// The claim B4 can support is narrow (BENCHMARKS_PLAN, K7 §4): the markets share no hot storage, and one market's
// inclusion latency / throughput does not degrade when the other is loaded. Monad's parallel execution itself is the
// chain's property, not ours.
import { percentile } from "./stats.js";

export type B4Op = "place" | "cancel" | "market";
export type B4Phase = "a" | "b" | "ab";

export interface B4Tx {
  phase: B4Phase;
  market: string; // symbol
  op: B4Op;
  wallet: number;
  hash: string;
  /** block number observed right before the send */
  sentBlock: bigint;
  /** ms epoch at send */
  sentMs: number;
  /** receipt, when included */
  block?: bigint;
  /** ms epoch when the receipt was first seen (polling ≤ 100 ms) */
  seenMs?: number;
  status?: "success" | "reverted";
  gasUsed?: bigint;
  gasLimit: bigint;
  estimate: bigint;
}

/**
 * Deterministic op schedule for one wallet: `n` ops, ≈ 50% place / 30% cancel / 20% market (the B4 mix of
 * BENCHMARKS_PLAN, cancels only after a place). Market orders alternate buy / sell so the wallet stays ≈ flat.
 */
export function b4Schedule(n: number, seed: number): Array<{ op: B4Op; buy: boolean }> {
  let x = (seed * 2_654_435_761) >>> 0 || 1;
  const rnd = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
  const out: Array<{ op: B4Op; buy: boolean }> = [];
  let open = 0;
  let buy = true;
  for (let i = 0; i < n; ++i) {
    const r = rnd();
    let op: B4Op = r < 0.5 ? "place" : r < 0.8 ? "cancel" : "market";
    if (op === "cancel" && open === 0) op = "place";
    if (op === "place") open++;
    if (op === "cancel") open--;
    out.push({ op, buy });
    if (op === "market") buy = !buy;
  }
  return out;
}

export interface B4Summary {
  phase: B4Phase;
  market: string;
  sent: number;
  included: number;
  reverted: number;
  blocks: number;
  txPerBlockMean: number;
  txPerBlockMax: number;
  inclusionBlocksP50: number;
  inclusionBlocksP95: number;
  latencyMsP50: number;
  latencyMsP95: number;
  gasUsedP50ByOp: Record<string, number>;
  estimateP50ByOp: Record<string, number>;
}

/** Per (phase, market) summary. Inclusion = receipt block − the block seen before the send. */
export function summarizeB4(txs: readonly B4Tx[], phase: B4Phase, market: string): B4Summary {
  const mine = txs.filter((t) => t.phase === phase && t.market === market);
  const inc = mine.filter((t) => t.block !== undefined);
  const perBlock = new Map<bigint, number>();
  for (const t of inc) perBlock.set(t.block!, (perBlock.get(t.block!) ?? 0) + 1);
  const counts = [...perBlock.values()];
  const incBlocks = inc.map((t) => Number(t.block! - t.sentBlock));
  const lat = inc.filter((t) => t.seenMs !== undefined).map((t) => t.seenMs! - t.sentMs);
  const byOp = (pick: (t: B4Tx) => bigint | undefined): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const op of ["place", "cancel", "market"] as const) {
      const xs = inc.filter((t) => t.op === op && t.status === "success").map(pick).filter((v): v is bigint => v !== undefined).map(Number);
      if (xs.length) out[op] = percentile(xs, 50);
    }
    return out;
  };
  return {
    phase,
    market,
    sent: mine.length,
    included: inc.length,
    reverted: inc.filter((t) => t.status === "reverted").length,
    blocks: perBlock.size,
    txPerBlockMean: counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0,
    txPerBlockMax: counts.length ? Math.max(...counts) : 0,
    inclusionBlocksP50: incBlocks.length ? percentile(incBlocks, 50) : 0,
    inclusionBlocksP95: incBlocks.length ? percentile(incBlocks, 95) : 0,
    latencyMsP50: lat.length ? percentile(lat, 50) : 0,
    latencyMsP95: lat.length ? percentile(lat, 95) : 0,
    gasUsedP50ByOp: byOp((t) => t.gasUsed),
    estimateP50ByOp: byOp((t) => t.estimate),
  };
}

/** Blocks that carry txs of both markets in the joint phase (the "same blocks" condition of B4). */
export function sharedBlocks(txs: readonly B4Tx[], a: string, b: string): { blocks: number; shared: number } {
  const seen = new Map<bigint, Set<string>>();
  for (const t of txs) {
    if (t.phase !== "ab" || t.block === undefined) continue;
    const s = seen.get(t.block) ?? new Set<string>();
    s.add(t.market);
    seen.set(t.block, s);
  }
  let shared = 0;
  for (const s of seen.values()) if (s.has(a) && s.has(b)) shared++;
  return { blocks: seen.size, shared };
}

/** Joint ÷ alone for a metric (1.0 = no interference). 0 when the alone value is 0. */
export function interference(alone: number, joint: number): number {
  return alone === 0 ? 0 : joint / alone;
}

/** prestateTracer (diffMode false) result: address → { storage?: { slot: value } }. */
export type Prestate = Record<string, { storage?: Record<string, string> }>;

/**
 * Storage touched by two txs: the (address, slot) pairs both read or wrote. Addresses are compared lowercase.
 * `ignore` drops shared read-mostly contracts on purpose (e.g. none for order ops; the token for deposits).
 */
export function storageOverlap(a: Prestate, b: Prestate, ignore: readonly string[] = []): { aSlots: number; bSlots: number; shared: string[]; sharedAddresses: string[] } {
  const skip = new Set(ignore.map((x) => x.toLowerCase()));
  const slots = (p: Prestate): Set<string> => {
    const s = new Set<string>();
    for (const [addr, acc] of Object.entries(p)) {
      if (skip.has(addr.toLowerCase())) continue;
      for (const slot of Object.keys(acc.storage ?? {})) s.add(`${addr.toLowerCase()}:${slot.toLowerCase()}`);
    }
    return s;
  };
  const sa = slots(a);
  const sb = slots(b);
  const shared = [...sa].filter((x) => sb.has(x)).sort();
  const aAddr = new Set(Object.entries(a).filter(([, v]) => Object.keys(v.storage ?? {}).length > 0).map(([k]) => k.toLowerCase()));
  const sharedAddresses = Object.entries(b)
    .filter(([k, v]) => Object.keys(v.storage ?? {}).length > 0 && aAddr.has(k.toLowerCase()) && !skip.has(k.toLowerCase()))
    .map(([k]) => k.toLowerCase())
    .sort();
  return { aSlots: sa.size, bSlots: sb.size, shared, sharedAddresses };
}

export const B4_CSV_HEADER =
  "phase,market,op,wallet,hash,sentBlock,block,inclusionBlocks,latencyMs,status,gasUsed,gasLimit,estimate,chainId,rpcTier,commit,date";

export function b4CsvRow(t: B4Tx, meta: { chainId: number; rpcTier: string; commit: string; date: string }): string {
  return [
    t.phase,
    t.market,
    t.op,
    t.wallet,
    t.hash,
    t.sentBlock,
    t.block ?? "",
    t.block === undefined ? "" : t.block - t.sentBlock,
    t.seenMs === undefined ? "" : t.seenMs - t.sentMs,
    t.status ?? "",
    t.gasUsed ?? "",
    t.gasLimit,
    t.estimate,
    meta.chainId,
    meta.rpcTier,
    meta.commit,
    meta.date,
  ].join(",");
}
