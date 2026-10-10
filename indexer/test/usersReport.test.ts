// K6 B3: users-report.mjs / the /stats numbers. Fixture is SHAPED from schema.graphql (see its _note), not recorded.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIMIT, METRICS_QUERY, computeMetrics, usersMarkdown } from "../scripts/lib/users.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/metrics/shaped-10143.json", import.meta.url), "utf8"));
const tw = JSON.parse(readFileSync(new URL("../../docs/outputs/test-wallets.json", import.meta.url), "utf8")).wallets.map((w: { address: string }) => w.address);

describe("METRICS_QUERY", () => {
  it("scopes every root field to one chain and caps every list", () => {
    const roots = METRICS_QUERY.match(/\b[A-Z]\w+\(where:/g)!;
    expect(roots.length).toBe(7);
    expect(METRICS_QUERY.match(/chainId: \{ _eq: \$chainId \}/g)!.length).toBe(7);
    expect(METRICS_QUERY.match(new RegExp(`limit: ${LIMIT}`, "g"))!.length).toBe(5);
  });
});

describe("computeMetrics", () => {
  const m = computeMetrics(fx.data, fx.head, { chainId: 10143, testWallets: tw });
  it("subtracts our labelled test wallets from the indexer's external users", () => {
    expect(m.externalUsersIndexer).toBe(4);
    expect(m.externalUsers).toBe(3);
    expect(m.testWalletsExcluded).toBe(1);
    expect(m.externalTraders).toBe(2);
  });
  it("discloses the MM share and counts only external swaps, deposits and requests", () => {
    expect(m.mmShareBps).toBe(6250);
    expect(m.swapsOpenedExternal).toBe(1);
    expect(m.swapsOpenedAll).toBe(2);
    expect(m.vaultDepositorsExternal).toBe(1); // a 0 deposit and the test wallet don't count
    expect(m.vaultDepositedTokenExternal).toBe(100_000_000n);
    expect(m.redeems).toEqual({ requested: 1, claimable: 0, claimed: 1, cancelled: 0 });
  });
  it("keeps the labelled demo market's liquidations apart (case-insensitive ids)", () => {
    expect(m.liquidationsProduct).toBe(1);
    expect(m.liquidationsTestMarket).toBe(2);
  });
  it("reports as of the indexer's processed block for this chain, else the stats block", () => {
    expect(m.asOfBlock).toBe(69_188_798n);
    expect(computeMetrics(fx.data, undefined, { chainId: 10143 }).asOfBlock).toBe(69_100_000n);
  });
  it("throws on a missing or garbled response instead of printing zeros", () => {
    expect(() => computeMetrics({ ...fx.data, ProtocolStats: [] }, undefined, { chainId: 10143 })).toThrow(/ProtocolStats/);
    expect(() => computeMetrics({ ...fx.data, Account: undefined }, undefined, { chainId: 10143 })).toThrow(/Account/);
    const bad = { ...fx.data, ProtocolStats: [{ ...fx.data.ProtocolStats[0], trades: "x" }] };
    expect(() => computeMetrics(bad, undefined, { chainId: 10143 })).toThrow(/trades/);
  });
  it("marks capped lists as lower bounds", () => {
    const many = { ...fx.data, Account: Array.from({ length: LIMIT }, (_, i) => ({ id: `0x${i.toString(16).padStart(40, "0")}`, firstSeenBlock: "1", tradeCount: 0, volumeQuoteWad: "0" })) };
    const c = computeMetrics(many, undefined, { chainId: 10143 });
    expect(c.externalUsersCapped).toBe(true);
    expect(usersMarkdown(c, {})).toContain(`| ≥ ${LIMIT} |`);
  });
});

describe("usersMarkdown", () => {
  const m = computeMetrics(fx.data, fx.head, { chainId: 10143, testWallets: tw });
  it("prints addresses only with recorded consent", () => {
    const accounts = fx.data.Account.map((a: { id: string }) => a.id);
    expect(usersMarkdown(m, { accounts })).toContain("No user has agreed to be listed by address.");
    const md = usersMarkdown(m, { accounts, consented: ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8"] });
    expect(md).toContain("agreed to be listed: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(md).not.toContain("0x3C44");
  });
  it("states the block and the exclusions", () => {
    const md = usersMarkdown(m, {});
    expect(md).toContain("as of block 69188798");
    expect(md).toContain("our 1 labelled test wallet(s) excluded");
    expect(md).toContain("| 1,000.00 · 62.5% |");
    expect(md).toContain("| 1 · 2 |");
  });
});
