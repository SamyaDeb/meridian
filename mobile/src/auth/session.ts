// Pure auth state machine (MOBILE_PLAN N3 §3): LOADING → LOCKED → UNLOCKING(passkey → deriving) → UNLOCKED → LOCKED.
// No keys here: the UI state carries only the status and public addresses. Timers are pure predicates on ms values.
import type { Address } from "viem";

export type LockReason = "start" | "idle" | "background" | "manual" | "signout" | "failed";

export type AuthState =
  | { status: "loading" }
  | { status: "locked"; hasAccount: boolean; addressHint: Address | undefined; reason: LockReason }
  | { status: "unlocking"; hasAccount: boolean; addressHint: Address | undefined; step: "passkey" | "deriving" }
  | { status: "unlocked"; address: Address };

export type AuthEvent =
  | { type: "LOADED"; addressHint: Address | undefined }
  | { type: "UNLOCK_START" }
  | { type: "DERIVING" }
  | { type: "UNLOCK_OK"; address: Address }
  | { type: "UNLOCK_FAIL" }
  | { type: "LOCK"; reason: Exclude<LockReason, "start" | "failed" | "signout"> }
  | { type: "SIGNED_OUT" };

export const INITIAL: AuthState = { status: "loading" };

/** Invalid transitions return the same state object (callers can compare by reference). */
export function reduce(s: AuthState, e: AuthEvent): AuthState {
  switch (e.type) {
    case "LOADED":
      return s.status === "loading" ? { status: "locked", hasAccount: e.addressHint !== undefined, addressHint: e.addressHint, reason: "start" } : s;
    case "UNLOCK_START":
      return s.status === "locked" ? { status: "unlocking", hasAccount: s.hasAccount, addressHint: s.addressHint, step: "passkey" } : s;
    case "DERIVING":
      return s.status === "unlocking" && s.step === "passkey" ? { ...s, step: "deriving" } : s;
    case "UNLOCK_OK":
      return s.status === "unlocking" ? { status: "unlocked", address: e.address } : s;
    case "UNLOCK_FAIL":
      return s.status === "unlocking" ? { status: "locked", hasAccount: s.hasAccount, addressHint: s.addressHint, reason: "failed" } : s;
    case "LOCK":
      return s.status === "unlocked" ? { status: "locked", hasAccount: true, addressHint: s.address, reason: e.reason } : s;
    case "SIGNED_OUT":
      return s.status === "loading" ? s : { status: "locked", hasAccount: false, addressHint: undefined, reason: "signout" };
  }
}

/** MOBILE_PLAN N3: lock after 10 min without a touch, or after > 5 min in the background. */
export const IDLE_LOCK_MS = 10 * 60_000;
export const BACKGROUND_LOCK_MS = 5 * 60_000;
/** dev-only shortened timers for device QA row 4 (EXPO_PUBLIC_SHORT_LOCK=1 in a __DEV__ build) */
export const DEV_IDLE_LOCK_MS = 60_000;
export const DEV_BACKGROUND_LOCK_MS = 30_000;

export const idleExpired = (lastActivityMs: number, nowMs: number, idleMs: number): boolean => nowMs - lastActivityMs >= idleMs;
export const backgroundExpired = (backgroundedAtMs: number | undefined, nowMs: number, bgMs: number): boolean =>
  backgroundedAtMs !== undefined && nowMs - backgroundedAtMs > bgMs;
