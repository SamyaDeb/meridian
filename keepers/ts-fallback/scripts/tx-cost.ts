// READ-ONLY: per-bot transaction rate, gas limits and projected MON/h over a block range, measured from the chain
// (blocks + receipts), not from the bots' own counters. Monad bills the gas LIMIT (ARCHITECTURE R6), so the projection
// is Σ gas limit × gas price. Phase 3 P4 (fork rehearsal) and mainnet day (any RPC; read-only).
// On an anvil fork the numbers are an "anvil-fork estimate, not Monad-metered" (Ethereum gas schedule, local clock).
// Usage: RPC_URL=… FROM_BLOCK=… [TO_BLOCK=…] ADDRS=keeper=0x…,mm=0x… GAS_PRICE_GWEI=102 pnpm tx-cost
import { createPublicClient, http } from "viem";

export interface TxSample {
  label: string;
  gasLimit: bigint;
  gasUsed: bigint;
  ok: boolean;
}

export interface BotCost {
  label: string;
  txs: number;
  failed: number;
  gasLimit: bigint;
  gasUsed: bigint;
  txPerHour: number;
  gasLimitPerHour: bigint;
  monPerHourMilli: bigint; // MON × 1000 per hour at the given gas price (integer, rounds down)
}

/** Aggregate per label over `durationSec`; MON/h = Σ limit / h × price (Monad bills the limit). */
export function summarize(samples: TxSample[], labels: string[], durationSec: number, gasPriceWei: bigint): BotCost[] {
  if (durationSec <= 0) throw new Error("durationSec must be > 0");
  const dur = BigInt(Math.round(durationSec));
  return labels.map((label) => {
    const s = samples.filter((x) => x.label === label);
    const gasLimit = s.reduce((a, x) => a + x.gasLimit, 0n);
    const gasUsed = s.reduce((a, x) => a + x.gasUsed, 0n);
    const gasLimitPerHour = (gasLimit * 3600n) / dur;
    return {
      label,
      txs: s.length,
      failed: s.filter((x) => !x.ok).length,
      gasLimit,
      gasUsed,
      txPerHour: (s.length * 3600) / durationSec,
      gasLimitPerHour,
      monPerHourMilli: (gasLimitPerHour * gasPriceWei * 1000n) / 10n ** 18n,
    };
  });
}

/** "keeper=0xabc,mm=0xdef" → Map(lowercased address → label). */
export function parseAddrs(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of s.split(",").filter(Boolean)) {
    const [label, addr] = part.split("=");
    if (!label || !addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`bad ADDRS entry: ${part}`);
    m.set(addr.toLowerCase(), label);
  }
  return m;
}

async function main(): Promise<void> {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL required");
  const addrs = parseAddrs(process.env.ADDRS ?? "");
  const gwei = process.env.GAS_PRICE_GWEI;
  if (!gwei) throw new Error("GAS_PRICE_GWEI required (state its source in the report)");
  const client = createPublicClient({ transport: http(rpc) });
  const from = BigInt(process.env.FROM_BLOCK ?? "0");
  const to = process.env.TO_BLOCK ? BigInt(process.env.TO_BLOCK) : await client.getBlockNumber();
  const samples: TxSample[] = [];
  let t0 = 0n;
  let t1 = 0n;
  for (let b = from; b <= to; b++) {
    const blk = await client.getBlock({ blockNumber: b, includeTransactions: true });
    if (b === from) t0 = blk.timestamp;
    t1 = blk.timestamp;
    for (const tx of blk.transactions) {
      const label = addrs.get(tx.from.toLowerCase());
      if (!label) continue;
      const r = await client.getTransactionReceipt({ hash: tx.hash });
      samples.push({ label, gasLimit: tx.gas, gasUsed: r.gasUsed, ok: r.status === "success" });
    }
  }
  const dur = Number(t1 - t0);
  const out = summarize(samples, [...new Set(addrs.values())], dur, BigInt(Math.round(Number(gwei) * 1e9)));
  console.log(`blocks ${from}–${to} (${to - from + 1n}), ${dur} s by block timestamps, gas price ${gwei} gwei`);
  console.log("| bot | txs | failed | tx/h | Σ gas limit | Σ gas used | limit/used | gas limit/h | MON/h at price |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const c of out) {
    const ratio = c.gasUsed > 0n ? (Number(c.gasLimit) / Number(c.gasUsed)).toFixed(2) : "—";
    console.log(
      `| ${c.label} | ${c.txs} | ${c.failed} | ${c.txPerHour.toFixed(0)} | ${c.gasLimit} | ${c.gasUsed} | ${ratio} | ${c.gasLimitPerHour} | ${(Number(c.monPerHourMilli) / 1000).toFixed(3)} |`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}

