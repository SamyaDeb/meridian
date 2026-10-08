// Shared by the storage scans (N3 auth, N4 Perpl): what a leaked key looks like in a stored string.
import { wordlist } from "@scure/bip39/wordlists/english";

const WORDS = new Set(wordlist);
/** true if `s` contains a long hex run (≥ 32 bytes) or a run of ≥ 12 BIP-39 words */
export function looksSecret(s: string): boolean {
  if (/(0x)?[0-9a-fA-F]{64}/.test(s)) return true;
  const tokens = s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let run = 0;
  for (const t of tokens) {
    run = WORDS.has(t) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}
