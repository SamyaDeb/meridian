/**
 * RSI with Wilder smoothing: first average gain / loss = simple mean of the first n changes, then
 * avg = (prev·(n−1) + current)/n. RSI = 100 − 100/(1 + avgGain/avgLoss); 100 when there is no loss.
 */
export function rsi(values: readonly number[], n = 14): (number | undefined)[] {
  if (n <= 0) throw new RangeError("period must be > 0");
  const out: (number | undefined)[] = values.length ? [undefined] : [];
  let g = 0;
  let l = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    if (i <= n) {
      g += gain;
      l += loss;
      if (i < n) {
        out.push(undefined);
        continue;
      }
      g /= n;
      l /= n;
    } else {
      g = (g * (n - 1) + gain) / n;
      l = (l * (n - 1) + loss) / n;
    }
    out.push(l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  }
  return out;
}
