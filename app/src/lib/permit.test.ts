import { describe, expect, it } from "vitest";
import { hashTypedData, recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PERMIT_TTL_SECONDS, PermitError, assertPermitUsable, buildPermitTypedData, permitDeadline, permitDomainFrom, splitSignature } from "./permit";

const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1, test-only
const token = "0x00000000000000000000000000000000000000a1" as Address;
const spender = "0x00000000000000000000000000000000000000b2" as Address;
const base = { token, owner: acct.address, spender, value: 5_000_000n, nonce: 7n, chainId: 10143, deadline: 2_000_000_000n, domain: { name: "Test USDC", version: "1" } };

describe("permit typed data", () => {
  it("uses the token's own domain, the token as verifyingContract and the exact message fields", () => {
    const t = buildPermitTypedData(base);
    expect(t.domain).toEqual({ name: "Test USDC", version: "1", chainId: 10143, verifyingContract: token });
    expect(t.primaryType).toBe("Permit");
    expect(t.message).toEqual({ owner: acct.address, spender, value: 5_000_000n, nonce: 7n, deadline: 2_000_000_000n });
  });
  it("signature recovers to the owner; a different nonce or chain gives a different digest", async () => {
    const t = buildPermitTypedData(base);
    const sig = await acct.signTypedData(t);
    expect(await recoverTypedDataAddress({ ...t, signature: sig })).toBe(acct.address);
    expect(hashTypedData(buildPermitTypedData({ ...base, nonce: 8n }))).not.toBe(hashTypedData(t));
    expect(hashTypedData(buildPermitTypedData({ ...base, chainId: 143 }))).not.toBe(hashTypedData(t));
  });
  it("a different domain name or version gives a different digest", () => {
    const t = hashTypedData(buildPermitTypedData(base));
    expect(hashTypedData(buildPermitTypedData({ ...base, domain: { name: "USD Coin", version: "1" } }))).not.toBe(t);
    expect(hashTypedData(buildPermitTypedData({ ...base, domain: { name: "Test USDC", version: "2" } }))).not.toBe(t);
  });
  it("permitDomainFrom: trusts eip712Domain() only for this chain and this token, with name and version", () => {
    const ok = ["0x0f", "USD Coin", "2", 10143n, token, "0x" + "0".repeat(64), []] as const;
    expect(permitDomainFrom(ok, token, 10143)).toEqual({ name: "USD Coin", version: "2" });
    expect(permitDomainFrom(ok, token.toUpperCase().replace("0X", "0x") as Address, 10143)).toEqual({ name: "USD Coin", version: "2" });
    expect(permitDomainFrom(ok, token, 143)).toBeUndefined(); // other chain
    expect(permitDomainFrom(ok, spender, 10143)).toBeUndefined(); // other contract
    expect(permitDomainFrom(["0x0c", "USD Coin", "2", 10143n, token], token, 10143)).toBeUndefined(); // name/version not declared
    expect(permitDomainFrom(["0x03", "USD Coin", "", 0n, spender], token, 10143)).toBeUndefined(); // empty version
    expect(permitDomainFrom(["0x03", "USD Coin", "2", 0n, spender], token, 10143)).toEqual({ name: "USD Coin", version: "2" }); // chain / contract not part of the domain
  });
  it("deadline = now + 30 min (whole seconds)", () => {
    expect(PERMIT_TTL_SECONDS).toBe(1800n);
    expect(permitDeadline(1_700_000_000_999)).toBe(1_700_000_000n + 1800n);
  });
});

describe("permit failure paths", () => {
  const now = 1_700_000_000_000;
  it("rejects a wallet on the wrong chain", () => {
    expect(() => assertPermitUsable({ walletChainId: 143, nodeChainId: 10143, deadline: 1_700_001_800n, nowMs: now })).toThrowError(PermitError);
    try {
      assertPermitUsable({ walletChainId: 143, nodeChainId: 10143, deadline: 1_700_001_800n, nowMs: now });
    } catch (e) {
      expect((e as PermitError).code).toBe("wrong-chain");
    }
  });
  it("rejects an expired deadline (boundary: deadline == now is expired)", () => {
    expect(() => assertPermitUsable({ walletChainId: 10143, nodeChainId: 10143, deadline: 1_700_000_000n, nowMs: now })).toThrowError(/deadline/);
    expect(() => assertPermitUsable({ walletChainId: 10143, nodeChainId: 10143, deadline: 1_700_000_001n, nowMs: now })).not.toThrow();
  });
  it("accepts an unknown wallet chain (checked by the switch step instead)", () => {
    expect(() => assertPermitUsable({ walletChainId: undefined, nodeChainId: 10143, deadline: 1_700_001_800n, nowMs: now })).not.toThrow();
  });
  it("splits r/s/v and normalises 0/1 recovery ids", async () => {
    const sig = await acct.signTypedData(buildPermitTypedData(base));
    const { r, s, v } = splitSignature(sig);
    expect(r).toBe(`0x${sig.slice(2, 66)}`);
    expect(s).toBe(`0x${sig.slice(66, 130)}`);
    expect([27, 28]).toContain(v);
    const zeroV = `${sig.slice(0, 130)}00` as `0x${string}`;
    expect(splitSignature(zeroV).v).toBe(27);
  });
  it("rejects a malformed signature", () => {
    expect(() => splitSignature("0x1234")).toThrowError(PermitError);
  });
});
