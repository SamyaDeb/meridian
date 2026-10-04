// Monitoring rules (TEAM_PLAN §7 + Phase 5 B6) as a pure function over one snapshot; scripts/watch.ts gathers the
// snapshot, prints `ALERT …` lines and pages them (src/paging.ts). Unit-tested in test/alerts.test.ts.

export interface Thresholds {
  oracleMaxAgeSec: bigint; // 30
  fundingMaxGapBlocks: bigint; // 100
  ifMaxDropBps: bigint; // 2,000 = 20%
  vaultMinMarginRatioWad: bigint; // 0.30e18
  keeperMinBalanceWei: bigint; // 5 MON
  indexerMaxLagSec: number; // 30
  ausdMinPrice8: bigint; // 0.99 (8 dp): RISKS E4 depeg
  feedMaxAgeSec: bigint; // 7,200: a Chainlink monitor/guard feed older than this is blind (A-15)
  mmMaxEmptySec: bigint; // 60: an MM with no resting order on its book (eviction storm, B-04; crash)
  maturityWarnSec: bigint; // 86,400: swap maturity approaching with open interest
  maturityMaxUnsettledSec: bigint; // 60: matured but not snapshotted (keeper's settleMaturity)
  vaultMaxShareDropBps: bigint; // 50: share price below its peak (A-09 compromised-keeper drain, bad fills)
}

export const TEAM_PLAN_THRESHOLDS: Thresholds = {
  oracleMaxAgeSec: 30n,
  fundingMaxGapBlocks: 100n,
  ifMaxDropBps: 2_000n,
  vaultMinMarginRatioWad: 300_000_000_000_000_000n,
  keeperMinBalanceWei: 5n * 10n ** 18n,
  indexerMaxLagSec: 30,
  ausdMinPrice8: 99_000_000n,
  feedMaxAgeSec: 7_200n,
  mmMaxEmptySec: 60n,
  maturityWarnSec: 86_400n,
  maturityMaxUnsettledSec: 60n,
  vaultMaxShareDropBps: 50n,
};

export interface Snapshot {
  nowSec: bigint; // chain time (latest block timestamp)
  headBlock: bigint;
  oracle: { ok: boolean; updatedAt: bigint } | null;
  lastFundingBlock: bigint | null;
  insuranceFundToken: bigint | null;
  vault: { hedged: boolean; marginRatioWad: bigint } | null;
  /** minWei overrides keeperMinBalanceWei per wallet (size it from RUNBOOK §4 MON/h × hours of runway at the mainnet gas price) */
  keeperBalances: Array<{ label: string; wei: bigint; minWei?: bigint }>;
  /** keeper /health endpoints: ok flag, or null if unreachable */
  keeperHealth: Array<{ url: string; ok: boolean | null; errors?: number }>;
  indexerLagSec: number | null;
  /** Chainlink AUSD/USD (8 dp), RISKS E4 */
  ausdUsd?: { price8: bigint; updatedAt: bigint } | null;
  /** Chainlink MON/USD, the adapter's deviation guard (fails open when stale, review A-15) */
  secondaryFeed?: { updatedAt: bigint } | null;
  /** seconds each MM has had 0 open orders (0 = has orders), from emptySince() */
  mmBooks?: Array<{ label: string; emptyForSec: bigint }>;
  swap?: { maturity: bigint; snapped: boolean; longOI: bigint } | null;
  vaultSharePrice?: bigint | null;
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

export function evaluateAlerts(s: Snapshot, t: Thresholds, ifPeak: bigint | null, vaultPeak: bigint | null = null): Alert[] {
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
    const min = k.minWei ?? t.keeperMinBalanceWei;
    if (k.wei < min) out.push({ severity: "warn", code: "keeper_balance", message: `${k.label} balance ${k.wei} wei < ${min}` });
  }
  for (const h of s.keeperHealth) {
    if (h.ok === null) out.push({ severity: "critical", code: "keeper_down", message: `${h.url} unreachable` });
    else if (!h.ok) out.push({ severity: "critical", code: "keeper_stalled", message: `${h.url} reports ok=false (no tick for 30 s)` });
  }
  if (s.indexerLagSec !== null && s.indexerLagSec > t.indexerMaxLagSec) {
    out.push({ severity: "warn", code: "indexer_lag", message: `indexer ${s.indexerLagSec} s behind (> ${t.indexerMaxLagSec} s)` });
  }
  if (s.ausdUsd != null) {
    const age = s.nowSec > s.ausdUsd.updatedAt ? s.nowSec - s.ausdUsd.updatedAt : 0n;
    if (s.ausdUsd.price8 < t.ausdMinPrice8) {
      out.push({ severity: "critical", code: "ausd_depeg", message: `AUSD/USD ${fmt8(s.ausdUsd.price8)} < ${fmt8(t.ausdMinPrice8)}: pause deposits (RUNBOOK §10)` });
    }
    if (age > t.feedMaxAgeSec) out.push({ severity: "warn", code: "ausd_feed_old", message: `AUSD/USD feed ${age} s old: depeg monitor blind` });
  }
  if (s.secondaryFeed != null) {
    const age = s.nowSec > s.secondaryFeed.updatedAt ? s.nowSec - s.secondaryFeed.updatedAt : 0n;
    if (age > t.feedMaxAgeSec) out.push({ severity: "warn", code: "guard_feed_old", message: `Chainlink MON/USD ${age} s old: the Pyth deviation guard is off` });
  }
  for (const m of s.mmBooks ?? []) {
    if (m.emptyForSec > t.mmMaxEmptySec) out.push({ severity: "critical", code: "mm_empty", message: `${m.label} has had 0 open orders for ${m.emptyForSec} s` });
  }
  if (s.swap != null && s.swap.longOI > 0n) {
    if (s.nowSec >= s.swap.maturity) {
      const late = s.nowSec - s.swap.maturity;
      if (!s.swap.snapped && late > t.maturityMaxUnsettledSec) {
        out.push({ severity: "critical", code: "maturity_unsettled", message: `swap matured ${late} s ago, not snapshotted: call settleMaturity()` });
      }
    } else if (s.swap.maturity - s.nowSec <= t.maturityWarnSec) {
      out.push({ severity: "warn", code: "maturity_soon", message: `swap matures in ${(s.swap.maturity - s.nowSec) / 3600n} h with OI ${s.swap.longOI} (keeper settleMaturity must be running)` });
    }
  }
  if (s.vaultSharePrice != null && vaultPeak !== null && vaultPeak > 0n && s.vaultSharePrice < vaultPeak) {
    const dropBps = ((vaultPeak - s.vaultSharePrice) * 10_000n) / vaultPeak;
    if (dropBps > t.vaultMaxShareDropBps) {
      out.push({ severity: "critical", code: "vault_share_drop", message: `vault share price ${dropBps} bps below its peak: check fills; revoke the keeper if unexplained (RUNBOOK §10)` });
    }
  }
  return out;
}

const fmt8 = (x: bigint): string => `${x / 100_000_000n}.${(x % 100_000_000n).toString().padStart(8, "0")}`;

/** When a condition started holding (null = not holding): keeps the first time, resets when it clears. */
export function emptySince(prev: bigint | null, holding: boolean, nowSec: bigint): bigint | null {
  if (!holding) return null;
  return prev ?? nowSec;
}
