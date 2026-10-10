// PRF → EVM key (core deriveEvmKey: Mera's documented BIP-39/BIP-44 path, index 0) → Mera signing session → viem
// account. The session keeps its own copy of the key (Mera createSigningKey), so both the PRF and our key copy are
// zeroed before this returns, on success and on failure.
import { createSecp256k1SigningSession, type Secp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { deriveEvmKey } from "@meridian/core/keys";
import type { Address, LocalAccount } from "viem";

export type Signer = { session: Secp256k1SigningSession; account: LocalAccount; address: Address };

export type DeriveDeps = {
  deriveEvmKey: (prf: Uint8Array, index: number) => Uint8Array;
  createSession: (o: { privateKey: Uint8Array }) => Secp256k1SigningSession;
  toAccount: (s: Secp256k1SigningSession) => LocalAccount;
  now: () => number;
};

export const defaultDeriveDeps: DeriveDeps = {
  deriveEvmKey,
  createSession: createSecp256k1SigningSession,
  toAccount: (s) => toViemAccount(s),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

/** Takes ownership of `prf` (zeroed on return). `deriveMs` = PBKDF2 + BIP-32 time, for MOBILE_QA. */
export function openSigner(prf: Uint8Array, d: DeriveDeps = defaultDeriveDeps): Signer & { deriveMs: number } {
  let key: Uint8Array | undefined;
  try {
    const t0 = d.now();
    key = d.deriveEvmKey(prf, 0);
    const deriveMs = d.now() - t0;
    const session = d.createSession({ privateKey: key });
    try {
      const account = d.toAccount(session);
      return { session, account, address: account.address, deriveMs };
    } catch (e) {
      session.end();
      throw e;
    }
  } finally {
    key?.fill(0);
    prf.fill(0);
  }
}
