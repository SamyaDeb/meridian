// Pure candle aggregation (FRONTEND_TRADE_PLAN §4.1): open = first, close = last, high / low = extremes,
// volume = sum; empty buckets carry the previous close with zero volume, flagged gapFill.
import type { Candle } from "@/data/types";
import type { Bar } from "./types";

/** Indexer candle → Bar (bucketStart seconds → number; safe: unix seconds ≪ 2^53). */
export const toBar = (c: Candle): Bar => ({
  time: Number(c.bucketStart),
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volumeBaseWad: c.volumeBaseWad,
  volumeQuoteWad: c.volumeQuoteWad,
  trades: c.trades,
});

const floorTo = (t: number, sec: number, offset = 0) => t - ((((t - offset) % sec) + sec) % sec);

/**
 * Aggregates bars (any order, same or finer bucket) into `targetSec` buckets aligned to UTC. Input gap-fill bars
 * keep contributing their (carried) prices but no volume. Output sorted, without gaps unless `gapFill`.
 */
export function aggregate(bars: readonly Bar[], targetSec: number, gapFill = false, offsetSec = 0): Bar[] {
  if (targetSec <= 0) throw new RangeError("targetSec must be > 0");
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const out: Bar[] = [];
  let cur: Bar | undefined;
  for (const b of sorted) {
    const t = floorTo(b.time, targetSec, offsetSec);
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volumeBaseWad: b.volumeBaseWad, volumeQuoteWad: b.volumeQuoteWad, trades: b.trades, ...(b.gapFill ? { gapFill: true as const } : {}) };
      continue;
    }
    if (b.high > cur.high) cur.high = b.high;
    if (b.low < cur.low) cur.low = b.low;
    cur.close = b.close;
    cur.volumeBaseWad += b.volumeBaseWad;
    cur.volumeQuoteWad += b.volumeQuoteWad;
    cur.trades += b.trades;
    if (!b.gapFill && cur.gapFill) delete cur.gapFill; // a real trade makes the bucket real
  }
  if (cur) out.push(cur);
  return gapFill ? fillGaps(out, targetSec) : out;
}

/**
 * Inserts carried bars for missing buckets between the first and last bar. At most `maxBars` are returned, and they
 * are always the NEWEST: the fill runs backwards from the last bar. (Capping from the front dropped the recent candles
 * whenever a sparse history spanned more than maxBars buckets, e.g. 1m bars from a few trades on 30 Sep to today.)
 */
export function fillGaps(bars: readonly Bar[], sec: number, maxBars = 5_000): Bar[] {
  const rev: Bar[] = [];
  for (let i = bars.length - 1; i >= 0 && rev.length < maxBars; i--) {
    const b = bars[i]!;
    rev.push(b);
    const prev = bars[i - 1];
    if (!prev) continue;
    for (let t = b.time - sec; t > prev.time && rev.length < maxBars; t -= sec) {
      rev.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0, gapFill: true });
    }
  }
  return rev.reverse();
}

/**
 * Live update from one trade at `priceWad` (per block): extends the last bar when the trade falls in it, else opens a
 * new bar (gap-filling in between is the caller's choice). Returns a new array; the input is not mutated.
 * Price-only use (size 0, countTrade false) is idempotent: re-applying the same trades never changes the bars, so
 * live prices can overlay indexer candles without double-counting volume.
 */
export function applyTrade(bars: readonly Bar[], sec: number, timeSec: number, priceWad: bigint, sizeWad: bigint, notionalWad: bigint, countTrade = true): Bar[] {
  const t = floorTo(timeSec, sec);
  const last = bars[bars.length - 1];
  if (last && t < last.time) return [...bars]; // late trade for an older bucket: the next indexer refresh carries it
  if (last && last.time === t) {
    const u: Bar = {
      ...last,
      high: priceWad > last.high ? priceWad : last.high,
      low: priceWad < last.low ? priceWad : last.low,
      close: priceWad,
      volumeBaseWad: last.volumeBaseWad + sizeWad,
      volumeQuoteWad: last.volumeQuoteWad + notionalWad,
      trades: last.trades + (countTrade ? 1 : 0),
    };
    delete u.gapFill;
    return [...bars.slice(0, -1), u];
  }
  return [...bars, { time: t, open: priceWad, high: priceWad, low: priceWad, close: priceWad, volumeBaseWad: sizeWad, volumeQuoteWad: notionalWad, trades: countTrade ? 1 : 0 }];
}

/**
 * Candles from a price series (oracle index or mark points): open = first point in the bucket, close = last,
 * high / low = extremes; no volume (these prices are not trades). Points in any order; buckets UTC aligned.
 */
export function pointsToBars(points: readonly { time: number; price: bigint }[], sec: number, offsetSec = 0): Bar[] {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const out: Bar[] = [];
  for (const p of sorted) {
    const t = floorTo(p.time, sec, offsetSec);
    const cur = out[out.length - 1];
    if (cur && cur.time === t) {
      if (p.price > cur.high) cur.high = p.price;
      if (p.price < cur.low) cur.low = p.price;
      cur.close = p.price;
    } else out.push({ time: t, open: p.price, high: p.price, low: p.price, close: p.price, volumeBaseWad: 0n, volumeQuoteWad: 0n, trades: 0 });
  }
  return out;
}
