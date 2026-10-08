// bigint fixed-point helpers (CONTRIBUTING.md §2). Every division names its direction; nothing rounds implicitly.
// Source: K5 risk/src/fixed.ts (branch rates-risk @ 1edb15f) + app/src/lib/math.ts divCeil/divFloor (main @ 0ba1664).
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n; // 365 d, MeridianConstants.SECONDS_PER_YEAR
export const SECONDS_PER_DAY = 86_400n;
export const BPS = 10_000n;

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);
export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

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

/** a / b rounded toward zero (b > 0): "neutral", for reference values nobody is paid from (docs/MFI.md §4.4). */
export function divTrunc(a: bigint, b: bigint): bigint {
  checkDen(b);
  return a / b;
}

/** a / b rounded in the named direction. */
export const divRound = (a: bigint, b: bigint, dir: "up" | "down"): bigint => (dir === "up" ? divCeil(a, b) : divFloor(a, b));

export const pow10 = (n: number): bigint => {
  if (!Number.isInteger(n) || n < 0 || n > 36) throw new RangeError("bad decimals");
  return 10n ** BigInt(n);
};

/** Scaled integer with `decimals` (≤ 18) → WAD. Exact. */
export function scaledToWad(v: bigint, decimals: number): bigint {
  if (decimals > 18) throw new RangeError("decimals must be ≤ 18");
  return v * pow10(18 - decimals);
}

/** WAD → scaled integer with `decimals` (≤ 18), rounded in the named direction. */
export function wadToScaled(wad: bigint, decimals: number, dir: "up" | "down"): bigint {
  if (decimals > 18) throw new RangeError("decimals must be ≤ 18");
  return divRound(wad, pow10(18 - decimals), dir);
}

/** "12.5" → 12.5 × 10^decimals, exact (no floats); rejects anything that isn't a plain non-negative decimal (K3 config.ts). */
export function parseDecimal(s: string, decimals: number, what = "value"): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`${what}: expected a non-negative decimal, got "${s}"`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`${what}: more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.slice(0, decimals) || "0");
}

/** Display only: WAD → float. Never use the result in a money path. */
export const wadToFloatForDisplay = (wad: bigint): number => Number(wad) / 1e18;
