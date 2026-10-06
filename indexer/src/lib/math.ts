// Pure bigint math mirrored from docs/MATH_SPEC.md. No floats: money math is bigint only.
// Solidity signed division truncates toward zero, and so does bigint `/`, so "neutral" rounding matches.

export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n; // MeridianConstants.SECONDS_PER_YEAR = 365 days
export const CHECKPOINT_BLOCKS = 200n; // MeridianConstants.CHECKPOINT_BLOCKS
export const AUSD_TO_WAD = 10n ** 12n; // MeridianConstants.AUSD_TO_WAD
export const DEFAULT_BLOCK_TIME_MS = 300n; // MATH_SPEC §1.3 / FundingParams.blockTimeMs (Monad mainnet)

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);
export const sign = (x: bigint): bigint => (x > 0n ? 1n : x < 0n ? -1n : 0n);
export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Ceil division toward +∞ for signed numerator, positive denominator. */
export function divCeil(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divCeil: d must be > 0");
  const q = n / d; // truncates toward zero
  return n % d !== 0n && n > 0n ? q + 1n : q;
}

/** Floor division toward −∞ for signed numerator, positive denominator. */
export function divFloor(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divFloor: d must be > 0");
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

/** Per-second rate WAD → APR WAD (rate · 365 d). */
export const rateToAprWad = (ratePerSecondWad: bigint): bigint => ratePerSecondWad * SECONDS_PER_YEAR;

/**
 * Realized funding (oracle) over a window, MATH_SPEC §1.8, same operation order as
 * IFundingRateOracle.averageFundingApr: avgRate = ΔF·1e18/ΔG (per-second WAD), aprWad = avgRate·YEAR.
 * Display APR = aprWad / 1e18 (the lead's "·31,536,000/1e18"). Undefined when ΔG ≤ 0 (empty window).
 */
export function realizedAprWad(f1: bigint, g1: bigint, f2: bigint, g2: bigint): bigint | undefined {
  const dG = g2 - g1;
  if (dG <= 0n) return undefined;
  const avgRate = ((f2 - f1) * WAD) / dG; // MATH_SPEC §1.8, rounds neutral (toward zero, like Solidity sdiv)
  return avgRate * SECONDS_PER_YEAR;
}

/** Window length in blocks for `seconds` at `blockTimeMs` (block.number based, MATH_SPEC §1.1). */
export const windowBlocks = (seconds: bigint, blockTimeMs: bigint): bigint =>
  (seconds * 1000n) / (blockTimeMs > 0n ? blockTimeMs : DEFAULT_BLOCK_TIME_MS);

export const checkpointBucket = (block: bigint): bigint => block / CHECKPOINT_BLOCKS;

/** Position update on a fill Δq at price P, MATH_SPEC §3.1. Returns the new (q, ON). */
export function applyPerpFill(q: bigint, on: bigint, dq: bigint, priceWad: bigint): { q: bigint; on: bigint } {
  if (dq === 0n) return { q, on };
  if (q === 0n || sign(q) === sign(dq)) {
    // increase: ON += Δq·P, rounds neutral
    return { q: q + dq, on: on + (dq * priceWad) / WAD };
  }
  // decrease: released = ON·c/|q| rounded toward +∞ (MATH_SPEC §3.1)
  const c = min(abs(dq), abs(q));
  const released = divCeil(on * c, abs(q));
  let nq = q + sign(dq) * c;
  let non = on - released;
  const rem = abs(dq) - c;
  if (rem > 0n) {
    // remainder opens the opposite side at P
    const opened = sign(dq) * rem;
    nq += opened;
    non += (opened * priceWad) / WAD;
  }
  return { q: nq, on: non };
}

/** Entry price WAD = |ON|·1e18/|q| (0 if flat), rounds down; display only. */
export const entryPriceWad = (q: bigint, on: bigint): bigint => (q === 0n ? 0n : (abs(on) * WAD) / abs(q));

/** Funding swap fill (MATH_SPEC §6.2): K += Δq·A/1e18, never reduced proportionally. */
export const applySwapFill = (k: bigint, dq: bigint, aprWad: bigint): bigint => k + (dq * aprWad) / WAD;

/** Average fixed APR Ā = K·1e18/q (undefined when q = 0, i.e. flat or a locked spread). */
export const avgFixedAprWad = (q: bigint, k: bigint): bigint | undefined => (q === 0n ? undefined : (k * WAD) / q);

/** Swap book price → fixed APR (MATH_SPEC §6.7): A = p − 1. */
export const swapPriceToAprWad = (priceWad: bigint): bigint => priceWad - WAD;

/** Change in open interest per side when a position moves from oldSize to newSize (base WAD). */
export function oiDelta(oldSize: bigint, newSize: bigint): { long: bigint; short: bigint } {
  return {
    long: max(newSize, 0n) - max(oldSize, 0n),
    short: max(-newSize, 0n) - max(-oldSize, 0n),
  };
}

/**
 * Simple annualized share-price change (vault APY, WS-06 task 5): (sp₁/sp₀ − 1)·YEAR/Δt, WAD, rounds toward zero.
 * Undefined when Δt ≤ 0 or sp₀ = 0.
 */
export function annualizedChangeWad(sp0: bigint, sp1: bigint, dtSeconds: bigint): bigint | undefined {
  if (dtSeconds <= 0n || sp0 === 0n) return undefined;
  return ((sp1 - sp0) * WAD * SECONDS_PER_YEAR) / (sp0 * dtSeconds);
}

/** Candle bucket start (unix seconds). */
export const bucketStart = (ts: bigint, sizeSeconds: bigint): bigint => ts - (ts % sizeSeconds);
