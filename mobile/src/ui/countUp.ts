// Count-up for a bigint value (the balance after a deposit arrives): ease-out over COUNT_UP_MS, integer math only (no
// float ever touches the amount). The last frame is exactly `to`.
export const COUNT_UP_MS = 600;

/** Value at elapsed `t` ms of a count from `from` to `to` (ease-out cubic, resolution 1/1000). */
export function countUpAt(from: bigint, to: bigint, t: number, durationMs = COUNT_UP_MS): bigint {
  if (t >= durationMs) return to;
  if (t <= 0) return from;
  const p = t / durationMs;
  const eased = 1 - (1 - p) ** 3;
  const k = BigInt(Math.floor(eased * 1000));
  return from + ((to - from) * k) / 1000n;
}
