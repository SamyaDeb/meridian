// Hermes globals the shared code needs, installed before any other import (index.ts).
// - crypto.getRandomValues: Hermes has none; viem / noble use it for randomness (nonces, Perpl request nonces, N3 keys).
// TextEncoder, atob/btoa and structuredClone get a polyfill only if the dev smoke screen (src/app/dev/smoke.tsx) shows
// one missing on the phone's Hermes (MOBILE_PLAN N2 §3: add only what is proven missing).
import { getRandomValues } from "expo-crypto";

type CryptoLike = { getRandomValues?: (a: Uint8Array) => Uint8Array };
const g = globalThis as { crypto?: CryptoLike };

if (typeof g.crypto?.getRandomValues !== "function") {
  const impl = <T extends Uint8Array>(a: T): T => getRandomValues(a);
  if (g.crypto) g.crypto.getRandomValues = impl;
  else g.crypto = { getRandomValues: impl };
}
