// Perpl API-key authentication (pure; no network). Source: api-docs authentication.md (7 Oct 2026).
// REST: sign `chain_id\nMETHOD\nrequest-target\ntimestamp_ms\nnonce\nsha256(body) hex` → X-API-Signature.
// Trading WS: first frame mt: 29 ApiKeySignIn signing `chain_id\ntrading-ws-signin\ntimestamp_ms\nnonce`.
// Signature = base64url (no padding) of the Ed25519 signature; the docs' TS examples use @noble/ed25519, as we do.
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";

/** `PERPL_API_KEY_SECRET`: hex of the 32-byte Ed25519 private key, optional 0x (authentication.md "Creating a key"). */
export function parseSecret(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("PERPL_API_KEY_SECRET must be the 32-byte Ed25519 private key as 64 hex chars");
  return Uint8Array.from(Buffer.from(h, "hex"));
}

export const sha256Hex = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");

export type RestSigningInput = { chainId: number; method: string; target: string; timestampMs: number; nonce: string; body: string };

/** authentication.md "Authenticating REST requests": six fields joined by \n. `target` = path + query exactly as sent. */
export function restCanonical(i: RestSigningInput): string {
  if (!i.target.startsWith("/")) throw new Error("request-target must start with / (path + query, without the /api base)");
  return [String(i.chainId), i.method.toUpperCase(), i.target, String(i.timestampMs), i.nonce, sha256Hex(i.body)].join("\n");
}

/** authentication.md "WebSocket authentication": four fields joined by \n, literal action tag. */
export function wsSignInCanonical(i: { chainId: number; timestampMs: number; nonce: string }): string {
  return [String(i.chainId), "trading-ws-signin", String(i.timestampMs), i.nonce].join("\n");
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url"); // Node's base64url has no padding

/** Fresh client nonce: 16 random bytes, base64url (authentication.md: single-use within the 30 s window). */
export function newNonce(random: (n: number) => Uint8Array): string {
  return b64url(random(16));
}

export async function signCanonical(canonical: string, secret: Uint8Array): Promise<string> {
  return b64url(await ed.signAsync(new TextEncoder().encode(canonical), secret));
}

export async function publicKeyHex(secret: Uint8Array): Promise<string> {
  return Buffer.from(await ed.getPublicKeyAsync(secret)).toString("hex");
}

export type ApiHeaders = { "X-API-Key": string; "X-API-Timestamp": string; "X-API-Nonce": string; "X-API-Signature": string };

export async function restHeaders(apiKey: string, secret: Uint8Array, i: RestSigningInput): Promise<ApiHeaders> {
  return { "X-API-Key": apiKey, "X-API-Timestamp": String(i.timestampMs), "X-API-Nonce": i.nonce, "X-API-Signature": await signCanonical(restCanonical(i), secret) };
}

/** types.md "ApiKeySignInRequest" (mt: 29). `timestamp` is a decimal string. */
export type SignInFrame = { mt: 29; chain_id: number; api_key: string; timestamp: string; nonce: string; signature: string };

export async function signInFrame(apiKey: string, secret: Uint8Array, i: { chainId: number; timestampMs: number; nonce: string }): Promise<SignInFrame> {
  return { mt: 29, chain_id: i.chainId, api_key: apiKey, timestamp: String(i.timestampMs), nonce: i.nonce, signature: await signCanonical(wsSignInCanonical(i), secret) };
}

/** Never log X-API-* values or the sign-in frame's key/signature (K3 guardrail). */
export function redact<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => redact(x)) as T;
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = /^x-api-/i.test(k) || k === "api_key" || k === "signature" || /secret|private/i.test(k) ? "[redacted]" : redact(x);
  return out as T;
}
