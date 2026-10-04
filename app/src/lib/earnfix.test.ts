import { describe, expect, it } from "vitest";
import {
  closeOrder,
  lotsFor,
  marketLimitTick,
  snapshotsFromLogs,
  swapAprToTick,
  swapPositionFromViews,
  swapTickToAprWad,
  vaultStatus,
  vaultWithdrawFeeToken,
  vaultWithdrawPath,
} from "./earnfix";

const TICK = 10n ** 14n;
const LOT = 1_000n * 10n ** 18n;
const V = "0x00000000000000000000000000000000000000aa" as const;
const U = "0x00000000000000000000000000000000000000bb" as const;

describe("vault withdrawals (PulseVault.previewRedeem, _ensureIdle)", () => {
  it("5 bps fee rounds up: 100 AUSD ⇒ 0.05; 1 unit ⇒ 1 unit", () => {
    expect(vaultWithdrawFeeToken(100_000_000n)).toBe(50_000n);
    expect(vaultWithdrawFeeToken(1n)).toBe(1n);
    expect(vaultWithdrawFeeToken(0n)).toBe(0n);
    expect(vaultWithdrawFeeToken(19_999n)).toBe(10n); // 9.9995 ⇒ 10
  });
  it("idle first, unwind beyond it", () => {
    expect(vaultWithdrawPath(113_333_333n, 100_000_000n)).toBe("idle");
    expect(vaultWithdrawPath(113_333_333n, 113_333_334n)).toBe("unwind");
  });
  it("status: hedged / rebalancing / waiting for funding (PRD US6)", () => {
    expect(vaultStatus(true, 0)).toBe("hedged");
    expect(vaultStatus(true, 7)).toBe("rebalancing");
    expect(vaultStatus(false, 5)).toBe("rebalancing");
    expect(vaultStatus(false, 0)).toBe("waiting");
  });
  it("route pending: an unhedged vault waits for the route; a hedged one keeps its state", () => {
    expect(vaultStatus(false, 0, true)).toBe("waiting-route");
    expect(vaultStatus(false, 5, true)).toBe("waiting-route");
    expect(vaultStatus(true, 0, true)).toBe("hedged");
  });
});

describe("swap order entry (p = 1 + APR, tick 1 bp)", () => {
  it("12.00% ↔ tick 11,200; off-grid: long floors, short ceils", () => {
    expect(swapAprToTick(120_000_000_000_000_000n, TICK, true)).toBe(11_200);
    expect(swapAprToTick(120_050_000_000_000_000n, TICK, true)).toBe(11_200);
    expect(swapAprToTick(120_050_000_000_000_000n, TICK, false)).toBe(11_201);
    expect(swapTickToAprWad(11_098, TICK)).toBe(109_800_000_000_000_000n);
    expect(swapAprToTick(-50_000_000_000_000_000n, TICK, true)).toBe(9_500);
    expect(() => swapAprToTick(-WAD_(), TICK, true)).toThrow(/−100%/);
  });
  it("market limit tick = opposite best ± slippage; none without liquidity", () => {
    expect(marketLimitTick(true, 11_098, 20)).toBe(11_118);
    expect(marketLimitTick(false, 11_092, 20)).toBe(11_072);
    expect(marketLimitTick(false, 5, 20)).toBe(1);
    expect(marketLimitTick(true, undefined, 20)).toBeNull();
  });
  it("lots and close", () => {
    expect(lotsFor(2_500n * 10n ** 18n, LOT)).toBe(2n);
    expect(lotsFor(999n * 10n ** 18n, LOT)).toBe(0n);
    expect(closeOrder(2_000n * 10n ** 18n, LOT)).toEqual({ isBid: false, lots: 2n });
    expect(closeOrder(-3_000n * 10n ** 18n, LOT)).toEqual({ isBid: true, lots: 3n });
    expect(closeOrder(0n, LOT)).toBeNull();
  });
});

describe("parsers", () => {
  it("NavSnapshot logs → newest-first VaultSnapshot rows", () => {
    const rows = snapshotsFromLogs(
      V,
      [
        { blockNumber: 10n, logIndex: 0, args: { nav: 1n, totalShares: 2n, sharePriceWad: 3n, fundingAccruedWad: 4n } },
        { blockNumber: 12n, logIndex: 1, args: { nav: 5n, totalShares: 6n, sharePriceWad: 7n, fundingAccruedWad: -8n } },
      ],
      (b) => b * 100n,
    );
    expect(rows.map((r) => [r.block, r.sharePriceWad, r.timestamp])).toEqual([
      [12n, 7n, 1_200n],
      [10n, 3n, 1_000n],
    ]);
    expect(rows[0]!.id).toBe(`${V}-12-1`);
  });
  it("swap views → position row; a closed position at another APR is a locked spread", () => {
    const open = swapPositionFromViews(V, U, { size: 2n * LOT, fixedAprNotional: 219_600_000_000_000_000_000n }, { collateral: 5n, avgFixedApr: 109_800_000_000_000_000n, accruedNet: -7_743_156_685n }, 146n);
    expect(open).toMatchObject({ size: 2n * LOT, avgFixedAprWad: 109_800_000_000_000_000n, netAccrued: -7_743_156_685n, lockedSpread: false });
    const locked = swapPositionFromViews(V, U, { size: 0n, fixedAprNotional: -30_000n * 10n ** 18n }, { collateral: 5n, avgFixedApr: 0n, accruedNet: 1n }, 1n);
    expect(locked.lockedSpread).toBe(true);
    expect(locked.avgFixedAprWad).toBeUndefined();
  });
});

function WAD_(): bigint {
  return 10n ** 18n;
}
