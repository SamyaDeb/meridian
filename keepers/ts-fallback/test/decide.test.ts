import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  type AccountSnapshot,
  applyPositionChanges,
  blockRanges,
  gasLimitFor,
  isLiquidationCandidate,
  pythToWad,
  selectLiquidations,
  shortfall,
  shouldPokeFunding,
  shouldPushPyth,
  WAD,
} from "../src/decide.js";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const C = "0x000000000000000000000000000000000000000c" as Address;

describe("shouldPokeFunding", () => {
  const base = { lastUpdateBlock: 1000n, maxGapBlocks: 20n, inclusionLagBlocks: 1n };
  it("waits while the landed gap would stay < 20", () => {
    expect(shouldPokeFunding({ ...base, currentBlock: 1000n })).toBe(false);
    expect(shouldPokeFunding({ ...base, currentBlock: 1018n })).toBe(false); // lands 1019: gap 19
  });
  it("pokes so the tx lands exactly at gap 20", () => {
    expect(shouldPokeFunding({ ...base, currentBlock: 1019n })).toBe(true); // lands 1020: gap 20
  });
  it("keeps poking while the gap is overdue", () => {
    expect(shouldPokeFunding({ ...base, currentBlock: 1500n })).toBe(true);
  });
  it("uses the raw 20-block rule with zero inclusion lag", () => {
    expect(shouldPokeFunding({ ...base, inclusionLagBlocks: 0n, currentBlock: 1019n })).toBe(false);
    expect(shouldPokeFunding({ ...base, inclusionLagBlocks: 0n, currentBlock: 1020n })).toBe(true);
  });
  it("never pokes on a stale head behind the last update", () => {
    expect(shouldPokeFunding({ ...base, currentBlock: 999n })).toBe(false);
  });
});

describe("shouldPushPyth", () => {
  const on = { priceWad: 2n * WAD, publishTime: 100n };
  const base = { nowSec: 103n, onchain: on, maxAgeSec: 3n, maxMoveBps: 5n };
  it("no push without a Hermes update (no API key)", () => {
    expect(shouldPushPyth({ ...base, nowSec: 1000n, offchain: null })).toBeNull();
  });
  it("no push when the offchain update is not newer", () => {
    expect(shouldPushPyth({ ...base, nowSec: 1000n, offchain: { priceWad: 3n * WAD, publishTime: 100n } })).toBeNull();
    expect(shouldPushPyth({ ...base, nowSec: 1000n, offchain: { priceWad: 3n * WAD, publishTime: 99n } })).toBeNull();
  });
  it("age boundary: 3 s is fresh, > 3 s is stale", () => {
    const off = { priceWad: 2n * WAD, publishTime: 104n };
    expect(shouldPushPyth({ ...base, nowSec: 103n, offchain: off })).toBeNull();
    expect(shouldPushPyth({ ...base, nowSec: 104n, offchain: off })).toBe("stale");
  });
  it("move boundary: exactly 5 bps holds, above 5 bps pushes", () => {
    const at5 = (2n * WAD * 10_005n) / 10_000n; // +5.0 bps exactly
    expect(shouldPushPyth({ ...base, offchain: { priceWad: at5, publishTime: 101n } })).toBeNull();
    expect(shouldPushPyth({ ...base, offchain: { priceWad: at5 + 1n, publishTime: 101n } })).toBe("moved");
    const down5 = (2n * WAD * 9_995n) / 10_000n;
    expect(shouldPushPyth({ ...base, offchain: { priceWad: down5, publishTime: 101n } })).toBeNull();
    expect(shouldPushPyth({ ...base, offchain: { priceWad: down5 - 1n, publishTime: 101n } })).toBe("moved");
  });
  it("future onchain publishTime counts as age 0", () => {
    const off = { priceWad: 2n * WAD, publishTime: 200n };
    expect(shouldPushPyth({ ...base, nowSec: 50n, offchain: off })).toBeNull();
  });
  it("non-positive onchain price always pushes", () => {
    const r = shouldPushPyth({ ...base, onchain: { priceWad: 0n, publishTime: 100n }, offchain: { priceWad: WAD, publishTime: 101n } });
    expect(r).toBe("stale");
  });
});

describe("pythToWad", () => {
  it("scales like the adapter for expo in [-18, 0]", () => {
    expect(pythToWad(2_864_242n, -8)).toBe(28_642_420_000_000_000n); // observed mainnet MON/USD
    expect(pythToWad(3n, 0)).toBe(3n * WAD);
    expect(pythToWad(29n * 10n ** 15n, -18)).toBe(29n * 10n ** 15n);
  });
  it("rejects out-of-range expo and non-positive prices", () => {
    expect(pythToWad(1n, 1)).toBeNull();
    expect(pythToWad(1n, -19)).toBeNull();
    expect(pythToWad(0n, -8)).toBeNull();
    expect(pythToWad(-1n, -8)).toBeNull();
    expect(pythToWad(1n, -8.5)).toBeNull();
  });
});

