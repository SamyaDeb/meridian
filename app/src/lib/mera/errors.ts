// Every passkey / session failure → one plain line (mera-passkeys §6). Codes: MeraErrorCode in @category-labs/mera
// 0.2.0 dist/errors.d.ts. In the browser, PASSKEY_OPERATION_FAILED keeps the WebAuthn DOMException as `cause`
// (NotAllowedError = cancelled or timed out, SecurityError = the rpId doesn't fit this page's host).
import { isMeraError } from "@category-labs/mera";

export type PasskeyErrorKind = "prf-unavailable" | "cancelled" | "domain" | "unsupported" | "session-ended" | "crypto" | "wrong-passkey" | "unknown";

/** The passkey that answered isn't this wallet's (the prompt let the user pick another one). */
export class WrongPasskeyError extends Error {
  constructor() {
    super("That passkey belongs to a different wallet. Use the passkey this wallet was unlocked with.");
    this.name = "WrongPasskeyError";
  }
}

export const PASSKEY_MESSAGES = {
  prfUnavailable: "This browser can't open a passkey wallet. Use Safari on iOS 18.4+ or Chrome with Google Password Manager, or continue with email.",
  cancelled: "Passkey cancelled. Try again.",
  domain: "This page can't use Meridian's passkeys. Open the official Meridian site.",
  unsupported: "This browser doesn't support passkeys. Use a recent Safari or Chrome, or continue with email.",
  crypto: "This browser is missing a security feature Meridian needs. Update it and try again.",
  unknown: "Couldn't use your passkey. Try again.",
} as const;

const domName = (c: unknown): string | undefined => (typeof c === "object" && c !== null && typeof (c as { name?: unknown }).name === "string" ? (c as { name: string }).name : undefined);

export function describePasskeyError(e: unknown): { kind: PasskeyErrorKind; message: string } {
  if (e instanceof WrongPasskeyError) return { kind: "wrong-passkey", message: e.message };
  if (!isMeraError(e)) return { kind: "unknown", message: PASSKEY_MESSAGES.unknown };
  switch (e.code) {
    case "PRF_UNAVAILABLE":
      return { kind: "prf-unavailable", message: PASSKEY_MESSAGES.prfUnavailable };
    case "SESSION_ENDED":
      return { kind: "session-ended", message: "" };
    case "CRYPTO_UNAVAILABLE":
      return { kind: "crypto", message: PASSKEY_MESSAGES.crypto };
    case "PASSKEY_OPERATION_FAILED": {
      const n = domName(e.cause);
      if (n === "NotAllowedError" || n === "AbortError") return { kind: "cancelled", message: PASSKEY_MESSAGES.cancelled };
      if (n === "SecurityError") return { kind: "domain", message: PASSKEY_MESSAGES.domain };
      if (n === "NotSupportedError" || typeof globalThis.PublicKeyCredential === "undefined") return { kind: "unsupported", message: PASSKEY_MESSAGES.unsupported };
      return { kind: "unknown", message: PASSKEY_MESSAGES.unknown };
    }
    default:
      return { kind: "unknown", message: PASSKEY_MESSAGES.unknown };
  }
}
