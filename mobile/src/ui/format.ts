// Display formatting of bigint values (floats never touch money; core's formatFixed does the string work).
import { formatFixed } from "@meridian/core/meridian";

export type NumKind = "apr" | "price" | "usd" | "block" | "int";

const MINUS = "−";

/** Truncated toward zero at `dp` decimals with thousands separators (core formatFixed); a real minus sign, and none
 *  when the value truncates to zero (never "−0.00"). */
export function fmtWad(wad: bigint, dp: number): string {
  const s = formatFixed(wad < 0n ? -wad : wad, 18, dp);
  return wad < 0n && /[1-9]/.test(s) ? MINUS + s : s;
}

export type FormatOpts = { dp?: number; signed?: boolean };

/** One formatter for every on-screen number. `undefined` ⇒ "—" (unknown); zero stays "0.00". */
export function formatValue(value: bigint | undefined, kind: NumKind, o: FormatOpts = {}): string {
  if (value === undefined) return "—";
  let s: string;
  switch (kind) {
    case "apr":
      s = `${fmtWad(value * 100n, o.dp ?? 2)}%`;
      break;
    case "price":
      s = fmtWad(value, o.dp ?? 4);
      break;
    case "usd":
      s = fmtWad(value, o.dp ?? 2);
      break;
    case "block":
    case "int":
      s = value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      if (s.startsWith("-")) s = MINUS + s.slice(1);
      break;
  }
  if (o.signed && value > 0n) s = `+${s}`;
  return s;
}

/** Spoken form for screen readers (no grouping commas, "minus" spelled out). */
export function spokenValue(text: string): string {
  return text === "—" ? "unknown" : text.replace(/,/g, "").replace(MINUS, "minus ").replace(/^\+/, "plus ");
}

/** Decimals a price needs at this tick size (WAD): 0.001 ⇒ 3. Display only. */
export function dpOfTick(tickSizeWad: bigint | undefined, fallback = 4): number {
  if (tickSizeWad === undefined || tickSizeWad <= 0n) return fallback;
  let dp = 18;
  let t = tickSizeWad;
  while (dp > 0 && t % 10n === 0n) {
    t /= 10n;
    dp--;
  }
  return dp;
}
