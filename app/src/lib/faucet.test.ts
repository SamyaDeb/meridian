import { afterEach, describe, expect, it, vi } from "vitest";
import { FAUCET_AMOUNT, FAUCET_COOLDOWN_MS, faucetAvailable, msUntilNextClaim, readLastClaim, writeLastClaim } from "./faucet";
import testnet from "../../../deployments/10143.json";
import local from "../../../deployments/31337.json";

describe("faucet", () => {
  it("is 10,000 AUSD at 6 dp", () => {
    expect(FAUCET_AMOUNT).toBe(10_000_000_000n);
  });
  it("shows on testnet and anvil, where AUSD is our mock", () => {
    expect(faucetAvailable(10143, testnet)).toBe(true);
    expect(faucetAvailable(31337, local)).toBe(true);
  });
  it("never on mainnet, even if a record claimed a mock AUSD", () => {
    expect(faucetAvailable(143, { mockContracts: ["AUSD"] })).toBe(false);
  });
  it("hidden when AUSD isn't a mock or there is no record", () => {
    expect(faucetAvailable(10143, { mockContracts: ["KuruHedger"] })).toBe(false);
    expect(faucetAvailable(10143, {})).toBe(false);
    expect(faucetAvailable(10143, undefined)).toBe(false);
  });
  it("one claim per hour", () => {
    expect(msUntilNextClaim(undefined, 1_000)).toBe(0);
    expect(msUntilNextClaim(1_000, 1_000)).toBe(FAUCET_COOLDOWN_MS);
    expect(msUntilNextClaim(1_000, 1_000 + FAUCET_COOLDOWN_MS - 1)).toBe(1);
    expect(msUntilNextClaim(1_000, 1_000 + FAUCET_COOLDOWN_MS)).toBe(0);
    expect(msUntilNextClaim(Number.NaN, 5)).toBe(0);
  });
});

describe("faucet storage", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("round-trips per chain and address (case-insensitive)", () => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    writeLastClaim(10143, "0xABC", 42);
    expect(readLastClaim(10143, "0xabc")).toBe(42);
    expect(readLastClaim(31337, "0xabc")).toBeUndefined();
  });
  it("throwing storage ⇒ no record, no crash", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => writeLastClaim(10143, "0xabc", 1)).not.toThrow();
    expect(readLastClaim(10143, "0xabc")).toBeUndefined();
  });
});
