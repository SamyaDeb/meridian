import { MeraError } from "@category-labs/mera";
import { describeAuthError, MESSAGES, RpGuardError, WrongPasskeyError } from "../../auth/errors";

const ctx = { firstPasskeyCall: false, rpId: "meridian-testnet.vercel.app", androidPackage: "xyz.meridianfi.app.staging" };
const op = (error: string, message = "") => new MeraError("PASSKEY_OPERATION_FAILED", "Passkey assertion failed", { cause: { error, message } });

describe("error → plain language", () => {
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [new MeraError("PRF_UNAVAILABLE", "x"), "prf-unavailable", MESSAGES.prfUnavailable],
    [new MeraError("CRYPTO_UNAVAILABLE", "x"), "crypto", MESSAGES.crypto],
    [new MeraError("SESSION_ENDED", "x"), "session-ended", ""],
    [op("UserCancelled"), "cancelled", "Cancelled. Try again."],
    [op("NoCredentials"), "no-passkey", MESSAGES.noPasskey],
    [op("NoCreateOption"), "no-provider", MESSAGES.noProvider],
    [op("TimedOut"), "timeout", MESSAGES.timeout],
    [op("NotSupported"), "not-supported", MESSAGES.notSupported],
    [op("BadConfiguration"), "domain", MESSAGES.domain],
    [op("Native error", "RP ID cannot be validated."), "domain", MESSAGES.domain],
    [op("Unknown error"), "unknown", MESSAGES.unknown],
    [new WrongPasskeyError(), "wrong-passkey", new WrongPasskeyError().message],
    [new RpGuardError("bad host"), "rp-guard", "bad host"],
    [new Error("anything"), "unknown", MESSAGES.unknown],
  ])("%s", (e, kind, message) => {
    expect(describeAuthError(e, ctx)).toEqual({ kind, message });
  });

  it("first passkey call: an unexplained failure is treated as the domain association (dev log, no secrets)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(describeAuthError(op("Unknown error"), { ...ctx, firstPasskeyCall: true }).kind).toBe("domain");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("curl -sI https://meridian-testnet.vercel.app/.well-known/assetlinks.json");
    // a cancel is still a cancel on the first call
    expect(describeAuthError(op("UserCancelled"), { ...ctx, firstPasskeyCall: true }).kind).toBe("cancelled");
  });
});
