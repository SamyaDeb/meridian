// Keys from one passkey PRF output (32 bytes). Pure: inputs and outputs are Uint8Array, no storage, no logging.
// EVM: exactly Mera's documented derivation (docs.monad.xyz/guides/mera, mera-passkeys skill §1):
//   seed = mnemonicToSeedSync(entropyToMnemonic(prf, wordlist)); pk = HDKey.fromMasterSeed(seed).derive(m/44'/60'/0'/0/i)
//   ⇒ the same address in MetaMask/Rabby from the exported phrase (recovery path).
// Perpl API key: HKDF-SHA256(ikm = prf, salt = "meridian/perpl-api-key/v1", info = String(chainId), L = 32) → Ed25519
//   secret (MOBILE_PLAN N1 / mera-passkeys §4). Never the EVM key bytes reused for another algorithm.
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { utf8ToBytes } from "../util/bytes";
import { edPublicKey } from "../perpl/ed";

export const PERPL_KEY_SALT = "meridian/perpl-api-key/v1";
export const EVM_PATH = (index: number) => `m/44'/60'/0'/0/${index}`;

function checkPrf(prf: Uint8Array): void {
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw new RangeError("PRF output must be 32 bytes");
}
function checkIndex(i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= 2 ** 31) throw new RangeError("index must be a non-hardened BIP-32 index (0 ≤ i < 2^31)");
}

/** The 24-word recovery phrase (BIP-39 English) of a PRF output: shown once on export, never stored. */
export function recoveryPhrase(prf: Uint8Array): string {
  checkPrf(prf);
  return entropyToMnemonic(prf, wordlist);
}

/** secp256k1 private key at m/44'/60'/0'/0/index (Mera docs). Note: PBKDF2-SHA512 × 2048 runs synchronously. */
export function deriveEvmKey(prf: Uint8Array, index = 0): Uint8Array {
  checkPrf(prf);
  checkIndex(index);
  const seed = mnemonicToSeedSync(entropyToMnemonic(prf, wordlist));
  try {
    const pk = HDKey.fromMasterSeed(seed).derive(EVM_PATH(index)).privateKey;
    if (!pk) throw new Error("bip32 derivation returned no private key");
    return Uint8Array.from(pk);
  } finally {
    seed.fill(0);
  }
}

export type PerplKey = { secret: Uint8Array; publicKey: Uint8Array };

/**
 * Ed25519 API key for Perpl on `chainId`. `rotation` > 0 appends "/<n>" to the info string to get a fresh key when the
 * previous one was revoked (integrations.md: a revoked public key can't be re-enrolled, 409); rotation 0 is exactly the
 * N1 spec (info = String(chainId)).
 */
export function derivePerplKey(prf: Uint8Array, chainId: number, rotation = 0): PerplKey {
  checkPrf(prf);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError("chainId must be a positive integer");
  checkIndex(rotation);
  const info = rotation === 0 ? String(chainId) : `${chainId}/${rotation}`;
  const secret = hkdf(sha256, prf, utf8ToBytes(PERPL_KEY_SALT), utf8ToBytes(info), 32);
  return { secret, publicKey: edPublicKey(secret) };
}
