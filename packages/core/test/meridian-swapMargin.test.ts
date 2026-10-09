// Funding-swap margin (MATH_SPEC §6.4) against the Solidity test vectors in contracts/test/unit/SwapMath.t.sol
// (SwapMarginLib, SwapMathLib.value) and FundingSwapMarket._mm / _fee / _check, same rounding.
import { describe, expect, it } from "vitest";
import { swapInitialMargin, swapLockNeedWad, swapMaintenanceMargin, swapTakerFeeWad, swapValueWad } from "../src/meridian";

const WAD = 10n ** 18n;
const I = 29n * 10n ** 15n; // 0.029
const Q = 1_000_000n * WAD;
const DAY = 86_400n;
const capApr = 555_555_555_556n * 365n * DAY; // 0.2 %/h ⇒ 1,752 % APR
const obs = (markAprWad: bigint, tauSec = 30n * DAY) => ({ markAprWad, indexWad: I, capAprWad: capApr, tauSec });
const P = { liqHorizonSec: DAY, aprMoveBuffer: 5n * 10n ** 16n, imMultiplier: 15n * 10n ** 17n, takerFeeApr: 2n * 10n ** 15n };
const kOf = (q: bigint, apr: bigint) => (q * apr) / WAD;
const rel = (a: bigint, b: bigint) => Math.abs(Number(a - b)) / Number(b);

describe("swap margin (SwapMath.t.sol vectors)", () => {
  it("defaults at inception: MM ≈ 5.24 %, IM ≈ 7.87 % of notional, IM ≈ 2,281 AUSD (MATH_SPEC §6.6)", () => {
    const mm = swapMaintenanceMargin(Q, kOf(Q, 12n * 10n ** 16n), obs(12n * 10n ** 16n), P);
    const im = swapInitialMargin(mm, P.imMultiplier);
    const notional = (Q * I) / WAD;
    expect(rel((mm * WAD) / notional, 524n * 10n ** 14n)).toBeLessThan(0.002);
    expect(rel((im * WAD) / notional, 787n * 10n ** 14n)).toBeLessThan(0.002);
    expect(Math.abs(Number((im - 2281n * WAD) / WAD))).toBeLessThanOrEqual(3);
  });
  it("price-shock term off the mark = 128.71; a short is margined like the mirrored long", () => {
    const k = kOf(Q, 12n * 10n ** 16n);
    const at = swapMaintenanceMargin(Q, k, obs(12n * 10n ** 16n), P);
    const off = swapMaintenanceMargin(Q, k, obs(3n * 10n ** 17n), P);
    expect(Math.abs(Number(off - at - 12871n * 10n ** 16n))).toBeLessThan(1e16);
    expect(swapMaintenanceMargin(-Q, -k, obs(3n * 10n ** 17n), P)).toBe(off);
  });
  it("_mm rules: τ = 0 ⇒ 0; q = 0 with K ≤ 0 ⇒ 0; requirements round up", () => {
    expect(swapMaintenanceMargin(Q, 1n, obs(0n, 0n), P)).toBe(0n);
    expect(swapMaintenanceMargin(0n, -30_000n * WAD, obs(2n * 10n ** 17n), P)).toBe(0n);
    expect(swapMaintenanceMargin(1n, 0n, { markAprWad: 0n, indexWad: 1n, capAprWad: 1n, tauSec: 1n }, { liqHorizonSec: 1n, aprMoveBuffer: 1n })).toBeGreaterThanOrEqual(1n);
    expect(swapInitialMargin(1n, P.imMultiplier)).toBe(2n);
  });
  it("value: locked spread q = 0, K = −30,000 over 20 d ≈ +47.67; rounds down", () => {
    const v = swapValueWad(0n, -30_000n * WAD, { markAprWad: 2n * 10n ** 17n, indexWad: I, tauSec: 20n * DAY });
    expect(Math.abs(Number(v - 4767n * 10n ** 16n))).toBeLessThan(1e16);
    expect(swapValueWad(0n, 1n, { markAprWad: 0n, indexWad: 1n, tauSec: 1n })).toBe(-1n);
    expect(swapValueWad(0n, -1n, { markAprWad: 0n, indexWad: 1n, tauSec: 1n })).toBe(0n);
  });
  it("taker fee |Δq|·I·feeApr·τ/YEAR rounds up", () => {
    expect(swapTakerFeeWad(Q, obs(0n), P.takerFeeApr)).toBe(4_767_123_287_671_232_877n); // 29,000 · 0.2 % · 30/365, ↑
  });
});

describe("swapLockNeedWad (contract check: collateral − fee + V ≥ IM after the fill)", () => {
  const base = { q0: 0n, k0: 0n, dq: -Q, worstAprWad: 12n * 10n ** 16n, obs: obs(12n * 10n ** 16n), params: P };
  it("empty account selling at the mark ⇒ IM + fee (V = 0)", () => {
    const need = swapLockNeedWad({ ...base, collateralWad: 0n });
    const im = swapInitialMargin(swapMaintenanceMargin(-Q, -kOf(Q, 12n * 10n ** 16n), base.obs, P), P.imMultiplier);
    expect(need).toBe(im + swapTakerFeeWad(Q, base.obs, P.takerFeeApr));
  });
  it("selling below the mark costs the value gap too; collateral already there is netted; never negative", () => {
    const worse = swapLockNeedWad({ ...base, worstAprWad: 10n * 10n ** 16n, collateralWad: 0n });
    const atMark = swapLockNeedWad({ ...base, collateralWad: 0n });
    expect(worse).toBeGreaterThan(atMark);
    expect(swapLockNeedWad({ ...base, collateralWad: atMark - 1n })).toBe(1n);
    expect(swapLockNeedWad({ ...base, collateralWad: 10n ** 30n })).toBe(0n);
  });
});
