// The two passkey ceremonies (Mera 0.2.0, docs.monad.xyz/guides/mera/react-native.md). The PRF output returned here is
// key material: the caller owns it and must wipe it (derive.ts does). Only the credential metadata is ever stored.
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, type PasskeyCredentialMetadata, type WebAuthnClient } from "@category-labs/mera";

export type PasskeyDeps = { rpId: string; webAuthnClient: WebAuthnClient };
export type PrfHandle = { prf: Uint8Array; credential: PasskeyCredentialMetadata };

/** New discoverable passkey on `rpId` + its first PRF output (one prompt; two on authenticators without create-time PRF). */
export async function createPasskey(d: PasskeyDeps, displayName: string): Promise<PrfHandle> {
  const r = await createPasskeyWithPrfOutput({ rp: { id: d.rpId, name: "Meridian" }, user: { name: displayName, displayName }, webAuthnClient: d.webAuthnClient });
  return { prf: r.prfOutput, credential: { credentialId: r.credentialId, ...(r.transports ? { transports: [...r.transports] } : {}) } };
}

/** PRF from the stored passkey, or (no record) whichever Meridian passkey the user picks. */
export async function getPrf(d: PasskeyDeps, credential?: PasskeyCredentialMetadata): Promise<PrfHandle> {
  const r = await getPasskeyPrfOutput({ rpId: d.rpId, webAuthnClient: d.webAuthnClient, ...(credential ? { credential } : {}) });
  return { prf: r.prfOutput, credential: { credentialId: r.credentialId, ...(credential?.credentialId === r.credentialId && credential.transports ? { transports: [...credential.transports] } : {}) } };
}
