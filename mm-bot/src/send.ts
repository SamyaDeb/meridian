// Transaction batching for re-quotes. Pure orchestration over injected RPC functions (unit-tested with fakes).
//
// Why: awaiting each receipt costs one block per order, so a full 6-order re-quote after a sharp index move
// took 6 blocks on the local rehearsal (Phase 3 step 3), and the perp mark (median of index-implied, book mid,
// last trade) only follows once the book has moved, which delays liquidations. Pipelined, the batch is sent
// back-to-back with consecutive nonces (the planner's order is kept, so our quotes still never self-cross) and
// all receipts are awaited together: typically one block.

export interface BatchIo<Tx, Receipt> {
  /** eth_estimateGas against the latest state; throws if the call would revert there. */
  estimate(tx: Tx): Promise<bigint>;
  /** Signs and sends with the given gas limit (nonces assigned in call order); returns the hash. */
  send(tx: Tx, gas: bigint): Promise<`0x${string}`>;
  wait(hash: `0x${string}`): Promise<Receipt>;
  /**
   * Gas limits for a fully pipelined batch from the per-tx estimates (same order). Default: every tx gets
   * gasLimitFor(max estimate) (the Phase 3 rule); the MM passes gasLimitsForBatch.
   */
  limits?(txs: readonly Tx[], estimates: readonly bigint[]): bigint[];
}

/** Monad bills the gas limit (ARCHITECTURE R6): limit = ceil(estimate × 1.2) (CONTRIBUTING.md §7). */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n;
}

export interface GasItem {
  estimate: bigint;
  /** book side the tx writes (its level + that side's bitmap); null = touches no level */
  side: "bid" | "ask" | null;
}

export interface GasPolicy {
  /**
   * Added to a tx's own estimate when an EARLIER tx of the same batch writes the same side: that tx may empty a level
   * or bitmap word this one then re-creates (zero→nonzero SSTORE 17k per slot + MIP-8 page 8.1k/2.8k), which the
   * estimate against the pre-batch state doesn't see. 45k = 2 × 17k + 8.1k + 2.8k.
   */
  conflictBufferGas: bigint;
  /**
   * Added to every tx when estimates may exclude the block's first funding touch (an estimate at `latest` whose block
   * was already touched; the tx then lands first in a new block). 0 when estimating against `pending` (anvil does).
   */
  touchAllowanceGas: bigint;
}

/**
 * Per-tx gas limits for a pipelined batch: ceil((own estimate + touch allowance + conflict buffer if an earlier tx of
 * the batch wrote the same side) × 1.2), capped at the Phase 3 rule gasLimitFor(max estimate + touch allowance), so a
 * batch is never billed more than before. Phase 3: every tx got the batch max × 1.2 (limit 331,910 vs 122–184k used
 * ⇒ up to 2.5× the billed gas on Monad, which bills the limit). Local rehearsal, 30 Sep: estimates against `pending`
 * already include the block's first funding touch (≈ 70k on anvil) that only the first tx of a block pays, which is
 * more headroom than the conflict buffer; hence the cap loses no safety the old rule had.
 */
export function gasLimitsForBatch(items: readonly GasItem[], p: GasPolicy): bigint[] {
  const max = items.reduce((a, b) => (b.estimate > a ? b.estimate : a), 0n);
  const cap = gasLimitFor(max + p.touchAllowanceGas);
  const seen = new Set<string>();
  return items.map((it) => {
    const conflict = it.side !== null && seen.has(it.side);
    if (it.side !== null) seen.add(it.side);
    const own = gasLimitFor(it.estimate + p.touchAllowanceGas + (conflict ? p.conflictBufferGas : 0n));
    return own < cap ? own : cap;
  });
}

export interface BatchResult<Receipt> {
  receipts: Receipt[];
  gasLimits: bigint[];
  pipelined: boolean;
}

/**
 * Send `txs` in order. If every tx estimates against the current state, send them all back-to-back, each with
 * limit = gasLimitFor(max estimate) (later txs run on state changed by earlier ones in the batch, so the largest
 * estimate is the headroom), then await all receipts. If any estimate throws (a tx that is only valid after an
 * earlier one lands), fall back to one-at-a-time: estimate, send, await receipt, next.
 */
export async function sendBatch<Tx, Receipt>(txs: readonly Tx[], io: BatchIo<Tx, Receipt>): Promise<BatchResult<Receipt>> {
  if (txs.length === 0) return { receipts: [], gasLimits: [], pipelined: true };
  const estimates = await Promise.all(txs.map((tx) => io.estimate(tx).catch(() => null)));
  if (estimates.every((e): e is bigint => e !== null)) {
    const max = gasLimitFor(estimates.reduce((a, b) => (b > a ? b : a)));
    const gasLimits = io.limits ? io.limits(txs, estimates) : txs.map(() => max);
    const hashes: `0x${string}`[] = [];
    for (let i = 0; i < txs.length; i++) hashes.push(await io.send(txs[i]!, gasLimits[i]!)); // in order ⇒ consecutive nonces
    const receipts = await Promise.all(hashes.map((h) => io.wait(h)));
    return { receipts, gasLimits, pipelined: true };
  }
  const receipts: Receipt[] = [];
  const gasLimits: bigint[] = [];
  for (const tx of txs) {
    const gas = gasLimitFor(await io.estimate(tx));
    receipts.push(await io.wait(await io.send(tx, gas)));
    gasLimits.push(gas);
  }
  return { receipts, gasLimits, pipelined: false };
}
