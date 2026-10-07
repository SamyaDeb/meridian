import { describe, expect, it } from "vitest";
import { SPONSOR_UNAVAILABLE, SponsorError, isSponsorRefusal, isSponsored } from "./sponsor";

const on = { privyEnabled: true, walletKind: "embedded" as const, chainId: 10143, killSwitch: undefined };

describe("isSponsored", () => {
  it("Privy + embedded wallet + Monad testnet ⇒ sponsored", () => {
    expect(isSponsored(on)).toBe(true);
    expect(isSponsored({ ...on, killSwitch: "1" })).toBe(true);
    expect(isSponsored({ ...on, killSwitch: "" })).toBe(true);
  });
  it("never on mainnet (143) or anvil", () => {
    expect(isSponsored({ ...on, chainId: 143 })).toBe(false);
    expect(isSponsored({ ...on, chainId: 31337 })).toBe(false);
    expect(isSponsored({ ...on, chainId: undefined })).toBe(false);
  });
  it("external or unknown wallets pay their own gas", () => {
    expect(isSponsored({ ...on, walletKind: "external" })).toBe(false);
    expect(isSponsored({ ...on, walletKind: undefined })).toBe(false);
  });
  it("no Privy ⇒ no sponsorship", () => {
    expect(isSponsored({ ...on, privyEnabled: false })).toBe(false);
  });
  it('kill switch NEXT_PUBLIC_SPONSOR_GAS="0" turns it off', () => {
    expect(isSponsored({ ...on, killSwitch: "0" })).toBe(false);
  });
});

describe("sponsor refusals", () => {
  it("recognises policy / quota / paymaster errors, not user cancels or reverts", () => {
    expect(isSponsorRefusal(new Error("Gas sponsorship is not enabled for this chain"))).toBe(true);
    expect(isSponsorRefusal(new Error("paymaster rejected the operation"))).toBe(true);
    expect(isSponsorRefusal(new Error("Monthly quota exceeded"))).toBe(true);
    expect(isSponsorRefusal(new Error("User rejected the request."))).toBe(false);
    expect(isSponsorRefusal(new Error("execution reverted: InsufficientMargin()"))).toBe(false);
  });
  it("SponsorError carries the user-facing message and the cause", () => {
    const cause = new Error("quota");
    const e = new SponsorError(cause);
    expect(e.message).toBe(SPONSOR_UNAVAILABLE);
    expect(e.cause).toBe(cause);
  });
});
