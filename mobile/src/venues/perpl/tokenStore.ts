// The Perpl API-key record (core README §Open item 3): the X-API-Key token is NOT re-derivable and re-enrolling the same
// public key returns 409, so the app stores `{ token, rotation, publicKeyHex, chainId, address, enrolledAt }` in
// SecureStore, one record per (chain, wallet). The token is a bearer identifier that is useless without the Ed25519
// secret (which is never stored); it still stays out of logs. Validated field by field on the way in and out (same
// discipline as auth/credentialStore.ts) so nothing else can ride into SecureStore through it.
import { getAddress, isAddress, type Address } from "viem";
import type { KV } from "../../auth/credentialStore";

export type PerplKeyRecord = {
  /** opaque X-API-Key token from POST /v1/api-key/enroll */
  token: string;
  /** derivePerplKey rotation that produced the enrolled key */
  rotation: number;
  /** 64 hex chars, no 0x: the enrolled public key (public) */
  publicKeyHex: string;
  chainId: number;
  address: Address;
  /** ms since epoch */
  enrolledAt: number;
};

const FIELDS = ["token", "rotation", "publicKeyHex", "chainId", "address", "enrolledAt"];
/** K3's testnet token: 64 chars of [A-Za-z0-9_-]; allow the unreserved URL set, bounded. */
const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
/** derivePerplKey accepts any non-hardened index; the app never needs more than Perpl's 16 active keys per profile, ×4 */
export const MAX_ROTATION = 64;

export function checkPerplRecord(r: unknown): PerplKeyRecord {
  if (typeof r !== "object" || r === null) throw new Error("perpl key record: not an object");
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) throw new Error(`perpl key record: unexpected field ${k}`);
  if (typeof o.token !== "string" || !TOKEN.test(o.token)) throw new Error("perpl key record: bad token");
  if (typeof o.rotation !== "number" || !Number.isSafeInteger(o.rotation) || o.rotation < 0 || o.rotation > MAX_ROTATION) throw new Error("perpl key record: bad rotation");
  if (typeof o.publicKeyHex !== "string" || !PUBKEY.test(o.publicKeyHex)) throw new Error("perpl key record: bad publicKeyHex");
  if (o.chainId !== 143 && o.chainId !== 10143) throw new Error("perpl key record: bad chainId");
  if (typeof o.address !== "string" || !isAddress(o.address, { strict: false })) throw new Error("perpl key record: bad address");
  if (typeof o.enrolledAt !== "number" || !Number.isSafeInteger(o.enrolledAt) || o.enrolledAt <= 0) throw new Error("perpl key record: bad enrolledAt");
  return { token: o.token, rotation: o.rotation, publicKeyHex: o.publicKeyHex, chainId: o.chainId, address: getAddress(o.address), enrolledAt: o.enrolledAt };
}

export class PerplTokenStore {
  constructor(private kv: KV) {}

  /** SecureStore keys allow [A-Za-z0-9._-]. */
  key(chainId: number, address: Address): string {
    return `meridian.perpl.v1.${chainId}.${address.toLowerCase()}`;
  }

  async read(chainId: number, address: Address): Promise<PerplKeyRecord | undefined> {
    const k = this.key(chainId, address);
    const raw = await this.kv.get(k);
    if (raw === null) return undefined;
    try {
      const r = checkPerplRecord(JSON.parse(raw));
      if (r.chainId !== chainId || r.address !== getAddress(address)) throw new Error("perpl key record: wrong wallet");
      return r;
    } catch {
      // unreadable: forget it; the key it named is lost, the next enrolment uses rotation + 1 after a 409
      await this.kv.del(k);
      return undefined;
    }
  }

  async write(r: PerplKeyRecord): Promise<void> {
    const v = checkPerplRecord(r);
    await this.kv.set(this.key(v.chainId, v.address), JSON.stringify(v));
  }

  async clear(chainId: number, address: Address): Promise<void> {
    await this.kv.del(this.key(chainId, address));
  }
}
