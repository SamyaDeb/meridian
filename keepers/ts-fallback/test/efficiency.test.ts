// Phase 4 step 1: the keeper's RPC-load decisions (incremental liquidation scan, funding gap bookkeeping, source
// polling, per-chain inclusion lag). Pure functions, hand-computed values.
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  type AccountSnapshot,
  type CheckedAccount,
  WAD,
  accountsToCheck,
  checkedFrom,
  defaultInclusionLag,
  forceSweepAfterPush,
  fundingGaps,
  observedMaxGap,
  needsRecheck,
  shouldCheckVault,
  shouldPokeFunding,
  shouldReadSource,
} from "../src/decide.js";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const C = "0x000000000000000000000000000000000000000c" as Address;
const MARK = 29n * 10n ** 15n; // 0.029

describe("needsRecheck: can the mark move have crossed maintenance?", () => {
  // 10,000 MON long at 0.029 (notional 290), headroom 10 AUSD
  const c: CheckedAccount = { headroom: 10n * WAD, absSize: 10_000n * WAD, markAtRead: MARK };
  it("re-reads once 4·|size|·|Δmark| ≥ headroom (Δmark ≥ 0.00025 here)", () => {
    expect(needsRecheck(c, MARK + 249n * 10n ** 12n)).toBe(false); // 4·10,000·0.000249 = 9.96 < 10
    expect(needsRecheck(c, MARK + 250n * 10n ** 12n)).toBe(true); // = 10
    expect(needsRecheck(c, MARK - 250n * 10n ** 12n)).toBe(true); // either direction
  });
  it("an unchanged mark never re-reads a healthy account; a candidate is always re-read", () => {
    expect(needsRecheck(c, MARK)).toBe(false);
    expect(needsRecheck({ ...c, headroom: 0n }, MARK)).toBe(true);
    expect(needsRecheck({ ...c, headroom: -1n }, MARK)).toBe(true);
  });
  it("checkedFrom records equity − MM, |size| and the mark", () => {
    const s: AccountSnapshot = { account: A, size: -5n * WAD, equity: 7n * WAD, maintenanceMargin: 2n * WAD, liquidatable: false };
    expect(checkedFrom(s, MARK)).toEqual({ headroom: 5n * WAD, absSize: 5n * WAD, markAtRead: MARK });
  });
});

describe("accountsToCheck", () => {
  const healthy: CheckedAccount = { headroom: 100n * WAD, absSize: 1_000n * WAD, markAtRead: MARK };
  const base = {
    block: 105n,
    open: new Set([A, B, C]),
    changed: new Set<Address>(),
    checked: new Map([
      [A, healthy],
      [B, healthy],
      [C, healthy],
    ]),
    markWad: MARK,
    lastFullSweepBlock: 100n,
    fullSweepEvery: 50n,
    forceFull: false,
  };
  it("quiet block: nothing to read", () => {
    expect(accountsToCheck(base)).toEqual({ accounts: [], full: false });
  });
  it("reads changed and never-read accounts only", () => {
    const checked = new Map(base.checked);
    checked.delete(C);
    expect(accountsToCheck({ ...base, changed: new Set([A]), checked })).toEqual({ accounts: [A, C], full: false });
  });
  it("reads accounts whose headroom the mark move could have eaten", () => {
    const tight: CheckedAccount = { headroom: WAD, absSize: 1_000n * WAD, markAtRead: MARK };
    const checked = new Map(base.checked).set(B, tight);
    // Δmark = 0.00025 ⇒ 4·1,000·0.00025 = 1 ≥ 1 (B), < 100 (A, C)
    expect(accountsToCheck({ ...base, checked, markWad: MARK + 250n * 10n ** 12n }).accounts).toEqual([B]);
  });
  it("full sweep: first run, every N blocks, or forced by an oracle push", () => {
    expect(accountsToCheck({ ...base, lastFullSweepBlock: -1n })).toEqual({ accounts: [A, B, C], full: true });
    expect(accountsToCheck({ ...base, block: 150n }).full).toBe(true);
    expect(accountsToCheck({ ...base, block: 149n }).full).toBe(false);
    expect(accountsToCheck({ ...base, forceFull: true }).accounts).toEqual([A, B, C]);
  });
  it("never reads accounts without a position", () => {
    expect(accountsToCheck({ ...base, open: new Set([A]), changed: new Set([B]), lastFullSweepBlock: -1n }).accounts).toEqual([A]);
  });
});

describe("forceSweepAfterPush", () => {
  it("sweeps from the push block for `blocks` more blocks", () => {
    expect(forceSweepAfterPush(10n, 10n, 3n)).toBe(true);
    expect(forceSweepAfterPush(13n, 10n, 3n)).toBe(true);
    expect(forceSweepAfterPush(14n, 10n, 3n)).toBe(false);
    expect(forceSweepAfterPush(9n, 10n, 3n)).toBe(false);
    expect(forceSweepAfterPush(10n, -1n, 3n)).toBe(false);
  });
});

describe("funding gap bookkeeping", () => {
  it("defaultInclusionLag: 6 on testnet (30 Sep: pokes landed 3–4 blocks late), 2 elsewhere", () => {
    expect(defaultInclusionLag(10143)).toBe(6n);
    expect(defaultInclusionLag(31337)).toBe(2n);
    expect(defaultInclusionLag(143)).toBe(2n);
  });
  it("lag 6 pokes at lastUpdate + 14 so a 4-block landing delay still keeps the gap ≤ 20", () => {
    const i = { lastUpdateBlock: 100n, maxGapBlocks: 20n, inclusionLagBlocks: 6n };
    expect(shouldPokeFunding({ ...i, currentBlock: 113n })).toBe(false);
    expect(shouldPokeFunding({ ...i, currentBlock: 114n })).toBe(true);
  });
  it("fundingGaps: largest gap between consecutive FundingUpdated blocks, across calls", () => {
    expect(fundingGaps(-1n, [10n, 25n, 30n])).toEqual({ maxGap: 15n, last: 30n });
    expect(fundingGaps(30n, [51n])).toEqual({ maxGap: 21n, last: 51n });
    expect(fundingGaps(51n, [])).toEqual({ maxGap: 0n, last: 51n });
    expect(fundingGaps(51n, [51n, 40n])).toEqual({ maxGap: 0n, last: 51n }); // duplicates / out of order ignored
  });
});

describe("source polling and vault reads", () => {
  it("shouldReadSource throttles the external price read", () => {
    expect(shouldReadSource(0, -1, 1_000)).toBe(true);
    expect(shouldReadSource(999, 0, 1_000)).toBe(false);
    expect(shouldReadSource(1_000, 0, 1_000)).toBe(true);
  });
  it("shouldCheckVault also reads right after an index move (MarginLow)", () => {
    expect(shouldCheckVault(41n, 20n, true)).toBe(true);
    expect(shouldCheckVault(41n, 20n, false)).toBe(false);
  });
});

describe("observedMaxGap (the keeper's own gaps, not the initial scan's history)", () => {
  it("ignores gaps inside history and the gap into the first tick", () => {
    // 30 Sep rehearsal: history 300, 327 (gap 27), keeper's first tick at 358, then 360, 367, 373, 392
    expect(observedMaxGap(-1n, 358n, [300n, 327n, 360n, 367n, 373n, 392n])).toBe(19n);
    expect(observedMaxGap(327n, 358n, [360n])).toBe(0n);
    expect(observedMaxGap(360n, 358n, [381n])).toBe(21n);
    expect(observedMaxGap(360n, -1n, [381n])).toBe(0n);
  });
});
