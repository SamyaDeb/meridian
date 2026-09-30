import { describe, expect, it } from "vitest";
import { type Snapshot, TEAM_PLAN_THRESHOLDS as T, evaluateAlerts, ifBaseline } from "../src/alerts.js";

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
    expect(codes({ ...ok, indexerLagSec: 31 })).toEqual(["warn:indexer_lag"]);
  });
  it("unknown parts (null) never alert", () => {
    expect(codes({ ...ok, oracle: null, lastFundingBlock: null, insuranceFundToken: null, vault: null, keeperBalances: [], keeperHealth: [], indexerLagSec: null }, null)).toEqual([]);
  });
});
