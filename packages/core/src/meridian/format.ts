// Display formatting: exact bigint → string, no float rounding on money. Ported from app/src/lib/format.ts (main @ 0ba1664);
// the price tick is now a required argument (from OrderBook.tickSize(), never a constant).
import { WAD } from "../util/fixed";

const AUSD_DECIMALS = 6; // token boundary, CONTRIBUTING §2

const group = (int: string): string => int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Formats a fixed-point integer `value` with `decimals` to `dp` places, rounding toward zero
 * (display never overstates a balance). Adds thousands separators.
 */
export function formatFixed(value: bigint, decimals: number, dp: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const int = v / scale;
  let frac = (v % scale).toString().padStart(decimals, "0").slice(0, dp);
  if (dp > decimals) frac = frac.padEnd(dp, "0");
  const body = dp > 0 ? `${group(int.toString())}.${frac}` : group(int.toString());
  return neg && /[1-9]/.test(body) ? `-${body}` : body;
}

/** AUSD token amount (6 dp onchain) → "1,234.56". */
export const formatAusdToken = (token: bigint): string => formatFixed(token, AUSD_DECIMALS, 2);
/** Protocol-internal AUSD (WAD) → "1,234.56". */
export const formatAusdWad = (wad: bigint): string => formatFixed(wad, 18, 2);
/** Signed AUSD WAD with an explicit sign: "+12.34" / "-0.50". */
export const formatSignedAusdWad = (wad: bigint): string => (wad > 0n ? "+" : "") + formatAusdWad(wad);
/** Base size WAD (MON) → "1,000.00". */
export const formatBaseWad = (wad: bigint, dp = 2): string => formatFixed(wad, 18, dp);

/** Price WAD at the market's tick precision (MON-PERP tick 1e-6 ⇒ 6 dp). */
export function formatPriceWad(priceWad: bigint, tickSizeWad: bigint): string {
  let dp = 0;
  for (let t = tickSizeWad; t < WAD; t *= 10n) dp++;
  return formatFixed(priceWad, 18, dp);
}

/** APR WAD (0.1095e18 = 10.95%) → "10.95%". */
export const formatAprWad = (aprWad: bigint, dp = 2): string => `${formatFixed(aprWad * 100n, 18, dp)}%`;
/** Signed APR with explicit sign, for funding tickers. */
export const formatSignedAprWad = (aprWad: bigint, dp = 2): string => (aprWad > 0n ? "+" : "") + formatAprWad(aprWad, dp);

/** Leverage WAD → "3.2x". */
export const formatLeverageWad = (levWad: bigint): string => `${formatFixed(levWad, 18, 1)}x`;

/** Short address "0x1234…abcd". */
export const shortAddress = (a: string): string => (a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Seconds → "29d 4h" / "3h 12m" / "45s". */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Parses a decimal user input ("12.5") into fixed-point, truncating extra decimals. Undefined if invalid. */
export function parseFixed(input: string, decimals: number): bigint | undefined {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return undefined;
  const [int = "0", frac = ""] = s.split(".");
  return BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || "0").padEnd(decimals, "0"));
}
