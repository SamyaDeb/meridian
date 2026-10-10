// K6 B3: the /stats reader gives the same numbers as the USERS.md CLI (indexer/scripts/lib/users.mjs) on one fixture.
// The fixture is SHAPED from indexer/schema.graphql, not recorded (see its _note).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { METRICS_QUERY, TEST_WALLETS, parseMetrics } from "./metrics";
import { METRICS_QUERY as CLI_QUERY, computeMetrics } from "../../../../indexer/scripts/lib/users.mjs";

const fx = JSON.parse(readFileSync(new URL("../../../../indexer/test/fixtures/metrics/shaped-10143.json", import.meta.url), "utf8"));
const listed = JSON.parse(readFileSync(new URL("../../../../docs/outputs/test-wallets.json", import.meta.url), "utf8")).wallets.map((w: { address: string }) => w.address);

describe("metrics reader", () => {
  it("uses the CLI's query and the same labelled test wallets", () => {
    expect(METRICS_QUERY).toBe(CLI_QUERY);
    expect([...TEST_WALLETS].sort()).toEqual([...listed].sort());
  });
  it("matches the CLI field by field", () => {
    const a = parseMetrics(fx.data, fx.head, 10143);
    const b = computeMetrics(fx.data, fx.head, { chainId: 10143, testWallets: listed });
    for (const k of Object.keys(a) as (keyof typeof a)[]) expect(a[k], k).toEqual(b[k]);
    expect(a.externalUsers).toBe(3);
    expect(a.liquidationsTestMarket).toBe(2);
  });
  it("throws when the indexer lacks a root field (the page then says unavailable)", () => {
    expect(() => parseMetrics({ ...fx.data, VaultRedeemRequest: undefined }, undefined, 10143)).toThrow(/VaultRedeemRequest/);
  });
});
