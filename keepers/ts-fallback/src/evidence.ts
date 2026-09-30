// Pure helpers for the unattended-run evidence (Phase 3 step 4 / gate G3). No RPC; unit-tested.

/** Largest gap (in blocks) between consecutive FundingUpdated blocks, including the edges of [from, to]. */
export function maxFundingGap(blocks: readonly bigint[], from: bigint, to: bigint): bigint {
  const sorted = [...blocks].filter((b) => b >= from && b <= to).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let prev = from;
  let max = 0n;
  for (const b of sorted) {
    if (b - prev > max) max = b - prev;
    prev = b;
  }
  return to - prev > max ? to - prev : max;
}

export interface BookSample {
  t: number;
  block: bigint;
  bestBidTick: number | null;
  bestAskTick: number | null;
}

/** Spread in bps of mid, or null if either side is empty. */
export function spreadBps(s: BookSample): number | null {
  if (s.bestBidTick === null || s.bestAskTick === null) return null;
  const mid = (s.bestBidTick + s.bestAskTick) / 2;
  return ((s.bestAskTick - s.bestBidTick) / mid) * 10_000;
}

export interface BookSummary {
  samples: number;
  twoSided: number;
  maxSpreadBps: number | null;
  withinBps: number;
}

/** WS-03 acceptance: two-sided with spread ≤ `limitBps` (20) in every sample. */
export function summarizeBook(samples: readonly BookSample[], limitBps: number): BookSummary {
  let twoSided = 0;
  let within = 0;
  let max: number | null = null;
  for (const s of samples) {
    const sp = spreadBps(s);
    if (sp === null) continue;
    twoSided++;
    if (sp <= limitBps) within++;
    max = max === null || sp > max ? sp : max;
  }
  return { samples: samples.length, twoSided, maxSpreadBps: max, withinBps: within };
}
