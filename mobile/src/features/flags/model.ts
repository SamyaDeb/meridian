// Remote flags (LAUNCH_PLAN §3.3): the /api/flags shape (app/src/lib/flags.ts, same v: 1 contract), the fail-safe policy
// and the one open gate every open entry point asks. Pure; tested in __tests__/flags.
//
// Fail-safe policy (also in mobile/README.md § Flags):
// - flags read now ⇒ use them;
// - unreachable / unknown (no web URL for this env, offline, bad body) ⇒ the last good value if it is under 24 h old;
// - otherwise allow everything; on production show a small "Can't check service status" line next to the open
//   buttons. Meridian is a demo on its own contracts, not a custodian: the contracts are the real guard, and a stuck
//   flags endpoint must not stop people trading. > VERIFY with the owner (N8-prep PR body).
// Closes, Close all, the Earn leftover close and resume-after-kill never ask the gate: a kill switch stops new risk only.
import type { AppEnv } from "../../config/appConfig";

export type Flags = { v: 1; writes: boolean; perpl: boolean; earn: boolean; lock: boolean; minAppVersion: string; message?: string };

export const DEFAULT_FLAGS: Flags = { v: 1, writes: true, perpl: true, earn: true, lock: true, minAppVersion: "0.0.0" };

/** How long a last good value stands in for an unreachable endpoint. */
export const STALE_MS = 24 * 60 * 60 * 1000;
export const POLL_MS = 60_000;

const SEMVER = /^\d+\.\d+\.\d+$/;
const MESSAGE_MAX = 200;

/** A /api/flags body → Flags, or undefined when it isn't one (then the policy treats the read as failed). */
export function parseFlags(body: unknown): Flags | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return undefined;
  for (const k of ["writes", "perpl", "earn", "lock"] as const) if (typeof b[k] !== "boolean") return undefined;
  if (typeof b.minAppVersion !== "string" || !SEMVER.test(b.minAppVersion)) return undefined;
  const f: Flags = { v: 1, writes: b.writes as boolean, perpl: b.perpl as boolean, earn: b.earn as boolean, lock: b.lock as boolean, minAppVersion: b.minAppVersion };
  if (typeof b.message === "string" && b.message.trim()) f.message = b.message.trim().slice(0, MESSAGE_MAX);
  return f;
}

/** a < b for plain x.y.z versions. Anything else (unknown app version, pre-release tags) ⇒ false: never lock anyone out on a parse. */
export function versionBelow(a: string | undefined, b: string): boolean {
  if (!a || !SEMVER.test(a) || !SEMVER.test(b)) return false;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]!;
  return false;
}

export type LastGood = { flags: Flags; atMs: number };
export type FlagsSource = "live" | "cached" | "default";

export type FlagsView = {
  flags: Flags;
  source: FlagsSource;
  /** when the flags in use were read (live / cached) */
  atMs: number | undefined;
  /** production with no usable flags: a small line next to the open buttons */
  statusLine: string | undefined;
  /** the app is older than minAppVersion: the update screen, closes only */
  updateRequired: boolean;
};

export const STATUS_UNKNOWN = "Can't check service status";

export function resolveFlags(i: { live: Flags | undefined; last: LastGood | undefined; nowMs: number; env: AppEnv; appVersion: string | undefined }): FlagsView {
  let flags: Flags;
  let source: FlagsSource;
  let atMs: number | undefined;
  if (i.live) {
    flags = i.live;
    source = "live";
    atMs = i.nowMs;
  } else if (i.last && i.nowMs - i.last.atMs < STALE_MS && i.nowMs >= i.last.atMs) {
    flags = i.last.flags;
    source = "cached";
    atMs = i.last.atMs;
  } else {
    flags = DEFAULT_FLAGS;
    source = "default";
    atMs = undefined;
  }
  return { flags, source, atMs, statusLine: source === "default" && i.env === "production" ? STATUS_UNKNOWN : undefined, updateRequired: versionBelow(i.appVersion, flags.minAppVersion) };
}

/** Until the first read: everything allowed, no status line yet. */
export const INITIAL_VIEW: FlagsView = { flags: DEFAULT_FLAGS, source: "default", atMs: undefined, statusLine: undefined, updateRequired: false };

/** Every open entry point: Trade ticket (non-reduce-only) per venue, Earn open, Lock-on, Perpl setup. */
export type OpenKind = "trade-meridian" | "trade-perpl" | "earn" | "lock" | "perpl-setup";

export const PAUSED_TEXT = "Trading is paused for maintenance. You can still close positions.";
export const UPDATE_TEXT = "Update Meridian to open new trades. You can still close positions.";
const PERPL_TEXT = "Perpl is paused for now. You can still close positions.";
const EARN_TEXT = "Earn is paused for now. You can still close positions.";
const LOCK_TEXT = "Fixed-rate locks are paused for now. Earn still opens at the floating rate.";

/** Why an open of `kind` is refused, or undefined. Closes never call this. */
export function opensBlocked(kind: OpenKind, v: FlagsView): string | undefined {
  const f = v.flags;
  if (v.updateRequired) return UPDATE_TEXT;
  if (!f.writes) return f.message ?? PAUSED_TEXT;
  // Earn opens a Perpl leg too
  if ((kind === "trade-perpl" || kind === "perpl-setup" || kind === "earn") && !f.perpl) return f.message ?? PERPL_TEXT;
  if (kind === "earn" && !f.earn) return f.message ?? EARN_TEXT;
  if (kind === "lock" && (!f.lock || !f.earn || !f.perpl)) return f.message ?? LOCK_TEXT;
  return undefined;
}
