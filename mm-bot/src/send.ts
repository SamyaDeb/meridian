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
}

/** Monad bills the gas limit (ARCHITECTURE R6): limit = ceil(estimate × 1.2) (CLAUDE.md §7). */
export function gasLimitFor(estimate: bigint): bigint {
  return (estimate * 12n + 9n) / 10n;
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
    const gas = gasLimitFor(estimates.reduce((a, b) => (b > a ? b : a)));
    const hashes: `0x${string}`[] = [];
    for (const tx of txs) hashes.push(await io.send(tx, gas)); // in order ⇒ consecutive nonces
    const receipts = await Promise.all(hashes.map((h) => io.wait(h)));
    return { receipts, gasLimits: txs.map(() => gas), pipelined: true };
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
