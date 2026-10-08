// The Perpl Ed25519 API key for one unlocked session (MOBILE_PLAN N4 hard rule: key material in memory only). Derived
// from the passkey PRF with core `derivePerplKey(prf, chainId, rotation)` in the same PRF pass as the EVM key, held in a
// closure, reachable only as a core `PerplSigner` (signs bytes, shows its public key), zeroed by `wipe()` on lock,
// sign-out and background lock. Never in React state, SecureStore, logs or nav params.
import { derivePerplKey } from "@meridian/core/keys";
import { toSigner, type PerplSigner } from "@meridian/core/perpl";
import { bytesToHex } from "@meridian/core/util";

export class PerplKeyWipedError extends Error {
  constructor() {
    super("The trading key was cleared (the wallet locked). Unlock to continue.");
    this.name = "PerplKeyWipedError";
  }
}

export type PerplKeyring = {
  readonly chainId: number;
  readonly rotation: number;
  /** 0x-less hex of the 32-byte public key (public: it is what Perpl stores) */
  readonly publicKeyHex: string;
  readonly alive: boolean;
  /** the signing capability; throws PerplKeyWipedError after wipe() */
  signer(): PerplSigner;
  wipe(): void;
};

/** Takes the PRF by reference and does not keep it (the caller zeroes it); the derived secret lives only in here. */
export function createPerplKeyring(prf: Uint8Array, chainId: number, rotation: number, derive = derivePerplKey): PerplKeyring {
  const k = derive(prf, chainId, rotation);
  let secret: Uint8Array | undefined = k.secret;
  const publicKey = Uint8Array.from(k.publicKey);
  const publicKeyHex = bytesToHex(publicKey);
  const signer: PerplSigner = Object.freeze({
    publicKey,
    sign: (m: Uint8Array) => {
      if (!secret) throw new PerplKeyWipedError();
      return signWith(secret, m);
    },
  });
  return {
    chainId,
    rotation,
    publicKeyHex,
    get alive() {
      return secret !== undefined;
    },
    signer() {
      if (!secret) throw new PerplKeyWipedError();
      return signer;
    },
    wipe() {
      secret?.fill(0);
      secret = undefined;
    },
  };
}

/** core's Ed25519 over the raw secret (noble sync API), built per call so no wrapper object holds the bytes */
const signWith = (secret: Uint8Array, m: Uint8Array): Uint8Array => toSigner(secret).sign(m);
