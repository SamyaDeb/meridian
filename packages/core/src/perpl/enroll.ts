// Perpl API-key enrolment (api-docs @ 25ab6e2 integrations.md "Step 2: Request the enrollment payload" / "Step 3: Sign and
// enroll"). Ported from meridian-k3/mm-bot/scripts/perpl-enroll.ts (perpl-hedge @ fe873b0) as pure builders + a flow with
// the wallet signer and fetch injected (the app signs with the Mera passkey account; the Ed25519 secret comes from
// keys/derivePerplKey and never leaves memory).
//   1. POST /v1/api-key/payload {chain_id, address, public_key, scope_mask, label} → { typed_data, mac }
//   2. wallet EIP-712 signature over typed_data + Ed25519 proof-of-possession over the EIP-712 digest
//   3. POST /v1/api-key/enroll → api_key.api_key, the opaque X-API-Key token: store it, it is NOT re-derivable.
// Enroll status codes: 404 target profile, 409 public key already registered (revoked keys can't be re-enrolled),
// 423 max 16 active keys per profile. `Origin` must be whitelisted by Perpl (integrations.md "Origin whitelisting").
import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";
import { bytesToHex, hexToBytes } from "../util/bytes";
import type { FetchLike } from "../util/runtime";
import { toSigner, type PerplKeyRef } from "./auth";
import { PerplHttpError } from "./errors";
import { ScopeMask } from "./types";

export type PerplTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type ApiKeyInfo = { api_key: string; address: string; scope_mask: number; label: string; origin: string; created_at: number; expires_at?: number };

export function payloadRequest(o: { chainId: number; address: Address; secret: PerplKeyRef; label: string; scopeMask?: number }) {
  return { chain_id: o.chainId, address: o.address, public_key: `0x${bytesToHex(toSigner(o.secret).publicKey)}`, scope_mask: o.scopeMask ?? ScopeMask.All, label: o.label };
}

/**
 * Perpl serialises integers as strings ("0x279f", "0"): coerce every (u)intN field to bigint by its declared type, so the
 * EIP-712 hash is over the numbers, not the strings (K3 enrol, 7 Oct). EIP712Domain is dropped from `types` (viem
 * derives it from `domain`).
 */
export function toTypedDataDefinition(td: PerplTypedData): TypedDataDefinition {
  const { EIP712Domain: domainTypes, ...types } = td.types;
  const coerce = (fields: { name: string; type: string }[] | undefined, o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, /^u?int\d*$/.test(fields?.find((f) => f.name === k)?.type ?? "") && typeof v === "string" ? BigInt(v) : v]));
  return { domain: coerce(domainTypes, td.domain), types, primaryType: td.primaryType, message: coerce(types[td.primaryType], td.message) } as unknown as TypedDataDefinition;
}

/** Ed25519 proof-of-possession over keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message)), 0x-hex. */
export function popSignature(def: TypedDataDefinition, secret: PerplKeyRef): Hex {
  return `0x${bytesToHex(toSigner(secret).sign(hexToBytes(hashTypedData(def))))}`;
}

export type EnrollDeps = {
  apiUrl: string;
  chainId: number;
  address: Address;
  /** the Ed25519 key: raw secret or an in-memory signer (auth.ts PerplSigner) */
  secret: PerplKeyRef;
  label: string;
  /** the wallet's EIP-712 signer (Mera viem account `signTypedData`) */
  signTypedData: (def: TypedDataDefinition) => Promise<Hex>;
  fetchFn: FetchLike;
  /** a Perpl-whitelisted Origin. Native/server callers send none: measured 9 Oct, none ⇒ 200, a non-whitelisted one ⇒ 400 (README §Open) */
  origin?: string;
  scopeMask?: number;
};

export async function enrollApiKey(d: EnrollDeps): Promise<ApiKeyInfo> {
  const base = d.apiUrl.replace(/\/+$/, "");
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const r = await d.fetchFn(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(d.origin ? { origin: d.origin } : {}) }, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.status !== 200) throw new PerplHttpError(r.status, "POST", path, text);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const payload = await post("/v1/api-key/payload", payloadRequest(d.scopeMask !== undefined ? { ...d, scopeMask: d.scopeMask } : d));
  const td = payload.typed_data as PerplTypedData | undefined;
  if (!td || typeof payload.mac !== "string") throw new PerplHttpError(200, "POST", "/v1/api-key/payload", "missing typed_data / mac");
  const def = toTypedDataDefinition(td);
  const signature = await d.signTypedData(def);
  const res = await post("/v1/api-key/enroll", { chain_id: d.chainId, address: d.address, typed_data: td, mac: payload.mac, signature, pop_signature: popSignature(def, d.secret) });
  const info = res.api_key as ApiKeyInfo | undefined;
  if (!info || typeof info.api_key !== "string") throw new PerplHttpError(200, "POST", "/v1/api-key/enroll", "missing api_key");
  return info;
}
