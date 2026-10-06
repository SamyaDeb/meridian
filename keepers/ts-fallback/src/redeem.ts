// Vault v2 fulfil loop (HARDENING_PLAN P5.3g, CR-014): pure state + decisions, wired in main.ts.
// The keeper learns request ids only from events (the vault never loops over its queue): RedeemRequested adds an id,
// RedeemCancelled / RedeemFulfilled remove it. Each tick it fulfils the oldest ≤ MAX_BATCH pending ids in one
// `fulfillRedeems(ids, route)`. The route is quoted for the EXACT base the vault will sell, read from
// `previewFulfill(ids)` (A-13), minus a haircut (the route may pull at most the hedger's exact approval). On 10143 the
// hedger is the labelled mock (ignores the route) and an empty route is sent. A fulfil that reverts RouteCallFailed or
// SlippageExceeded is retried next tick with a fresh quote; after PAGE_AFTER_FAILURES consecutive failures it pages.

export const MAX_BATCH = 32; // MeridianConstants.MAX_BATCH
export const PAGE_AFTER_FAILURES = 3;
const BPS = 10_000n;

export class RedeemQueue {
  /** id → block of its RedeemRequested log (insertion order = request order). */
  private readonly pending = new Map<bigint, bigint>();

  requested(id: bigint, block: bigint): void {
    if (!this.pending.has(id)) this.pending.set(id, block);
  }

  /** RedeemCancelled or RedeemFulfilled: the id is no longer the keeper's job. */
  done(id: bigint): void {
    this.pending.delete(id);
  }

  get size(): number {
    return this.pending.size;
  }

  /** The oldest ≤ max ids (by request id, i.e. request order). */
  batch(max = MAX_BATCH): bigint[] {
    return [...this.pending.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, max);
  }

  oldestPendingBlocks(current: bigint): bigint {
    let oldest: bigint | null = null;
    for (const b of this.pending.values()) if (oldest === null || b < oldest) oldest = b;
    return oldest === null || current < oldest ? 0n : current - oldest;
  }
}

export type RoutePlan =
  | { kind: "empty"; reason: "idle covers the batch" | "testnet mock hedger" }
  | { kind: "quote"; amountIn: bigint };

/**
 * How to build the fulfil route. `spotToSell` comes from previewFulfill(ids) in the same block the keeper decides.
 * Mainnet (or any chain with a real Flow hedger) quotes WMON → AUSD for spotToSell − haircut; 0 ⇒ no spot leg.
 */
export function fulfilRoutePlan(p: { chainId: number; spotToSell: bigint; haircutBps: bigint; mockHedger: boolean }): RoutePlan {
  if (p.spotToSell === 0n) return { kind: "empty", reason: "idle covers the batch" };
  if (p.mockHedger || p.chainId === 10143) return { kind: "empty", reason: "testnet mock hedger" };
  const amountIn = (p.spotToSell * (BPS - p.haircutBps)) / BPS;
  if (amountIn === 0n) return { kind: "empty", reason: "idle covers the batch" };
  return { kind: "quote", amountIn };
}

export type FulfilFailure = "route" | "other";

/** RouteCallFailed / SlippageExceeded (hedger or vault) ⇒ a fresh quote may fix it; anything else is "other". */
export function classifyFulfilError(e: unknown): FulfilFailure {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /RouteCallFailed|SlippageExceeded|Kuru quote|Kuru \/quote/.test(msg) ? "route" : "other";
}

export class FulfilRetry {
  consecutiveFailures = 0;
  totalFailures = 0;
  lastFailure: FulfilFailure | null = null;

  ok(): void {
    this.consecutiveFailures = 0;
    this.lastFailure = null;
  }

  /** @returns true exactly when this failure reaches the paging threshold (page once per streak). */
  failed(kind: FulfilFailure): boolean {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastFailure = kind;
    return this.consecutiveFailures === PAGE_AFTER_FAILURES;
  }
}

/** Next block range to scan for vault queue logs: ≤ span blocks per call, never past `head`. null if caught up. */
export function nextLogRange(scannedTo: bigint, head: bigint, span: bigint): { from: bigint; to: bigint } | null {
  if (scannedTo >= head) return null;
  const from = scannedTo + 1n;
  const to = from + span - 1n < head ? from + span - 1n : head;
  return { from, to };
}
