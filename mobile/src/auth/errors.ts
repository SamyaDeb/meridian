// Every passkey / session failure → one plain-language line (MOBILE_PLAN N3 §5). Codes come from the installed typings:
// MeraErrorCode (@category-labs/mera 0.2.0 dist/errors.d.ts); for PASSKEY_OPERATION_FAILED, Mera keeps the native
// error as `cause`, which react-native-passkey 3.6.1 shapes as { error, message } (lib/typescript/PasskeyError.d.ts).
import { isMeraError } from "@category-labs/mera";

export type AuthErrorKind =
  | "prf-unavailable"
  | "domain"
  | "cancelled"
  | "no-passkey"
  | "no-provider"
  | "timeout"
  | "not-supported"
  | "session-ended"
  | "crypto"
  | "wrong-passkey"
  | "rp-guard"
  | "unknown";

export type AuthError = { kind: AuthErrorKind; message: string };

/** The passkey that answered isn't this wallet's (a fresh prompt picked another one). */
export class WrongPasskeyError extends Error {
  constructor() {
    super("That passkey belongs to a different wallet. Use the passkey you unlocked Meridian with.");
    this.name = "WrongPasskeyError";
  }
}

export class RpGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpGuardError";
  }
}

export const MESSAGES = {
  prfUnavailable: "This phone's passkey provider can't create a wallet. Use Google Password Manager (Android 9+) and try again.",
  domain: "Couldn't verify Meridian's passkey domain. Check your connection and try again.",
  cancelled: "Cancelled. Try again.",
  noPasskey: "No Meridian passkey found. Create one, or sign in to the Google account that holds it.",
  noProvider: "No passkey provider on this phone. Sign in to a Google account (Google Password Manager) and try again.",
  timeout: "The fingerprint prompt timed out. Try again.",
  notSupported: "Passkeys need Android 9 or newer with Google Play services.",
  crypto: "This phone is missing a security feature Meridian needs. Update the app and try again.",
  unknown: "Couldn't use your passkey. Try again.",
} as const;

type NativeCause = { error: string; message: string };
const nativeCause = (c: unknown): NativeCause | undefined =>
  typeof c === "object" && c !== null && typeof (c as NativeCause).error === "string" ? { error: (c as NativeCause).error, message: String((c as NativeCause).message ?? "") } : undefined;

export type AuthErrorContext = {
  /** no passkey call has succeeded since launch: a generic failure most likely means assetlinks */
  firstPasskeyCall: boolean;
  rpId: string;
  androidPackage: string;
};

export function describeAuthError(e: unknown, ctx: AuthErrorContext): AuthError {
  if (e instanceof WrongPasskeyError) return { kind: "wrong-passkey", message: e.message };
  if (e instanceof RpGuardError) return { kind: "rp-guard", message: e.message };
  if (!isMeraError(e)) return { kind: "unknown", message: MESSAGES.unknown };
  switch (e.code) {
    case "PRF_UNAVAILABLE":
      return { kind: "prf-unavailable", message: MESSAGES.prfUnavailable };
    case "SESSION_ENDED":
      return { kind: "session-ended", message: "" };
    case "CRYPTO_UNAVAILABLE":
      return { kind: "crypto", message: MESSAGES.crypto };
    case "PASSKEY_OPERATION_FAILED": {
      const n = nativeCause(e.cause);
      if (n?.error === "UserCancelled") return { kind: "cancelled", message: MESSAGES.cancelled };
      if (n?.error === "NoCredentials") return { kind: "no-passkey", message: MESSAGES.noPasskey };
      if (n?.error === "NoCreateOption") return { kind: "no-provider", message: MESSAGES.noProvider };
      if (n?.error === "TimedOut") return { kind: "timeout", message: MESSAGES.timeout };
      if (n?.error === "NotSupported") return { kind: "not-supported", message: MESSAGES.notSupported };
      const domainLike = n?.error === "BadConfiguration" || /rp ?id|asset ?links|digital asset|cannot be validated/i.test(n?.message ?? "");
      if (domainLike || ctx.firstPasskeyCall) {
        if (__DEV__)
          console.warn(
            `[meridian/auth] passkey domain check failed: rpId=${ctx.rpId} package=${ctx.androidPackage} native=${n?.error ?? "?"}: ${n?.message ?? ""}. ` +
              `Check: curl -sI https://${ctx.rpId}/.well-known/assetlinks.json (200, application/json, no redirect, this package + signing SHA-256).`,
          );
        return { kind: "domain", message: MESSAGES.domain };
      }
      return { kind: "unknown", message: MESSAGES.unknown };
    }
    default:
      return { kind: "unknown", message: MESSAGES.unknown };
  }
}
