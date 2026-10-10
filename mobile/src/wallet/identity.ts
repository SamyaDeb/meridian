// Wallet identity without hex (MOBILE_UX_RESEARCH §4 "Address", principle 4): a deterministic identicon + "Wallet ••a3f2".
// The full address appears only in the Add funds / copy sheet. Pure: the same address always draws the same picture,
// whatever its checksum casing.
import { keccak256, stringToBytes } from "viem";

/** "Wallet ••a3f2": the last four hex digits, lower case. */
export const walletLabel = (address: string): string => `Wallet ••${address.slice(-4).toLowerCase()}`;

/** Spoken form: "Wallet ending a 3 f 2" (TalkBack reads each character). */
export const walletSpoken = (address: string): string => `Wallet ending ${address.slice(-4).toLowerCase().split("").join(" ")}`;

export const IDENTICON_SIZE = 5;

export type Identicon = {
  /** row-major IDENTICON_SIZE × IDENTICON_SIZE, mirrored left ↔ right */
  cells: boolean[];
  /** foreground colour, #rrggbb */
  color: string;
};

const hex2 = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");

/** HSL (h 0–360, s/l 0–1) → #rrggbb */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${hex2(r + m)}${hex2(g + m)}${hex2(b + m)}`;
}

export function identicon(address: string): Identicon {
  const h = keccak256(stringToBytes(address.toLowerCase()), "bytes");
  const half = Math.ceil(IDENTICON_SIZE / 2); // 3 columns drawn, 2 mirrored
  const cells: boolean[] = [];
  for (let row = 0; row < IDENTICON_SIZE; row++) {
    const left: boolean[] = [];
    for (let col = 0; col < half; col++) left.push((h[row * half + col]! & 1) === 1);
    cells.push(...left, ...left.slice(0, IDENTICON_SIZE - half).reverse());
  }
  // never blank: light the centre when no bit is set
  if (!cells.some(Boolean)) cells[Math.floor((IDENTICON_SIZE * IDENTICON_SIZE) / 2)] = true;
  const hue = ((h[30]! << 8) | h[31]!) % 360;
  // light enough for ≥ 4.5:1 on the card colour, saturated enough to tell wallets apart
  return { cells, color: hslToHex(hue, 0.6, 0.66) };
}
