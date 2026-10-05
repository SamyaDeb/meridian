/** Exponential moving average, α = 2/(n+1), seeded with the SMA of the first n values (the common convention). */
export function ema(values: readonly number[], n: number): (number | undefined)[] {
  if (n <= 0) throw new RangeError("period must be > 0");
  const k = 2 / (n + 1);
  const out: (number | undefined)[] = [];
  let prev: number | undefined;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (i < n - 1) {
      seed += v;
      out.push(undefined);
    } else if (i === n - 1) {
      prev = (seed + v) / n;
      out.push(prev);
    } else {
      prev = v * k + prev! * (1 - k);
      out.push(prev);
    }
  }
  return out;
}
