// Block-range helper shared by the chain source and its incremental log window.

/** Pure: [from, to] split into inclusive ranges of at most `span` blocks (RPC eth_getLogs caps). */
export function blockRanges(from: bigint, to: bigint, span: bigint): Array<[bigint, bigint]> {
  if (span <= 0n) throw new Error("span must be > 0");
  const out: Array<[bigint, bigint]> = [];
  for (let s = from; s <= to; s += span) out.push([s, s + span - 1n < to ? s + span - 1n : to]);
  return out;
}