describe("liquidations", () => {
  const snap = (account: Address, size: bigint, equity: bigint, mm: bigint, liquidatable: boolean): AccountSnapshot => ({
    account,
    size,
    equity,
    maintenanceMargin: mm,
    liquidatable,
  });

  it("eligibility follows the ClearingHouse flag and excludes flat accounts", () => {
    expect(isLiquidationCandidate(snap(A, WAD, 0n, WAD, true))).toBe(true);
    expect(isLiquidationCandidate(snap(A, -WAD, 0n, WAD, true))).toBe(true);
    expect(isLiquidationCandidate(snap(A, WAD, 2n * WAD, WAD, false))).toBe(false);
    expect(isLiquidationCandidate(snap(A, 0n, -WAD, 0n, true))).toBe(false);
  });

  it("shortfall is mm − equity, floored at 0, and counts negative equity", () => {
    expect(shortfall(snap(A, WAD, 5n, 10n, true))).toBe(5n);
    expect(shortfall(snap(A, WAD, -5n, 10n, true))).toBe(15n);
    expect(shortfall(snap(A, WAD, 10n, 10n, false))).toBe(0n);
  });

  it("ranks by shortfall, then |size|, then address, and caps per block", () => {
    const xs = [
      snap(C, WAD, 5n, 10n, true), // shortfall 5
      snap(B, -3n * WAD, 0n, 10n, true), // shortfall 10, |size| 3
      snap(A, 2n * WAD, 0n, 10n, true), // shortfall 10, |size| 2
      snap(A, WAD, 100n, 10n, false), // healthy
    ];
    expect(selectLiquidations(xs, 10).map((x) => x.account)).toEqual([B, A, C]);
    expect(selectLiquidations(xs, 2).map((x) => x.account)).toEqual([B, A]);
    expect(selectLiquidations(xs, 0)).toEqual([]);
    const tie = [snap(B, WAD, 0n, 10n, true), snap(A, WAD, 0n, 10n, true)];
    expect(selectLiquidations(tie, 5).map((x) => x.account)).toEqual([A, B]);
  });

  it("never selects the keeper itself (liquidate moves the position to msg.sender)", () => {
    const xs = [snap(A, WAD, 0n, 10n, true), snap(B, WAD, 0n, 20n, true)];
    const upperB = B.toUpperCase().replace("0X", "0x") as Address;
    expect(selectLiquidations(xs, 5, upperB).map((x) => x.account)).toEqual([A]);
  });

  it("tracks open positions from PositionChanged in order, case-insensitively", () => {
    const upper = "0x00000000000000000000000000000000000000AB" as Address;
    let s = applyPositionChanges(new Set(), [
      { account: A, newSize: WAD },
      { account: upper, newSize: -WAD },
      { account: A, newSize: 0n },
    ]);
    expect([...s]).toEqual([upper.toLowerCase()]);
    s = applyPositionChanges(s, [{ account: upper.toLowerCase() as Address, newSize: 0n }, { account: A, newSize: 1n }]);
    expect([...s]).toEqual([A]);
  });

  it("does not mutate the input set", () => {
    const s0 = new Set<Address>([A]);
    applyPositionChanges(s0, [{ account: A, newSize: 0n }]);
    expect(s0.has(A)).toBe(true);
  });
});

describe("gas and log ranges", () => {
  it("gas limit = ceil(estimate × 1.2)", () => {
    expect(gasLimitFor(100_000n)).toBe(120_000n);
    expect(gasLimitFor(21_001n)).toBe(25_202n); // 25_201.2 → 25_202
    expect(gasLimitFor(0n)).toBe(0n);
  });
  it("splits getLogs ranges at the 100-block public-RPC cap", () => {
    expect(blockRanges(0n, 99n, 100n)).toEqual([[0n, 99n]]);
    expect(blockRanges(0n, 100n, 100n)).toEqual([
      [0n, 99n],
      [100n, 100n],
    ]);
    expect(blockRanges(5n, 4n, 100n)).toEqual([]);
    expect(() => blockRanges(0n, 1n, 0n)).toThrow();
  });
});

import { shouldCheckVault, vaultAction } from "../src/decide.js";

describe("vault scheduling", () => {
  it("checks every N blocks", () => {
    expect(shouldCheckVault(40n, 20n)).toBe(true);
    expect(shouldCheckVault(41n, 20n)).toBe(false);
    expect(shouldCheckVault(41n, 1n)).toBe(true);
  });
  it("acts on every reason but None; MarginLow is urgent", () => {
    expect(vaultAction(0)).toEqual({ act: false, name: "None", urgent: false });
    expect(vaultAction(3)).toEqual({ act: true, name: "MarginLow", urgent: true });
    expect(vaultAction(7)).toEqual({ act: true, name: "SkewCap", urgent: false });
  });
});

describe("funding poke inclusion lag (Phase 3 rehearsal)", () => {
  it("lag 2 pokes two blocks early so a one-block-late landing still keeps gaps ≤ 20", () => {
    const base = { lastUpdateBlock: 100n, maxGapBlocks: 20n };
    expect(shouldPokeFunding({ ...base, currentBlock: 118n, inclusionLagBlocks: 2n })).toBe(true);
    expect(shouldPokeFunding({ ...base, currentBlock: 117n, inclusionLagBlocks: 2n })).toBe(false);
    expect(shouldPokeFunding({ ...base, currentBlock: 118n, inclusionLagBlocks: 1n })).toBe(false);
  });
});
