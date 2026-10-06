import { describe, expect, it } from "vitest";
import { type Snapshot, TEAM_PLAN_THRESHOLDS as T, emptySince, evaluateAlerts, ifBaseline } from "../src/alerts.js";

const E = 10n ** 18n;
const ok: Snapshot = {
  nowSec: 1_000n,
  headBlock: 5_000n,
  oracle: { ok: true, updatedAt: 990n },
  lastFundingBlock: 4_990n,
  insuranceFundToken: 1_000_000_000n,
  vault: { hedged: true, marginRatioWad: 666_000_000_000_000_000n },
  keeperBalances: [{ label: "keeper", wei: 6n * E }],
  keeperHealth: [{ url: "http://k/health", ok: true }],
  indexerLagSec: 1,
};
const codes = (s: Snapshot, peak: bigint | null = 1_000_000_000n) => evaluateAlerts(s, T, peak).map((a) => `${a.severity}:${a.code}`);

describe("evaluateAlerts (TEAM_PLAN §7 thresholds)", () => {
  it("healthy snapshot: no alerts", () => {
    expect(codes(ok)).toEqual([]);
  });
  it("oracle: stale is critical, > 30 s old is a warning", () => {
    expect(codes({ ...ok, oracle: { ok: false, updatedAt: 900n } })).toEqual(["critical:oracle_stale"]);
    expect(codes({ ...ok, oracle: { ok: true, updatedAt: 969n } })).toEqual(["warn:oracle_old"]);
    expect(codes({ ...ok, oracle: { ok: true, updatedAt: 970n } })).toEqual([]);
  });
  it("funding not updated > 100 blocks", () => {
    expect(codes({ ...ok, lastFundingBlock: 4_899n })).toEqual(["critical:funding_gap"]);
    expect(codes({ ...ok, lastFundingBlock: 4_900n })).toEqual([]);
  });
  it("IF drop > 20% from its peak", () => {
    expect(codes({ ...ok, insuranceFundToken: 799_000_000n })).toEqual(["critical:if_drop"]);
    expect(codes({ ...ok, insuranceFundToken: 800_000_000n })).toEqual([]);
    expect(ifBaseline(null, 5n)).toBe(5n);
    expect(ifBaseline(10n, 5n)).toBe(10n);
    expect(ifBaseline(10n, 20n)).toBe(20n);
  });
  it("vault margin ratio < 30% only while hedged", () => {
    expect(codes({ ...ok, vault: { hedged: true, marginRatioWad: 299_999_999_999_999_999n } })).toEqual(["critical:vault_margin"]);
    expect(codes({ ...ok, vault: { hedged: false, marginRatioWad: 0n } })).toEqual([]);
  });
  it("keeper balance < 5 MON, keeper down / stalled, indexer lag > 30 s", () => {
    expect(codes({ ...ok, keeperBalances: [{ label: "keeper", wei: 5n * E - 1n }] })).toEqual(["warn:keeper_balance"]);
    expect(codes({ ...ok, keeperHealth: [{ url: "u", ok: null }] })).toEqual(["critical:keeper_down"]);
    expect(codes({ ...ok, keeperHealth: [{ url: "u", ok: false }] })).toEqual(["critical:keeper_stalled"]);
    // H-1: the keeper reports a held position / failed unwinds / no liquidation headroom
    expect(codes({ ...ok, keeperHealth: [{ url: "u", ok: true, unwindPage: "3 consecutive failed unwinds" }] })).toEqual(["critical:keeper_unwind"]);
    expect(codes({ ...ok, keeperHealth: [{ url: "u", ok: true, unwindPage: null }] })).toEqual([]);
    expect(codes({ ...ok, indexerLagSec: 31 })).toEqual(["warn:indexer_lag"]);
  });
  it("unknown parts (null) never alert", () => {
    expect(codes({ ...ok, oracle: null, lastFundingBlock: null, insuranceFundToken: null, vault: null, keeperBalances: [], keeperHealth: [], indexerLagSec: null }, null)).toEqual([]);
  });
});

describe("Phase 5 B6 rules", () => {
  const vcodes = (s: Snapshot, vaultPeak: bigint | null = null) =>
    evaluateAlerts(s, T, 1_000_000_000n, vaultPeak).map((a) => `${a.severity}:${a.code}`);

  it("AUSD depeg < 0.99 is critical; a feed older than 2 h is a warning", () => {
    expect(vcodes({ ...ok, ausdUsd: { price8: 99_988_476n, updatedAt: 0n } })).toEqual([]); // 30 Sep reading
    expect(vcodes({ ...ok, ausdUsd: { price8: 98_999_999n, updatedAt: 900n } })).toEqual(["critical:ausd_depeg"]);
    expect(vcodes({ ...ok, nowSec: 8_201n, oracle: { ok: true, updatedAt: 8_200n }, ausdUsd: { price8: 100_000_000n, updatedAt: 1_000n } })).toEqual(["warn:ausd_feed_old"]);
  });
  it("Chainlink MON/USD guard feed older than 2 h (the deviation guard fails open)", () => {
    expect(vcodes({ ...ok, secondaryFeed: { updatedAt: 1_000n } })).toEqual([]);
    expect(vcodes({ ...ok, nowSec: 8_201n, oracle: { ok: true, updatedAt: 8_200n }, secondaryFeed: { updatedAt: 1_000n } })).toEqual(["warn:guard_feed_old"]);
  });
  it("an MM with 0 open orders for > 60 s", () => {
    expect(vcodes({ ...ok, mmBooks: [{ label: "mm-perp", emptyForSec: 60n }] })).toEqual([]);
    expect(vcodes({ ...ok, mmBooks: [{ label: "mm-swap", emptyForSec: 61n }] })).toEqual(["critical:mm_empty"]);
    expect(emptySince(null, true, 100n)).toBe(100n);
    expect(emptySince(100n, true, 200n)).toBe(100n);
    expect(emptySince(100n, false, 200n)).toBeNull();
  });
  it("swap maturity: warn within 24 h with OI; critical if matured and not snapshotted after 60 s; quiet without OI", () => {
    const sw = (maturity: bigint, snapped: boolean, longOI = 1n) => ({ ...ok, swap: { maturity, snapped, longOI } });
    expect(vcodes(sw(1_000n + 86_401n, false))).toEqual([]);
    expect(vcodes(sw(1_000n + 86_400n, false))).toEqual(["warn:maturity_soon"]);
    expect(vcodes(sw(940n, false))).toEqual([]); // 60 s grace
    expect(vcodes(sw(939n, false))).toEqual(["critical:maturity_unsettled"]);
    expect(vcodes(sw(939n, true))).toEqual([]);
    expect(vcodes(sw(1_100n, false, 0n))).toEqual([]);
  });
  it("vault share price > 50 bps under its peak (A-09)", () => {
    expect(vcodes({ ...ok, vaultSharePrice: 995n * 10n ** 15n }, E)).toEqual([]);
    expect(vcodes({ ...ok, vaultSharePrice: 9_949n * 10n ** 14n }, E)).toEqual(["critical:vault_share_drop"]);
  });
  it("per-wallet balance floors override the 5 MON default", () => {
    expect(vcodes({ ...ok, keeperBalances: [{ label: "mm", wei: 6n * E, minWei: 10n * E }] })).toEqual(["warn:keeper_balance"]);
  });
});
