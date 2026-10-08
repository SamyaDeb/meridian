// @noble/ed25519 wired to @noble/hashes' SHA-512 so signing never touches crypto.subtle (absent on Hermes).
// noble's README: `ed.hashes.sha512 = sha512` enables the sync API (sign, getPublicKey).
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

// @noble/hashes 1.8 types its output as Uint8Array<ArrayBufferLike>; ed25519 3.x wants ArrayBuffer-backed. Same bytes.
ed.hashes.sha512 = (m) => Uint8Array.from(sha512(m)) as Uint8Array<ArrayBuffer> & Uint8Array;

export const edSign = (msg: Uint8Array, secret: Uint8Array): Uint8Array => ed.sign(msg, secret);
export const edPublicKey = (secret: Uint8Array): Uint8Array => ed.getPublicKey(secret);
export const edVerify = (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean => ed.verify(sig, msg, pub);
