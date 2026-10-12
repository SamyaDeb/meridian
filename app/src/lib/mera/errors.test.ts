import { describe, expect, it } from "vitest";
import { MeraError } from "@category-labs/mera";
import { describePasskeyError, PASSKEY_MESSAGES, WrongPasskeyError } from "./errors";

const failed = (name: string) => new MeraError("PASSKEY_OPERATION_FAILED", "x", { cause: Object.assign(new Error("dom"), { name }) });

describe("describePasskeyError", () => {
  it("maps Mera codes and WebAuthn DOMException names to one plain line", () => {
    expect(describePasskeyError(new MeraError("PRF_UNAVAILABLE", "x")).message).toBe(PASSKEY_MESSAGES.prfUnavailable);
    expect(describePasskeyError(failed("NotAllowedError")).kind).toBe("cancelled");
    expect(describePasskeyError(failed("AbortError")).kind).toBe("cancelled");
    expect(describePasskeyError(failed("SecurityError")).message).toBe(PASSKEY_MESSAGES.domain);
    expect(describePasskeyError(failed("NotSupportedError")).kind).toBe("unsupported");
    expect(describePasskeyError(new MeraError("CRYPTO_UNAVAILABLE", "x")).kind).toBe("crypto");
    expect(describePasskeyError(new MeraError("SESSION_ENDED", "x"))).toEqual({ kind: "session-ended", message: "" });
    expect(describePasskeyError(new WrongPasskeyError()).kind).toBe("wrong-passkey");
    expect(describePasskeyError(new Error("boom")).message).toBe(PASSKEY_MESSAGES.unknown);
  });
});
