// The only thing the web app keeps about a passkey wallet: which passkey to ask for, and the public address for
// "Unlock 0x12…ab". Never key material (mera-passkeys §5): the record is checked field by field on the way in and out,
// so nothing else can ride along into localStorage. Same shape as the native app's (mobile/src/auth/credentialStore.ts).
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

/** Sync key-value store (localStorage in the browser, a map in tests). */
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export const RECORD_KEY = "meridian.passkey.v1";

const B64URL = /^[A-Za-z0-9_-]{16,1400}$/;
const TRANSPORT = /^[a-z-]{1,20}$/;
const FIELDS = ["credentialId", "transports", "createdAt", "addressHint"];

/** Throws unless `r` is exactly a credential record (no extra fields). */
export function checkRecord(r: unknown): CredentialRecord {
  if (typeof r !== "object" || r === null) throw new Error("credential record: not an object");
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) throw new Error(`credential record: unexpected field ${k}`);
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

/** Storage can throw (private mode, blocked site data) or hold junk: both read as "no record". */
export function readRecord(kv: KV | undefined): CredentialRecord | undefined {
  try {
    const raw = kv?.getItem(RECORD_KEY);
    return raw ? checkRecord(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

/** Best effort: without storage the wallet still works, it just asks "which passkey?" next time. */
export function writeRecord(kv: KV | undefined, r: CredentialRecord): void {
  try {
    kv?.setItem(RECORD_KEY, JSON.stringify(checkRecord(r)));
  } catch {
    /* storage unavailable */
  }
}

export function clearRecord(kv: KV | undefined): void {
  try {
    kv?.removeItem(RECORD_KEY);
  } catch {
    /* storage unavailable */
  }
}
