import { sma } from "./sma";

/** Bollinger Bands: middle = SMA(n), bands = middle ± k·σ (population standard deviation over the window). */
export function bollinger(values: readonly number[], n = 20, k = 2): { middle: (number | undefined)[]; upper: (number | undefined)[]; lower: (number | undefined)[] } {
  const middle = sma(values, n);
  const upper: (number | undefined)[] = [];
  const lower: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i++) {
    const m = middle[i];
    if (m === undefined) {
      upper.push(undefined);
      lower.push(undefined);
      continue;
    }
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (values[j]! - m) ** 2;
    const sd = Math.sqrt(ss / n);
    upper.push(m + k * sd);
    lower.push(m - k * sd);
  }
  return { middle, upper, lower };
}
