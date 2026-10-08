// bigint fixed-point helpers (CONTRIBUTING.md §2). Every division names its direction; nothing rounds implicitly.
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n; // 365 d, MeridianConstants.SECONDS_PER_YEAR
export const SECONDS_PER_DAY = 86_400n;
export const AUSD_TO_WAD = 10n ** 12n; // AUSD is 6 dp on both chains (deployments/perpl.json collateralDecimals)

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);

function checkDen(b: bigint): void {
  if (b <= 0n) throw new RangeError("denominator must be positive");
}

/** a / b rounded toward −∞ (b > 0). */
export function divFloor(a: bigint, b: bigint): bigint {
  checkDen(b);
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** a / b rounded toward +∞ (b > 0). */
export function divCeil(a: bigint, b: bigint): bigint {
  checkDen(b);
  const q = a / b;
  return a % b !== 0n && a > 0n ? q + 1n : q;
}

/** a / b rounded toward zero (b > 0): "neutral" for reference values that nobody is paid from (docs/MFI.md §4.4). */
export function divTrunc(a: bigint, b: bigint): bigint {
  checkDen(b);
  return a / b;
}

export const pow10 = (n: number): bigint => {
  if (!Number.isInteger(n) || n < 0 || n > 36) throw new RangeError("bad decimals");
  return 10n ** BigInt(n);
};

/** Scaled integer with `decimals` (≤ 18) → WAD. Exact. */
export function scaledToWad(v: bigint, decimals: number): bigint {
  if (decimals > 18) throw new RangeError("decimals must be ≤ 18");
  return v * pow10(18 - decimals);
}
