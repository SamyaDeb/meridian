import { describe, it, expect } from "vitest";
import {
  divCeil,
  divFloor,
  pendingFundingWad,
  rateToAprWad,
  realizedAprWad,
  liquidationPriceWad,
  initialMarginWad,
  leverageWad,
  swapPriceToAprWad,
  swapAccrualPreviewWad,
  swapPositionValueWad,
  isLockedSpread,
  sharePriceWadFromAssets,
  tokenToWad,
  wadToToken,
} from "./math";
import { gasLimitFromEstimate } from "./gas";
import { SECONDS_PER_YEAR, WAD } from "./units";

const f = (x: bigint) => Number(x) / 1e18; // display-only conversion for tolerance checks
const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("rounding helpers", () => {
  it("ceil/floor for signed values", () => {
    expect([divCeil(7n, 2n), divCeil(-7n, 2n), divFloor(7n, 2n), divFloor(-7n, 2n)]).toEqual([4n, -3n, 3n, -4n]);
    expect(() => divFloor(1n, 0n)).toThrow();
  });
});

describe("per-block funding (MATH_SPEC §1.4, §1.8)", () => {
  it("pending funding rounds up against the account, + = user pays", () => {
    expect(pendingFundingWad(3n, 1n, 0n)).toBe(1n); // 3·1/1e18 → ceil = 1 wei
    expect(pendingFundingWad(-3n, 1n, 0n)).toBe(0n); // short receives: −3e-18 → ceil toward +∞ = 0
    expect(pendingFundingWad(1_000n * WAD, 5n * 10n ** 14n, 2n * 10n ** 14n)).toBe(3n * 10n ** 17n);
  });

  it("rate → APR; default floor 10.95%", () => {
    close(f(rateToAprWad(3_472_222_222n)), 0.1095);
  });

  it("realized APR matches ΔF/ΔG·YEAR (the lead's formula) to 1e-6", () => {
    const I = 29n * 10n ** 15n;
    const r = 5n * 10n ** 9n; // ≈ 15.77% APR
    const dt = 3_600n;
    const dG = I * dt;
    const dF = (r * I * dt) / WAD;
    const apr = realizedAprWad(0n, 0n, dF, dG)!;
    close(f(apr), ((Number(dF) * 1e18) / Number(dG)) * 31_536_000 / 1e18);
    close(f(apr), f(r * SECONDS_PER_YEAR));
    expect(realizedAprWad(1n, 5n, 2n, 5n)).toBeUndefined();
  });
});

describe("liquidation price preview (MATH_SPEC §3.2), mmr 10%", () => {
  const mmr = 10n ** 17n;
  it("long: (E − C/q)/(1 − mmr)", () => {
    // 5x long 10,000 MON at 0.03 with 60 AUSD ⇒ (0.03 − 0.006)/0.9 = 0.026667
    const liq = liquidationPriceWad(3n * 10n ** 16n, 60n * WAD, 10_000n * WAD, mmr)!;
    close(f(liq), (0.03 - 60 / 10_000) / 0.9);
  });
  it("short: (E + C/|q|)/(1 + mmr)", () => {
    const liq = liquidationPriceWad(3n * 10n ** 16n, 60n * WAD, -10_000n * WAD, mmr)!;
    close(f(liq), (0.03 + 60 / 10_000) / 1.1);
  });
  it("DEMO_SCRIPT crash: a 5x long is liquidated by a −15% move", () => {
    const E = 3n * 10n ** 16n;
    const q = 10_000n * WAD;
    const C = initialMarginWad(q, E, 2n * 10n ** 17n); // 20% ⇒ 5x
    const liq = liquidationPriceWad(E, C, q, mmr)!;
    expect(liq).toBeGreaterThan((E * 85n) / 100n);
  });
  it("undefined when flat or when never liquidatable", () => {
    expect(liquidationPriceWad(WAD, WAD, 0n, mmr)).toBeUndefined();
    expect(liquidationPriceWad(WAD, 10n * WAD, WAD, mmr)).toBeUndefined(); // over-collateralized long
  });
  it("margin and leverage", () => {
    expect(initialMarginWad(1_000n * WAD, 3n * 10n ** 16n, 2n * 10n ** 17n)).toBe(6n * WAD);
    expect(leverageWad(1_000n * WAD, 3n * 10n ** 16n, 6n * WAD)).toBe(5n * WAD);
    expect(leverageWad(1n, 1n, 0n)).toBe(0n);
  });
});

describe("funding swaps (MATH_SPEC §6)", () => {
  it("fixed APR = p − 1", () => expect(swapPriceToAprWad(112n * 10n ** 16n)).toBe(12n * 10n ** 16n));

  it("§6.6 worked example: long 1M at 12%, realized 18%, 30 d, I = 0.029 ⇒ +143.01 AUSD", () => {
    const q = 1_000_000n * WAD;
    const K = (q * 12n * 10n ** 16n) / WAD;
    const I = 29n * 10n ** 15n;
    const dG = I * 30n * 86_400n; // Σ I·Δt
    const dF = (18n * 10n ** 16n * dG) / (WAD * SECONDS_PER_YEAR); // realized 18% APR: ΔF = r·ΔG with r = 0.18/YEAR
    const net = swapAccrualPreviewWad(q, K, dF, dG);
    close(f(net), 143.01, 0.01);
  });

  it("net rounds down (against the account)", () => {
    expect(swapAccrualPreviewWad(1n, 0n, 1n, 0n)).toBe(0n); // 1e-36 floating → 0
    expect(swapAccrualPreviewWad(0n, 1n, 0n, 1n)).toBe(-1n); // tiny fixed leg → −1 wei
  });

  it("§6.3 value: plain long V = q·I·(markApr − Ā)·τ/YEAR; closed account V = −K·I·τ/YEAR", () => {
    const q = 1_000_000n * WAD;
    const I = 29n * 10n ** 15n;
    const tau = 20n * 86_400n;
    const K = (q * 12n * 10n ** 16n) / WAD;
    close(f(swapPositionValueWad(q, K, 15n * 10n ** 16n, I, tau)), 1_000_000 * 0.029 * 0.03 * (20 / 365), 1e-4);
    const locked = -30_000n * WAD; // offset example K = −30,000
    close(f(swapPositionValueWad(0n, locked, 15n * 10n ** 16n, I, tau)), 29_000 * 0.03 * (20 / 365), 1e-4); // ≈ +47.7
    expect(isLockedSpread(0n, locked)).toBe(true);
    expect(isLockedSpread(0n, 0n)).toBe(false);
    expect(swapPositionValueWad(q, K, 15n * 10n ** 16n, I, -5n)).toBe(0n); // matured
  });
});

describe("AUSD boundary and gas", () => {
  it("6 dp ↔ WAD, WAD → token rounds down", () => {
    expect(tokenToWad(1n)).toBe(10n ** 12n);
    expect(wadToToken(10n ** 12n - 1n)).toBe(0n);
    expect(sharePriceWadFromAssets(1_000_420n)).toBe(1_000_420n * 10n ** 12n);
  });
  it("gas limit = estimate × 1.2, rounded up", () => {
    expect(gasLimitFromEstimate(100_000n)).toBe(120_000n);
    expect(gasLimitFromEstimate(7n)).toBe(9n);
  });
});
