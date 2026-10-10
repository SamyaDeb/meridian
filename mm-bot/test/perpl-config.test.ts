import { describe, expect, it } from "vitest";
import { parseDecimal, perplHedgeFromEnv } from "../src/perpl/config";

const keys = { PERPL_API_KEY: "tok", PERPL_API_KEY_SECRET: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" };

describe("perplHedgeFromEnv (guardrails)", () => {
  it("PERPL_HEDGE unset / 0 ⇒ undefined: no Perpl code path, the MM is unchanged", () => {
    expect(perplHedgeFromEnv({})).toBeUndefined();
    expect(perplHedgeFromEnv({ PERPL_HEDGE: "0", ...keys })).toBeUndefined();
  });
  it("testnet defaults (README Network Configuration) and documented limits", () => {
    const c = perplHedgeFromEnv({ PERPL_HEDGE: "1", ...keys })!;
    expect(c).toMatchObject({ apiUrl: "https://testnet.perpl.xyz/api", wsUrl: "wss://testnet.perpl.xyz", chainId: 10143, marketId: 64, marketSymbol: "MON" });
    expect(c.hedge).toMatchObject({ enabled: true, bandBps: 2500, slippageBps: 50, maxConsecutiveRejects: 3, minCollateral: 50_000_000n, leverage: 500 });
    expect(c.hedge.fundingBias).toBeUndefined();
  });
  it("hard-fails off testnet: chain id, REST host, WS host", () => {
    expect(() => perplHedgeFromEnv({ PERPL_HEDGE: "1", ...keys, PERPL_CHAIN_ID: "143" })).toThrow(/10143/);
    expect(() => perplHedgeFromEnv({ PERPL_HEDGE: "1", ...keys, PERPL_API_URL: "https://app.perpl.xyz/api" })).toThrow(/testnet\.perpl\.xyz/);
    expect(() => perplHedgeFromEnv({ PERPL_HEDGE: "1", ...keys, PERPL_WS_URL: "wss://app.perpl.xyz" })).toThrow(/testnet\.perpl\.xyz/);
    expect(() => perplHedgeFromEnv({ PERPL_HEDGE: "1", ...keys, PERPL_API_URL: "http://testnet.perpl.xyz/api" })).toThrow(/https/);
  });
  it("needs the key pair", () => {
    expect(() => perplHedgeFromEnv({ PERPL_HEDGE: "1" })).toThrow(/PERPL_API_KEY/);
    expect(() => perplHedgeFromEnv({ PERPL_HEDGE: "1", PERPL_API_KEY: "x" })).toThrow(/PERPL_API_KEY_SECRET/);
  });
  it("funding bias only when asked", () => {
    const c = perplHedgeFromEnv({ PERPL_HEDGE: "1", ...keys, HEDGE_FUNDING_BIAS: "1", HEDGE_FUNDING_BIAS_MIN_SPREAD_APR: "0.25" })!;
    expect(c.hedge.fundingBias).toEqual({ minSpreadAprWad: 25n * 10n ** 16n, residualWad: 1000n * 10n ** 18n });
  });
});

describe("parseDecimal", () => {
  it("exact, no floats", () => {
    expect(parseDecimal("0.1", 18, "x")).toBe(10n ** 17n);
    expect(parseDecimal("5000", 6, "x")).toBe(5_000_000_000n);
    expect(parseDecimal("1.500000", 2, "x")).toBe(150n);
    expect(() => parseDecimal("1.234", 2, "x")).toThrow(/more than 2/);
    expect(() => parseDecimal("-1", 2, "x")).toThrow(/non-negative/);
    expect(() => parseDecimal("1e3", 2, "x")).toThrow(/non-negative/);
  });
});
