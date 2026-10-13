import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, parseAbi, toFunctionSelector, type Hex } from "viem";
import { deriveLoginState, describeSignError, REVERT_TEXT, walletKindOf } from "./login";

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
  it("names the contract's revert reason instead of the bare first line", () => {
    const abi = parseAbi(["function placeLimitOrder(bool,uint32,uint64,uint8)", "error OracleStale()", "error Weird()"]);
    const revert = (data: Hex) =>
      new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, data, functionName: "placeLimitOrder" }), { abi, functionName: "placeLimitOrder", args: [true, 1, 1n, 0] });
    expect(describeSignError(revert(toFunctionSelector("OracleStale()")))).toBe(REVERT_TEXT.OracleStale);
    expect(describeSignError(revert(toFunctionSelector("Weird()")))).toBe("Reverted: Weird");
  });
  it("a reverted cancelOrder is not a cancelled signature", () => {
    expect(describeSignError(new Error('The contract function "cancelOrder" reverted.'))).not.toBe("Signature cancelled");
  });
  it("a gas shortfall reads as no MON even when the wallet's error is read as a revert", () => {
    const abi = parseAbi(["function mint(address,uint256)"]);
    const wrapped = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi, functionName: "mint", message: "Signer had insufficient balance" }),
      { abi, functionName: "mint", args: ["0x0000000000000000000000000000000000000001", 1n] },
    );
    expect(describeSignError(wrapped)).toMatch(/Not enough MON for gas/);
    expect(describeSignError(new Error("insufficient funds for gas * price + value"))).toMatch(/Not enough MON for gas/);
  });
  it("a token transfer revert is not mistaken for a gas shortfall", () => {
    expect(describeSignError(new Error("ERC20: transfer amount exceeds balance"))).not.toMatch(/MON/);
  });
  it("clips long RPC dumps (raw tx, RPC URL) to one short line", () => {
    const long = `Missing or invalid parameters. ${"x".repeat(400)}`;
    expect(describeSignError(new Error(long)).length).toBeLessThanOrEqual(160);
  });
  it("falls back to the first line", () => {
    expect(describeSignError(new Error("first\nsecond"))).toBe("first");
  });
});
