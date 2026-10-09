// The only thing the app persists about the wallet: which passkey to ask for, and a public address hint for
// "Welcome back 0x12…ab". Never key material (MOBILE_PLAN §0.4 rule 8): the record is validated field by field on the
// way in and out, so nothing else can be smuggled into SecureStore through it.
import { getAddress, isAddress, type Address } from "viem";

export type CredentialRecord = {
  /** canonical unpadded base64url (Mera PasskeyCredentialMetadata) */
  credentialId: string;
  transports?: string[];
  /** ms since epoch */
  createdAt: number;
  /** public address of index 0: shown before unlock, never trusted for signing */
  addressHint: Address;
};

/** Async key-value store (SecureStore in the app, a map in tests). */
export type KV = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
};

const B64URL = /^[A-Za-z0-9_-]{16,1400}$/;
const TRANSPORT = /^[a-z-]{1,20}$/;

/** Throws unless `r` is exactly a credential record (no extra fields). */
export function checkRecord(r: unknown): CredentialRecord {
  if (typeof r !== "object" || r === null) throw new Error("credential record: not an object");
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["credentialId", "transports", "createdAt", "addressHint"].includes(k)) throw new Error(`credential record: unexpected field ${k}`);
  if (typeof o.credentialId !== "string" || !B64URL.test(o.credentialId)) throw new Error("credential record: bad credentialId");
  if (o.transports !== undefined && (!Array.isArray(o.transports) || o.transports.length > 8 || !o.transports.every((t) => typeof t === "string" && TRANSPORT.test(t))))
    throw new Error("credential record: bad transports");
  if (typeof o.createdAt !== "number" || !Number.isSafeInteger(o.createdAt) || o.createdAt <= 0) throw new Error("credential record: bad createdAt");
  if (typeof o.addressHint !== "string" || !isAddress(o.addressHint, { strict: false })) throw new Error("credential record: bad addressHint");
  return {
    credentialId: o.credentialId,
    ...(o.transports !== undefined ? { transports: [...(o.transports as string[])] } : {}),
    createdAt: o.createdAt,
    addressHint: getAddress(o.addressHint),
  };
}

export class CredentialStore {
  /** SecureStore keys allow [A-Za-z0-9._-]; one record per passkey domain. */
  readonly key: string;
  constructor(
    private kv: KV,
    rpId: string,
  ) {
    this.key = `meridian.passkey.v1.${rpId}`;
  }

  async read(): Promise<CredentialRecord | undefined> {
    const raw = await this.kv.get(this.key);
    if (raw === null) return undefined;
    try {
      return checkRecord(JSON.parse(raw));
    } catch {
      // unreadable record: forget it (the passkey still exists; "Use an existing passkey" finds it)
      await this.kv.del(this.key);
      return undefined;
    }
  }

  async write(r: CredentialRecord): Promise<void> {
    await this.kv.set(this.key, JSON.stringify(checkRecord(r)));
  }

  async clear(): Promise<void> {
    await this.kv.del(this.key);
  }
}
