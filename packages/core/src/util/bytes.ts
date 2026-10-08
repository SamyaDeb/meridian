// Byte helpers without Buffer / btoa (Hermes-safe): hex and base64url (RFC 4648 §5, no padding).
import { utf8ToBytes as nobleUtf8 } from "@noble/hashes/utils";

const HEX = "0123456789abcdef";

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += HEX[x >> 4]! + HEX[x & 15]!;
  return s;
}

/** Lower/upper-case hex, optional 0x; throws on odd length or a non-hex character. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("hexToBytes: expected an even-length hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding (Perpl signatures and nonces, authentication.md). */
export function base64UrlEncode(b: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    s += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i]! << 16;
    s += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    s += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return s;
}

/** Inverse of base64UrlEncode; accepts optional "=" padding; throws on any other character or a bad length. */
export function base64UrlDecode(s: string): Uint8Array {
  const t = s.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(t) || t.length % 4 === 1) throw new Error("base64UrlDecode: not base64url");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of t) {
    acc = (acc << 6) | B64URL.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export const utf8ToBytes = (s: string): Uint8Array => nobleUtf8(s);

/** Overwrites a buffer holding key material (best effort; JS gives no hard guarantee). */
export function wipe(b: Uint8Array): void {
  b.fill(0);
}
