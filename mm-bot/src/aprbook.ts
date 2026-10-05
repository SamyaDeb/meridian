// Funding-swap book quoting on the APR axis (MATH_SPEC §4 last paragraph, §6.1). Pure: no RPC, no clocks.
// The swap book's price is p = 1 + A (WAD) with tickSize 1e14 = 1 bp of APR, so the A–S model runs in ABSOLUTE APR
// bps around the anchor APR (not bps relative to the price, as on the perp): bid = anchor + r − δ/2, ask = anchor + r + δ/2.
import type { Level } from "./as.js";

export const WAD = 10n ** 18n;
export const APR_BP_WAD = 10n ** 14n; // 1 bp of APR in WAD
export const SECONDS_PER_YEAR_BIG = 31_536_000n;

/** APR WAD → APR bps (float, for the model; 12% = 1200). */
export function aprWadToBps(aprWad: bigint): number {
  return Number(aprWad) / 1e14;
}

/** Perp funding rate (per second, WAD) → APR (WAD): r·YEAR (MATH_SPEC §1.8, simple APR). */
export function rateToAprWad(ratePerSecWad: bigint): bigint {
  return ratePerSecWad * SECONDS_PER_YEAR_BIG;
}

export type AnchorSource = "realized-8h" | "perp-rate";

/**
 * Anchor for the swap quotes: the oracle's realized 8 h APR (MATH_SPEC §4). Until the perp has 8 h of checkpoints
 * (`realizedApr` reverts ObservationTooOld ⇒ null) the perp's current funding rate as APR, and the caller logs it.
 */
export function chooseAnchor(realized8hAprWad: bigint | null, perpRatePerSecWad: bigint): { aprWad: bigint; source: AnchorSource } {
  if (realized8hAprWad !== null) return { aprWad: realized8hAprWad, source: "realized-8h" };
  return { aprWad: rateToAprWad(perpRatePerSecWad), source: "perp-rate" };
}

/** Swap-book tick of an APR (bps, float): price = 1 + APR. Bid snaps ↓, ask snaps ↑ (never quote better than the model). */
export function aprBpsToTick(aprBps: number, tickSize: bigint, side: "bid" | "ask"): number {
  // price·1e8 in integer "1e-4 bp" units to avoid float drift: priceWad = 1e18 + aprBps·1e14
  const priceWad = WAD + BigInt(Math.round(aprBps * 1e4)) * (APR_BP_WAD / 10_000n);
  if (priceWad <= 0n) return 0;
  return Number(side === "bid" ? priceWad / tickSize : (priceWad + tickSize - 1n) / tickSize);
}

/** APR (WAD) of a swap-book tick: tick·tickSize − 1e18. */
export function tickToAprWad(tick: number, tickSize: bigint): bigint {
  return BigInt(tick) * tickSize - WAD;
}

/**
 * Realized σ of the anchor APR in APR bps/√s from ABSOLUTE changes (an APR can cross 0, so no log returns):
 * √(Σ Δapr² / Σ Δt). Fallback with < 3 samples, < `minCoverageSec` of history or a flat series; capped at `max`.
 */
export function aprSigma(samples: readonly { t: number; aprBps: number }[], g: { fallback: number; minCoverageSec: number; max: number }): number {
  if (samples.length < 3) return g.fallback;
  if (samples[samples.length - 1]!.t - samples[0]!.t < g.minCoverageSec) return g.fallback;
  let sum = 0;
  let dt = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b.t <= a.t) continue;
    sum += (b.aprBps - a.aprBps) ** 2;
    dt += b.t - a.t;
  }
  const s = dt > 0 ? Math.sqrt(sum / dt) : 0;
  return s > 0 ? Math.min(s, g.max) : g.fallback;
}

export interface AprLadderParams {
  anchorAprBps: number;
  tickSize: bigint;
  /** A–S offsets in APR bps (quoteBps: r − δ/2 and r + δ/2) */
  bidBps: number;
  askBps: number;
  levels: number;
  levelSpacingBps: number;
  lotsPerLevel: bigint;
  /** inventory / maxPositionSize ∈ [−1, 1]; one-sided at the limits */
  q: number;
}

/** `levels` quotes per side on the APR axis, bid ↓ / ask ↑ snapped, inner bid < inner ask, price > 0. */
export function buildAprLadder(p: AprLadderParams): { bids: Level[]; asks: Level[] } {
  const bids: Level[] = [];
  const asks: Level[] = [];
  let innerBid = 0;
  for (let i = 0; i < p.levels && p.q < 1; i++) {
    const t = aprBpsToTick(p.anchorAprBps + p.bidBps - i * p.levelSpacingBps, p.tickSize, "bid");
    if (t < 1) break;
    if (i === 0) innerBid = t;
    if (!bids.some((b) => b.tick === t)) bids.push({ tick: t, lots: p.lotsPerLevel });
  }
  for (let i = 0; i < p.levels && p.q > -1; i++) {
    let t = aprBpsToTick(p.anchorAprBps + p.askBps + i * p.levelSpacingBps, p.tickSize, "ask");
    // APR ≤ −100% ⇒ price ≤ 0 ⇒ tick 0, which the OrderBook rejects (InvalidTick); a wider level may still price > 0
    if (t < 1) continue;
    if (i === 0 && innerBid !== 0 && t <= innerBid) t = innerBid + 1;
    if (t > 2 ** 24 - 1) break;
    if (!asks.some((a) => a.tick === t)) asks.push({ tick: t, lots: p.lotsPerLevel });
  }
  return { bids, asks };
}

/** |Δanchor| in whole APR bps (the requote trigger on the APR axis). */
export function movedAprBps(a: bigint, b: bigint): bigint {
  const d = a > b ? a - b : b - a;
  return d / APR_BP_WAD;
}

/** Blocks in `sec` seconds at `blockTimeMs` (the CH's funding param): 8 h at 300 ms = 96,000. */
export function blocksFor(sec: number, blockTimeMs: bigint): bigint {
  return (BigInt(sec) * 1000n) / blockTimeMs;
}
