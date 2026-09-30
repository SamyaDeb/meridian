// Monitoring rules (TEAM_PLAN §7) as a pure function over one snapshot; scripts/watch.ts gathers the snapshot and prints
// `ALERT …` lines (paging integration is Phase 5). Unit-tested in test/alerts.test.ts.

export interface Thresholds {
  oracleMaxAgeSec: bigint; // 30
  fundingMaxGapBlocks: bigint; // 100
  ifMaxDropBps: bigint; // 2,000 = 20%
  vaultMinMarginRatioWad: bigint; // 0.30e18
  keeperMinBalanceWei: bigint; // 5 MON
  indexerMaxLagSec: number; // 30
}

export const TEAM_PLAN_THRESHOLDS: Thresholds = {
  oracleMaxAgeSec: 30n,
  fundingMaxGapBlocks: 100n,
  ifMaxDropBps: 2_000n,
  vaultMinMarginRatioWad: 300_000_000_000_000_000n,
  keeperMinBalanceWei: 5n * 10n ** 18n,
  indexerMaxLagSec: 30,
};

export interface Snapshot {
  nowSec: bigint; // chain time (latest block timestamp)
  headBlock: bigint;
  oracle: { ok: boolean; updatedAt: bigint } | null;
  lastFundingBlock: bigint | null;
  insuranceFundToken: bigint | null;
  vault: { hedged: boolean; marginRatioWad: bigint } | null;
  keeperBalances: Array<{ label: string; wei: bigint }>;
  /** keeper /health endpoints: ok flag, or null if unreachable */
  keeperHealth: Array<{ url: string; ok: boolean | null; errors?: number }>;
  indexerLagSec: number | null;
}

export interface Alert {
  severity: "critical" | "warn";
  code: string;
  message: string;
}

/** IF drop measured against the highest balance seen so far (a deposit raises the baseline, a payout doesn't). */
export function ifBaseline(prev: bigint | null, current: bigint): bigint {
  return prev === null || current > prev ? current : prev;
}

export function evaluateAlerts(s: Snapshot, t: Thresholds, ifPeak: bigint | null): Alert[] {
  const out: Alert[] = [];
  if (s.oracle !== null) {
    const age = s.nowSec > s.oracle.updatedAt ? s.nowSec - s.oracle.updatedAt : 0n;
    if (!s.oracle.ok) out.push({ severity: "critical", code: "oracle_stale", message: `oracle reports stale (age ${age} s): funding frozen, increases blocked` });
    else if (age > t.oracleMaxAgeSec) out.push({ severity: "warn", code: "oracle_old", message: `oracle age ${age} s > ${t.oracleMaxAgeSec} s` });
  }
  if (s.lastFundingBlock !== null && s.headBlock - s.lastFundingBlock > t.fundingMaxGapBlocks) {
    out.push({ severity: "critical", code: "funding_gap", message: `funding not updated for ${s.headBlock - s.lastFundingBlock} blocks (> ${t.fundingMaxGapBlocks})` });
  }
  if (s.insuranceFundToken !== null && ifPeak !== null && ifPeak > 0n) {
    const dropBps = ((ifPeak - s.insuranceFundToken) * 10_000n) / ifPeak;
    if (dropBps > t.ifMaxDropBps) out.push({ severity: "critical", code: "if_drop", message: `insurance fund down ${dropBps} bps from its peak` });
  }
  if (s.vault !== null && s.vault.hedged && s.vault.marginRatioWad < t.vaultMinMarginRatioWad) {
    out.push({ severity: "critical", code: "vault_margin", message: `vault perp margin ratio ${s.vault.marginRatioWad} < ${t.vaultMinMarginRatioWad} (WAD)` });
  }
  for (const k of s.keeperBalances) {
    if (k.wei < t.keeperMinBalanceWei) out.push({ severity: "warn", code: "keeper_balance", message: `${k.label} balance ${k.wei} wei < ${t.keeperMinBalanceWei}` });
  }
  for (const h of s.keeperHealth) {
    if (h.ok === null) out.push({ severity: "critical", code: "keeper_down", message: `${h.url} unreachable` });
    else if (!h.ok) out.push({ severity: "critical", code: "keeper_stalled", message: `${h.url} reports ok=false (no tick for 30 s)` });
  }
  if (s.indexerLagSec !== null && s.indexerLagSec > t.indexerMaxLagSec) {
    out.push({ severity: "warn", code: "indexer_lag", message: `indexer ${s.indexerLagSec} s behind (> ${t.indexerMaxLagSec} s)` });
  }
  return out;
}
