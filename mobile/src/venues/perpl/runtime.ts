// React Native's globals as core's injected runtime (packages/core/src/util/runtime.ts). Native fetch / WebSocket are
// not subject to browser CORS and send no Origin of their own, so Perpl is called directly (MOBILE_PLAN §0.5).
import type { FetchLike, RandomBytes, WsFactory, WsLike } from "@meridian/core/util";

export const rnFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
export const rnWs: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;
/** crypto.getRandomValues comes from the expo-crypto polyfill (polyfills.ts, first import). */
export const rnRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
