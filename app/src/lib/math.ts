// MATH_SPEC formulas the app previews. bigint only; each carries its section and rounding direction.
import { SECONDS_PER_YEAR, WAD, AUSD_TO_WAD } from "./units";

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** Signed division rounding toward +∞ (d > 0). */
export function divCeil(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("divCeil: d must be > 0");
  const q = n / d;
  return n % d !== 0n && n > 0n ? q + 1n : q;
}

/** Signed division rounding toward −∞ (d > 0). */
export function divFloor(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("divFloor: d must be > 0");
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

/** MATH_SPEC §1.4: pending funding owed by the account, ceil(q·(F_preview − F_entry)/1e18). + = user pays. Rounds up (against the user). */
export const pendingFundingWad = (sizeWad: bigint, fPreview: bigint, fEntry: bigint): bigint =>
  divCeil(sizeWad * (fPreview - fEntry), WAD);

/** Rate per second (WAD) → APR (WAD). */
export const rateToAprWad = (ratePerSecondWad: bigint): bigint => ratePerSecondWad * SECONDS_PER_YEAR;

/** MATH_SPEC §1.8: realized APR = (F₂−F₁)·1e18/(G₂−G₁)·YEAR (WAD). Same op order as averageFundingApr. Rounds neutral. */
export function realizedAprWad(f1: bigint, g1: bigint, f2: bigint, g2: bigint): bigint | undefined {
  const dG = g2 - g1;
  if (dG <= 0n) return undefined;
  return (((f2 - f1) * WAD) / dG) * SECONDS_PER_YEAR;
}

/**
 * MATH_SPEC §3.2 liquidation price preview (isolated, ignores funding):
 *   long  P = (E − C/q)/(1 − mmr), short P = (E + C/|q|)/(1 + mmr).
 * Rounded to warn early: long rounds up, short rounds down. Returns undefined if flat or never liquidatable (P ≤ 0).
 */
export function liquidationPriceWad(entryWad: bigint, collateralWad: bigint, sizeWad: bigint, mmrWad: bigint): bigint | undefined {
  if (sizeWad === 0n) return undefined;
  if (sizeWad > 0n) {
    const num = entryWad - divFloor(collateralWad * WAD, sizeWad); // E − C/q, C/q rounded down ⇒ num rounded up
    if (num <= 0n || mmrWad >= WAD) return undefined;
    return divCeil(num * WAD, WAD - mmrWad);
  }
  const num = entryWad + (collateralWad * WAD) / abs(sizeWad); // rounds down
  return divFloor(num * WAD, WAD + mmrWad);
}

/** Initial margin for a new order: |q|·P·imr (MATH_SPEC §3.2, rounds up). */
export const initialMarginWad = (sizeWad: bigint, priceWad: bigint, imrWad: bigint): bigint =>
  divCeil(divCeil(abs(sizeWad) * priceWad, WAD) * imrWad, WAD);

/** Leverage × 1e18 = notional / collateral. */
export const leverageWad = (sizeWad: bigint, priceWad: bigint, collateralWad: bigint): bigint =>
  collateralWad === 0n ? 0n : (((abs(sizeWad) * priceWad) / WAD) * WAD) / collateralWad;

/** Swap book price p ⇒ fixed APR p − 1 (MATH_SPEC §6.7). */
export const swapPriceToAprWad = (priceWad: bigint): bigint => priceWad - WAD;

/**
 * MATH_SPEC §6.2 accrual preview, exactly as SwapMathLib.net (PHASES decision 9): ONE floor division,
 * net = ⌊(q·ΔF·YEAR − K·ΔG) / (1e18·YEAR)⌋ (rounds down, against the account for either sign).
 */
export function swapAccrualPreviewWad(q: bigint, k: bigint, dF: bigint, dG: bigint): bigint {
  return divFloor(q * dF * SECONDS_PER_YEAR - k * dG, WAD * SECONDS_PER_YEAR);
}

/** MATH_SPEC §6.3 value of the remaining stream: V = (q·markApr/1e18 − K)·I/1e18·τ/YEAR. Rounds down. */
export function swapPositionValueWad(q: bigint, k: bigint, markAprWad: bigint, indexWad: bigint, tauSeconds: bigint): bigint {
  const stream = divFloor(q * markAprWad, WAD) - k;
  return divFloor(stream * indexWad * (tauSeconds > 0n ? tauSeconds : 0n), WAD * SECONDS_PER_YEAR);
}

/** Closed swap with q = 0, K ≠ 0 is a locked spread (show "locked +x AUSD until maturity"). */
export const isLockedSpread = (q: bigint, k: bigint): boolean => q === 0n && k !== 0n;

/**
 * Vault share price (WAD, 1e18 at par) exactly as PulseVault.sharePrice(): (totalAssets + 1)·1e30 / (totalSupply + 1e12)
 * (ERC-4626 virtual offset 12). Prefer reading sharePrice() onchain; this is for previews / indexer data. Rounds down.
 */
export const vaultSharePriceWad = (totalAssetsToken: bigint, totalSupply: bigint): bigint =>
  ((totalAssetsToken + 1n) * 10n ** 30n) / (totalSupply + 10n ** 12n);

/** Simple annualized return between two share prices over dt seconds: (p1/p0 − 1)·YEAR/dt (WAD). Rounds down. */
export function vaultApyWad(p0: bigint, p1: bigint, dtSeconds: bigint): bigint | undefined {
  if (dtSeconds <= 0n || p0 <= 0n) return undefined;
  return divFloor((p1 - p0) * WAD * SECONDS_PER_YEAR, p0 * dtSeconds);
}

/** Vault share price (WAD) from convertToAssets(1e18) in AUSD 6 dp (coarse: 1 token unit resolution). */
export const sharePriceWadFromAssets = (assetsPerShareToken: bigint): bigint => assetsPerShareToken * AUSD_TO_WAD;

/** AUSD token (6 dp) → WAD, exact. */
export const tokenToWad = (token: bigint): bigint => token * AUSD_TO_WAD;
/** WAD → AUSD token (6 dp), rounds down (user receives less). */
export const wadToToken = (wad: bigint): bigint => divFloor(wad, AUSD_TO_WAD);
