// Block-head liveness (per-block heartbeat). Pure: the caller supplies wall-clock time. Ported from app/src/lib/blocks.ts.

/** No new block for this long ⇒ stale. Blocks are ~300 ms, polls 300 ms; 10 missed blocks is unambiguous. */
export const STALE_AFTER_MS = 3_000;

export type HeadState = { block: bigint; seenAtMs: number } | undefined;

/** Records `block` if it advanced (a lower or equal head never refreshes liveness: a lagging RPC is not progress). */
export function observeHead(prev: HeadState, block: bigint, nowMs: number): HeadState {
  if (prev && block <= prev.block) return prev;
  return { block, seenAtMs: nowMs };
}

export type Liveness = "waiting" | "live" | "stale";
export function liveness(head: HeadState, nowMs: number, staleAfterMs = STALE_AFTER_MS): Liveness {
  if (!head) return "waiting";
  return nowMs - head.seenAtMs > staleAfterMs ? "stale" : "live";
}
