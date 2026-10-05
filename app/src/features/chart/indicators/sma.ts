/** Simple moving average; undefined until `n` values exist. Display-only floats. */
export function sma(values: readonly number[], n: number): (number | undefined)[] {
  if (n <= 0) throw new RangeError("period must be > 0");
  const out: (number | undefined)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    out.push(i >= n - 1 ? sum / n : undefined);
  }
  return out;
}
