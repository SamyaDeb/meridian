// The transactional numpad's text model (research M6): canonical text uses "." and at most 2 decimals (cents of AUSD);
// the screen shows the locale's separator. Amounts become AUSD WAD exactly (core parseFixed); presets round DOWN to the
// cent so a preset never asks for more than is available (CONTRIBUTING §2: amounts the user spends never round up).
import { parseFixed } from "@meridian/core/meridian";

export type NumpadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "back";
export const NUMPAD_KEYS: readonly NumpadKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"];

export const AMOUNT_DP = 2;
const MAX_WHOLE_DIGITS = 8;

export function pressKey(text: string, key: NumpadKey): string {
  if (key === "back") return text.slice(0, -1);
  if (key === ".") {
    if (text.includes(".")) return text;
    return text === "" ? "0." : `${text}.`;
  }
  const [whole = "", frac] = text.split(".");
  if (frac !== undefined) return frac.length >= AMOUNT_DP ? text : `${text}${key}`;
  if (whole === "0") return key; // no leading zeros
  if (whole.length >= MAX_WHOLE_DIGITS) return text;
  return `${text}${key}`;
}

/** The locale's decimal separator (Hermes ships Intl); "." when Intl can't tell. */
export function decimalSeparator(locale?: string): string {
  try {
    const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal");
    return part?.value ?? ".";
  } catch {
    return ".";
  }
}

/** Canonical text → what the screen shows: grouped whole part, locale separator. Empty ⇒ "0". */
export function displayAmount(text: string, sep: string): string {
  if (text === "") return "0";
  const [whole = "0", frac] = text.split(".");
  const group = sep === "," ? "." : ",";
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return frac === undefined ? w : `${w}${sep}${frac}`;
}

/** Canonical text → AUSD WAD (exact). Not a positive amount ⇒ undefined. */
export function amountWadOf(text: string): bigint | undefined {
  if (text === "" || text === ".") return undefined;
  const v = parseFixed(text, 18);
  return v !== undefined && v > 0n ? v : undefined;
}

/** pct % of `availableWad` as canonical text, rounded down to the cent; nothing available ⇒ "". */
export function presetText(availableWad: bigint | undefined, pct: 25 | 50 | 100): string {
  if (availableWad === undefined || availableWad <= 0n) return "";
  const cents = (availableWad * BigInt(pct)) / 100n / 10n ** 16n; // rounds down
  if (cents <= 0n) return "";
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
