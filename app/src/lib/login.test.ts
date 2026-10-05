import { describe, expect, it } from "vitest";
import { deriveLoginState, describeSignError } from "./login";

const on = { privyEnabled: true, ready: true, authenticated: false, walletAddress: undefined, error: undefined };

describe("login state machine", () => {
  it("no app ID ⇒ injected-only (fallback path)", () => {
    expect(deriveLoginState({ ...on, privyEnabled: false }).kind).toBe("injected-only");
  });
  it("walks loading → logged-out → creating-wallet → ready", () => {
    expect(deriveLoginState({ ...on, ready: false }).kind).toBe("loading");
    expect(deriveLoginState(on).kind).toBe("logged-out");
    expect(deriveLoginState({ ...on, authenticated: true }).kind).toBe("creating-wallet");
    expect(deriveLoginState({ ...on, authenticated: true, walletAddress: "0xabc" })).toEqual({ kind: "ready", address: "0xabc" });
  });
  it("error only shows while logged out; a later success clears it", () => {
    expect(deriveLoginState({ ...on, error: "boom" })).toEqual({ kind: "error", message: "boom" });
    expect(deriveLoginState({ ...on, authenticated: true, walletAddress: "0xabc", error: "boom" }).kind).toBe("ready");
  });
});

describe("describeSignError", () => {
  it("maps a rejected signature, wrong chain and expired deadline", () => {
    expect(describeSignError(new Error("User rejected the request."))).toBe("Signature cancelled");
    expect(describeSignError(Object.assign(new Error("x"), { code: "wrong-chain" }))).toMatch(/Wrong network/);
    expect(describeSignError(Object.assign(new Error("x"), { code: "deadline-expired" }))).toMatch(/expired/);
  });
  it("falls back to the first line", () => {
    expect(describeSignError(new Error("first\nsecond"))).toBe("first");
  });
});
