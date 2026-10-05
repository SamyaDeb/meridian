// Unit conversion to WAD (docs/MFI.md §3). bigint only; every division truncates toward zero ("rounds neutral").
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n; // 365 d, PulseConstants.SECONDS_PER_YEAR
const MICROS_TO_WAD = 10n ** 12n;

/** MFI.md §3.2: micros per funding interval → annualized WAD. Rounds neutral (toward zero). */
export function perplRateToAprWad(rateMicros: number, fundingIntervalSec: number): bigint {
  if (!Number.isSafeInteger(rateMicros)) throw new RangeError("rateMicros must be a safe integer");
  if (!Number.isSafeInteger(fundingIntervalSec) || fundingIntervalSec <= 0) throw new RangeError("fundingIntervalSec must be a positive integer");
  return (BigInt(rateMicros) * MICROS_TO_WAD * SECONDS_PER_YEAR) / BigInt(fundingIntervalSec);
}

/** Scaled integer with `decimals` (≤ 18) → WAD. Exact. */
export function scaledToWad(scaled: number, decimals: number): bigint {
  if (!Number.isSafeInteger(scaled)) throw new RangeError("scaled must be a safe integer");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("decimals must be in [0, 18]");
  return BigInt(scaled) * 10n ** BigInt(18 - decimals);
}

/** MFI.md §3.3: OI notional in quote WAD = oi · mark, both scaled. Rounds down (weights only). */
export function perplOiNotionalWad(oi: number, sizeDecimals: number, mark: number, priceDecimals: number): bigint {
  return (scaledToWad(oi, sizeDecimals) * scaledToWad(mark, priceDecimals)) / WAD;
}
