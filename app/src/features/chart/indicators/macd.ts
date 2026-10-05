import { ema } from "./ema";

/** MACD(fast, slow, signal): line = EMA(fast) − EMA(slow); signal = EMA(signal) of the line; histogram = line − signal. */
export function macd(values: readonly number[], fast = 12, slow = 26, signalN = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] !== undefined && s[i] !== undefined ? f[i]! - s[i]! : undefined));
  const start = line.findIndex((v) => v !== undefined);
  const sig = start < 0 ? [] : ema(line.slice(start) as number[], signalN);
  const signal = line.map((_, i) => (start >= 0 && i >= start ? sig[i - start] : undefined));
  const histogram = line.map((v, i) => (v !== undefined && signal[i] !== undefined ? v - signal[i]! : undefined));
  return { line, signal, histogram };
}
