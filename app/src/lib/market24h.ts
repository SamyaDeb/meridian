// 24-hour market stats from hourly candles (market strip, FRONTEND_TRADE_PLAN §6.1). Pure, bigint WAD.
import type { Candle } from "@/data/types";
import { WAD } from "./units";

export type Stats24h = {
  /** first candle's open inside the window (the reference for the change) */
  open: bigint;
  last: bigint;
  high: bigint;
  low: bigint;
  /** last − open (WAD) */
  change: bigint;
  /** (last − open) / open as WAD, rounds toward zero (display only) */
  changeWad: bigint;
  volumeBaseWad: bigint;
  volumeQuoteWad: bigint;
  /** bucketStart of the oldest candle used: if > now − 24 h, history is shorter than 24 h and the UI says so */
  fromSec: bigint;
};

/**
 * Candles with bucketStart ≥ nowSec − 24 h (hourly buckets, so the oldest one may start up to 1 h before the window:
 * it is included only if it overlaps). Undefined when there is no candle in the window (no trades in 24 h).
 */
export function stats24h(candles: readonly Candle[], nowSec: bigint, bucketSec = 3_600n): Stats24h | undefined {
  const from = nowSec - 86_400n;
  const w = candles.filter((c) => c.bucketStart + bucketSec > from && c.bucketStart <= nowSec).sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : 1));
  const first = w[0];
  const lastC = w[w.length - 1];
  if (!first || !lastC) return undefined;
  let high = first.high;
  let low = first.low;
  let vb = 0n;
  let vq = 0n;
  for (const c of w) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    vb += c.volumeBaseWad;
    vq += c.volumeQuoteWad;
  }
  const change = lastC.close - first.open;
  return {
    open: first.open,
    last: lastC.close,
    high,
    low,
    change,
    changeWad: first.open === 0n ? 0n : (change * WAD) / first.open,
    volumeBaseWad: vb,
    volumeQuoteWad: vq,
    fromSec: first.bucketStart,
  };
}
