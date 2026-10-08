// W3 Meridian Funding Index (docs/MFI.md). Ports mfi/src/perpl/units.ts + mfi/src/mfi/compute.ts for a stateless CRE
// run: bigint only, every division truncates toward zero ("rounds neutral", MFI §4.4). Weights use the OI at the read
// (the offchain service's 1 h minimum OI needs state across runs; documented in keepers/cre/README.md).
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n;
const MICROS_TO_WAD = 10n ** 12n;

/** MFI §3.2: micros per funding interval → annualized WAD, rounds neutral. */
export function perplRateToAprWad(rateMicros: bigint, fundingIntervalSec: bigint): bigint {
  if (fundingIntervalSec <= 0n) throw new RangeError("fundingIntervalSec must be > 0");
  return (rateMicros * MICROS_TO_WAD * SECONDS_PER_YEAR) / fundingIntervalSec;
}

/** Scaled integer with `decimals` ≤ 18 → WAD, exact. */
export function scaledToWad(scaled: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("decimals must be in [0, 18]");
  return scaled * 10n ** BigInt(18 - decimals);
}

/** MFI §3.3: Perpl OI notional = oi · mark (both scaled), floored. */
export function perplOiNotionalWad(oi: bigint, sizeDecimals: number, mark: bigint, priceDecimals: number): bigint {
  return (scaledToWad(oi, sizeDecimals) * scaledToWad(mark, priceDecimals)) / WAD;
}

/** MFI §3.3: Meridian OI notional = longOI · mark / 1e18, floored. */
export function meridianOiNotionalWad(longOI: bigint, markWad: bigint): bigint {
  return (longOI * markWad) / WAD;
}

export type Venue = { aprWad: bigint; oiWad: bigint };

/**
 * MFI §4.2 over the included venues: OI-weighted mean; equal weights when Σ OI = 0; null when none is included.
 * The result always lies within [min, max] of the venue APRs (what MeridianMfiFeed checks onchain).
 */
export function computeMfi(venues: readonly Venue[]): bigint | null {
  if (venues.length === 0) return null;
  const oi = (v: Venue) => (v.oiWad > 0n ? v.oiWad : 0n);
  const total = venues.reduce((s, v) => s + oi(v), 0n);
  if (total === 0n) return venues.reduce((s, v) => s + v.aprWad, 0n) / BigInt(venues.length);
  return venues.reduce((s, v) => s + oi(v) * v.aprWad, 0n) / total;
}

/** Perpl FundingEvent subset (PerplFoundation/api-docs types.md): `at.t` ms, `rate` micros/interval. */
export type FundingEvent = { at: { b?: number; t?: number }; feb: number; rate: number };

/** The event in force at `nowMs`: the newest with at.t ≤ now (the newest may apply up to ~1 min ahead, MFI §2). */
export function fundingInForce(events: readonly FundingEvent[], nowMs: number): FundingEvent | undefined {
  const sorted = [...events].sort((a, b) => a.feb - b.feb);
  const inForce = sorted.filter((e) => e.at.t === undefined || e.at.t <= nowMs);
  return inForce.at(-1) ?? sorted[0];
}

/** Perpl funding series path for the window [now − 2 intervals, now + 1 interval] (MFI §2, rest-endpoints.md). */
export function perplFundingPath(marketId: number, nowMs: number, intervalSec: number): string {
  const iv = intervalSec * 1000;
  return `/v1/market-data/${marketId}/funding/${nowMs - 2 * iv}-${nowMs + iv}`;
}
