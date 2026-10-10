import { describe, expect, it } from "vitest";
import { healthReport } from "./health";

const good = {
  NEXT_PUBLIC_DATA_SOURCE: "chain",
  NEXT_PUBLIC_CHAIN_ID: "10143",
  NEXT_PUBLIC_PRIVY_APP_ID: "app-id",
  NEXT_PUBLIC_INDEXER_URL: "https://indexer.example/v1/graphql",
  NEXT_PUBLIC_MONAD_TESTNET_RPC_URL: "https://rpc.example/secret-key",
  MONAD_TESTNET_RPC_URL: "https://rpc.example/another-secret",
};

describe("healthReport", () => {
  it("is ready with the required settings and never echoes a value", () => {
    const r = healthReport(good);
    expect(r.ready).toBe(true);
    expect(r.optional.testnetRpcServer).toBe(true);
    const text = JSON.stringify(r);
    for (const v of Object.values(good).filter((v) => v.startsWith("http") || v === "app-id")) expect(text).not.toContain(v);
  });
  it("names what's missing", () => {
    const r = healthReport({ ...good, NEXT_PUBLIC_INDEXER_URL: " ", NEXT_PUBLIC_PRIVY_APP_ID: undefined });
    expect(r.ready).toBe(false);
    expect(r.required).toMatchObject({ indexerUrl: false, privyAppId: false, chainData: true });
  });
  it("refuses a production build with a dev account or the wrong chain", () => {
    expect(healthReport({ ...good, NEXT_PUBLIC_DEV_ACCOUNT: "0x1" }).ready).toBe(false);
    expect(healthReport({ ...good, NEXT_PUBLIC_CHAIN_ID: "143" }).required.testnetChain).toBe(false);
  });
  it("sponsorship defaults on, off only with 0", () => {
    expect(healthReport(good).optional.sponsorGas).toBe(true);
    expect(healthReport({ ...good, NEXT_PUBLIC_SPONSOR_GAS: "0" }).optional.sponsorGas).toBe(false);
  });
});
