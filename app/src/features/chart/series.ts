// Display-boundary helpers for the chart (floats only here, never in money math).
import type { Bar } from "./datafeed/types";

/** WAD → number for drawing. Drops 6 of 18 decimals first so the float keeps full 12-dp precision for prices < 2^53/1e12. */
export const wadToNum = (wad: bigint): number => Number(wad / 1_000_000n) / 1e12;

/** Number → WAD (click-to-price), rounding to 12 dp; the ticket snaps it to a tick anyway. */
export const numToWad = (n: number): bigint => (Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e12)) * 1_000_000n : 0n);

/**
 * Wall-clock estimate of a block's time from one observed head (block, ms) and the nominal block time. Chain-mode
 * logs carry no timestamp; the UI labels these times approximate. Indexer data has real timestamps.
 */
export const estimateBlockTimeSec = (block: bigint, headBlock: bigint, headMs: number, blockTimeMs: number): number =>
  Math.floor((headMs - Number(headBlock - block) * blockTimeMs) / 1_000);

/**
 * Heikin-Ashi transform (bigint, exact halves/quarters rounded down): HA close = (O+H+L+C)/4, HA open = (prev HA open +
 * prev HA close)/2 (first: (O+C)/2), HA high/low = extremes including HA open/close.
 */
export function heikinAshi(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const prev = out[out.length - 1];
    const close = (b.open + b.high + b.low + b.close) / 4n;
    const open = prev ? (prev.open + prev.close) / 2n : (b.open + b.close) / 2n;
    const high = [b.high, open, close].reduce((a, x) => (x > a ? x : a));
    const low = [b.low, open, close].reduce((a, x) => (x < a ? x : a));
    out.push({ ...b, open, high, low, close });
  }
  return out;
}
