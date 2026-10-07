import { describe, expect, it } from "vitest";
import { deriveLoginState, describeSignError, walletKindOf } from "./login";

const on = { privyEnabled: true, ready: true, authenticated: false, walletAddress: undefined, error: undefined };

describe("login state machine", () => {
  it("no app ID ⇒ injected-only (fallback path)", () => {
    expect(deriveLoginState({ ...on, privyEnabled: false }).kind).toBe("injected-only");
  });
  it("walks loading → logged-out → creating-wallet → ready", () => {
    expect(deriveLoginState({ ...on, ready: false }).kind).toBe("loading");
    expect(deriveLoginState(on).kind).toBe("logged-out");
    expect(deriveLoginState({ ...on, authenticated: true }).kind).toBe("creating-wallet");
    expect(deriveLoginState({ ...on, authenticated: true, walletAddress: "0xabc" })).toEqual({ kind: "ready", address: "0xabc", wallet: "unknown" });
  });
  it("ready carries the wallet kind (embedded ⇒ sponsorable, external ⇒ pays gas)", () => {
    const ready = { ...on, authenticated: true, walletAddress: "0xabc" };
    expect(deriveLoginState({ ...ready, walletKind: "embedded" })).toEqual({ kind: "ready", address: "0xabc", wallet: "embedded" });
    expect(deriveLoginState({ ...ready, walletKind: "external" })).toEqual({ kind: "ready", address: "0xabc", wallet: "external" });
  });
  it("loading wins over everything; logged-out ignores a stale wallet", () => {
    expect(deriveLoginState({ ...on, ready: false, authenticated: true, walletAddress: "0xabc" }).kind).toBe("loading");
    expect(deriveLoginState({ ...on, walletAddress: "0xabc" }).kind).toBe("logged-out");
  });
  it("error only shows while logged out; a later success clears it", () => {
    expect(deriveLoginState({ ...on, error: "boom" })).toEqual({ kind: "error", message: "boom" });
    expect(deriveLoginState({ ...on, authenticated: true, walletAddress: "0xabc", error: "boom" }).kind).toBe("ready");
  });
});

describe("walletKindOf", () => {
  it("Privy's embedded walletClientType is 'privy'; anything else is external", () => {
    expect(walletKindOf("privy")).toBe("embedded");
    expect(walletKindOf("metamask")).toBe("external");
    expect(walletKindOf(undefined)).toBeUndefined();
  });
});

describe("describeSignError", () => {
  it("maps a rejected signature, wrong chain and expired deadline", () => {
    expect(describeSignError(new Error("User rejected the request."))).toBe("Signature cancelled");
    expect(describeSignError(Object.assign(new Error("x"), { code: "wrong-chain" }))).toMatch(/Wrong network/);
    expect(describeSignError(Object.assign(new Error("x"), { code: "deadline-expired" }))).toMatch(/expired/);
  });
  it("a refused sponsorship reads as the free-gas message", async () => {
    const { SponsorError, SPONSOR_UNAVAILABLE } = await import("./sponsor");
    expect(describeSignError(new SponsorError(new Error("quota")))).toBe(SPONSOR_UNAVAILABLE);
  });
  it("falls back to the first line", () => {
    expect(describeSignError(new Error("first\nsecond"))).toBe("first");
  });
});
