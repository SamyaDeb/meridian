// Liquidation latency for benchmark B7: blocks from the first block the keeper saw an account eligible to the
// block its liquidation landed. Pure state machine (no RPC, bigint only); unit-tested in test/latency.test.ts.
import type { Address } from "viem";

export interface LatencySummary {
  n: number;
  p50: bigint;
  p95: bigint;
  max: bigint;
  /** Liquidations that landed within the ≤ 3-block target (WS-03 acceptance). */
  withinThreeBlocks: number;
}

export class LiquidationLatency {
  private readonly seen = new Map<string, bigint>();
  private readonly samples: bigint[] = [];

  /** Record the accounts eligible at `block`; accounts no longer eligible end their episode. */
  observe(block: bigint, eligible: readonly Address[]): void {
    const now = new Set(eligible.map((a) => a.toLowerCase()));
    for (const k of [...this.seen.keys()]) if (!now.has(k)) this.seen.delete(k);
    for (const k of now) if (!this.seen.has(k)) this.seen.set(k, block);
  }

  firstSeen(account: Address): bigint | undefined {
    return this.seen.get(account.toLowerCase());
  }

  /** The liquidation of `account` landed in `block`: returns the latency in blocks (undefined if never seen). */
  liquidated(account: Address, block: bigint): bigint | undefined {
    const k = account.toLowerCase();
    const first = this.seen.get(k);
    if (first === undefined) return undefined;
    this.seen.delete(k);
    const d = block - first;
    this.samples.push(d);
    return d;
  }

  summary(): LatencySummary {
    const s = [...this.samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const n = s.length;
    if (n === 0) return { n: 0, p50: 0n, p95: 0n, max: 0n, withinThreeBlocks: 0 };
    const rank = (p: number): bigint => s[Math.max(0, Math.ceil((p / 100) * n) - 1)] as bigint;
    return { n, p50: rank(50), p95: rank(95), max: s[n - 1] as bigint, withinThreeBlocks: s.filter((d) => d <= 3n).length };
  }
}
