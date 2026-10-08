// Runtime capabilities core depends on, as injected interfaces (no DOM lib, no Node built-ins). React Native's global
// fetch / WebSocket / setTimeout satisfy them on Hermes; tests pass fakes.

/** The fetch subset core uses (WHATWG fetch: RN, browsers, Node ≥ 18). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignalLike },
) => Promise<{ status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", fn: () => void): void;
}

/** The WHATWG WebSocket subset core uses (RN WebSocket, browser, Node 22 global, or a fake in tests). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

/** Time and timers, injected so tests are deterministic. */
export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void; random(): number };

declare const setTimeout: (fn: () => void, ms: number) => unknown;
declare const clearTimeout: (h: unknown) => void;

/** Host timers (RN / browser / Node all provide these globals). */
export const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h), random: Math.random };

/** Secure random bytes, injected; the app's default is noble's randomBytes over crypto.getRandomValues (expo-crypto polyfill). */
export type RandomBytes = (n: number) => Uint8Array;
