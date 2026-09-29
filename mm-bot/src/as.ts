// Avellaneda–Stoikov market making in basis points relative to mid (MATH_SPEC §4). Pure: no RPC, no clocks.
// Money and prices are bigint WAD; the model's bps offsets are plain numbers (dimensionless, never money).

export const SECONDS_PER_YEAR = 31_536_000;

/** σ in bps/√s from an annualized vol (1 = 100%): 1e4·vol/√YEAR. */
export function sigmaFromAnnualVol(vol: number): number {
  return (1e4 * vol) / Math.sqrt(SECONDS_PER_YEAR);
}

export interface AsParams {
  /** bps/√s */
  sigma: number;
  /** risk aversion, 1/bps */
  gamma: number;
  /** order-arrival decay, 1/bps */
  k: number;
  /** rolling horizon T − t, seconds */
  horizonSec: number;
  /** inventory / maxInventory ∈ [−1, 1] */
  q: number;
}

/** MATH_SPEC §4 defaults: σ at 100% vol, γ 0.01, k 0.5, T − t 60 s. */
export const DEFAULTS: Omit<AsParams, "q"> = { sigma: sigmaFromAnnualVol(1), gamma: 0.01, k: 0.5, horizonSec: 60 };

export interface AsQuote {
  inventoryTerm: number; // γσ²(T−t)
  arrivalTerm: number; // (2/γ)·ln(1 + γ/k)
  spread: number; // δ, total
  reservation: number; // r
  bidBps: number; // r − δ/2
  askBps: number; // r + δ/2
}

/** r = −q·γσ²(T−t); δ = γσ²(T−t) + (2/γ)ln(1+γ/k). */
export function quoteBps(p: AsParams): AsQuote {
  const inventoryTerm = p.gamma * p.sigma * p.sigma * p.horizonSec;
  const arrivalTerm = (2 / p.gamma) * Math.log(1 + p.gamma / p.k);
  const spread = inventoryTerm + arrivalTerm;
  const reservation = p.q === 0 ? 0 : -p.q * inventoryTerm;
  return { inventoryTerm, arrivalTerm, spread, reservation, bidBps: reservation - spread / 2, askBps: reservation + spread / 2 };
}

/** position / maxInventory, clamped to [−1, 1] (both WAD). */
export function inventoryRatio(positionWad: bigint, maxInventoryWad: bigint): number {
  if (maxInventoryWad <= 0n) return 0;
  const r = Number((positionWad * 1_000_000n) / maxInventoryWad) / 1_000_000;
  return Math.max(-1, Math.min(1, r));
}

/** Realized σ (bps/√s) of log returns over the samples; `fallback` with fewer than 3 samples. */
export function realizedSigmaBpsPerSqrtSec(samples: readonly { t: number; price: bigint }[], fallback: number): number {
  if (samples.length < 3) return fallback;
  let sum = 0;
  let dt = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (a.price <= 0n || b.price <= 0n || b.t <= a.t) continue;
    const ret = Math.log(Number((b.price * 1_000_000_000n) / a.price) / 1e9) * 1e4; // bps
    sum += ret * ret;
    dt += b.t - a.t;
  }
  return dt > 0 ? Math.sqrt(sum / dt) : fallback;
}

export interface LadderParams {
  midWad: bigint;
  tickSize: bigint;
  bidBps: number;
  askBps: number;
  levels: number;
  levelSpacingBps: number;
  lotsPerLevel: bigint;
  q: number;
}

export interface Level {
  tick: number;
  lots: bigint;
}

const MAX_TICK = 2 ** 24 - 1;
const SCALE = 100_000_000n; // bps with 1e-4 precision: price·(1e8 + round(bps·1e4)) / 1e8

function priceAt(mid: bigint, bps: number): bigint {
  return (mid * (SCALE + BigInt(Math.round(bps * 1e4)))) / SCALE;
}

/**
 * `levels` quotes per side, `levelSpacingBps` apart, snapped bid ↓ / ask ↑ to the tick grid (MATH_SPEC §4).
 * One-sided at the inventory limits (q = +1: asks only; q = −1: bids only). Inner bid < inner ask always.
 */
export function buildLadder(p: LadderParams): { bids: Level[]; asks: Level[] } {
  const bids: Level[] = [];
  const asks: Level[] = [];
  let innerBid = 0;
  for (let i = 0; i < p.levels && p.q < 1; i++) {
    const t = Number(priceAt(p.midWad, p.bidBps - i * p.levelSpacingBps) / p.tickSize); // floor
    if (t < 1) break;
    if (i === 0) innerBid = t;
    bids.push({ tick: t, lots: p.lotsPerLevel });
  }
  for (let i = 0; i < p.levels && p.q > -1; i++) {
    const px = priceAt(p.midWad, p.askBps + i * p.levelSpacingBps);
    let t = Number((px + p.tickSize - 1n) / p.tickSize); // ceil
    if (i === 0 && innerBid !== 0 && t <= innerBid) t = innerBid + 1;
    if (t > MAX_TICK) break;
    asks.push({ tick: t, lots: p.lotsPerLevel });
  }
  // de-duplicate levels that snapped onto the same tick (tiny spacing) by keeping the first
  const dedupe = (xs: Level[]) => xs.filter((x, i) => xs.findIndex((y) => y.tick === x.tick) === i);
  return { bids: dedupe(bids), asks: dedupe(asks) };
}

export interface SigmaGuards {
  /** σ to use until the samples cover `minCoverageSec`, or when realized σ is 0 */
  fallback: number;
  minCoverageSec: number;
  /** cap (bps/√s): one gap must not blow the spread up (a −40% jump would otherwise quote ~400%) */
  max: number;
}

/** Realized σ for quoting: fallback on thin/flat history, capped at `max`. */
export function sigmaForQuoting(samples: readonly { t: number; price: bigint }[], g: SigmaGuards): number {
  if (samples.length < 3) return g.fallback;
  const coverage = samples[samples.length - 1]!.t - samples[0]!.t;
  if (coverage < g.minCoverageSec) return g.fallback;
  const s = realizedSigmaBpsPerSqrtSec(samples, g.fallback);
  if (!(s > 0)) return g.fallback;
  return Math.min(s, g.max);
}
