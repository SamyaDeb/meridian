// Ported from meridian-k5/risk/test/perpl.test.ts (rates-risk @ 1edb15f): dex-sdk vectors + the recorded K3 hedge account.
import { describe, expect, it } from "vitest";
import { perplFeeWad, perplPct100kToAprWad as perplAprFromPct100k, perplRateToAprWad as perplAprFromMicros } from "../src/perpl/units";
import { SHOCKS_BPS, effectiveEntryQ16, fundingCostPerDayWad, perplPositionRisk, perplShock, perplSide, type PerplPositionRaw } from "../src/route";
import { WAD } from "../src/util/fixed";

const pos = (o: Partial<PerplPositionRaw>): PerplPositionRaw => ({
  positionType: 0,
  depositCNS: 0n,
  pricePNS: 0n,
  priceResiduePNSQ16: 0n,
  lotLNS: 0n,
  deltaPnlCNS: 0n,
  premiumPnlCNS: 0n,
  ...o,
});
const w = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n; // decimal → WAD (6 dp inputs only)

describe("Perpl SDK test vectors (dex-sdk position.rs test_liquidation_price / test_bankruptcy_price)", () => {
  // Converter::new(4): price 1_000_000 PNS = 100.0000; size 10; deposit 100; maintenance_margin 20 (= 2000 hdths) ⇒ MMR 50
  const mkt = { priceDecimals: 4, lotDecimals: 0, maintMarginHdths: 2000n };
  const base = { pricePNS: 1_000_000n, lotLNS: 10n, depositCNS: 100_000_000n };
  it("long 95, then 100 after paying 5 per unit (premium −50); bankruptcy 90 → 95", () => {
    expect(perplPositionRisk(pos({ ...base }), 1_000_000n, mkt).liqPriceWad).toBe(95n * WAD);
    expect(perplPositionRisk(pos({ ...base }), 1_000_000n, mkt).mmrWad).toBe(50n * WAD);
    expect(perplPositionRisk(pos({ ...base }), 1_000_000n, mkt).bankruptcyPriceWad).toBe(90n * WAD);
    const paid = pos({ ...base, premiumPnlCNS: -50_000_000n });
    expect(perplPositionRisk(paid, 1_000_000n, mkt).liqPriceWad).toBe(100n * WAD);
    expect(perplPositionRisk(paid, 1_000_000n, mkt).bankruptcyPriceWad).toBe(95n * WAD);
  });
  it("short 105, then 100 after paying (premium −50); bankruptcy 110 → 105", () => {
    const short = pos({ ...base, positionType: 1 });
    expect(perplPositionRisk(short, 1_000_000n, mkt).liqPriceWad).toBe(105n * WAD);
    expect(perplPositionRisk(short, 1_000_000n, mkt).bankruptcyPriceWad).toBe(110n * WAD);
    const paid = pos({ ...base, positionType: 1, premiumPnlCNS: -50_000_000n });
    expect(perplPositionRisk(paid, 1_000_000n, mkt).liqPriceWad).toBe(100n * WAD);
    expect(perplPositionRisk(paid, 1_000_000n, mkt).bankruptcyPriceWad).toBe(105n * WAD);
  });
  it("funding received moves the liquidation price away from entry: long 90, short 110 (test_liquidation_price_after_funding_received)", () => {
    expect(perplPositionRisk(pos({ ...base, premiumPnlCNS: 50_000_000n }), 1_000_000n, mkt).liqPriceWad).toBe(90n * WAD);
    expect(perplPositionRisk(pos({ ...base, positionType: 1, premiumPnlCNS: 50_000_000n }), 1_000_000n, mkt).liqPriceWad).toBe(110n * WAD);
  });
});

describe("effective entry (SDK effective_entry_price)", () => {
  it("long stored ceil: (p − 1) + r/Q when r > 0; short stored floor: p + r/Q; r = 0 ⇒ p", () => {
    expect(effectiveEntryQ16({ positionType: 0, pricePNS: 2587n, priceResiduePNSQ16: 35288n })).toBe(2586n * 65536n + 35288n);
    expect(effectiveEntryQ16({ positionType: 1, pricePNS: 2587n, priceResiduePNSQ16: 35288n })).toBe(2587n * 65536n + 35288n);
    expect(effectiveEntryQ16({ positionType: 0, pricePNS: 2587n, priceResiduePNSQ16: 0n })).toBe(2587n * 65536n);
    expect(() => effectiveEntryQ16({ positionType: 0, pricePNS: 1n, priceResiduePNSQ16: 65536n })).toThrow();
  });
});

describe("the K3 hedge account on Perpl testnet (account 969, MON perp 64, getPositionV2 at block 69,155,862)", () => {
  // recorded read: positionType 0, depositCNS 22,508,666, pricePNS 2,587, residue 35,288, lotLNS 2,600,
  // deltaPnlCNS −845,999, premiumPnlCNS −10,530, mark 2,554; getMarginFractions(64, ·).perpMaintMarginFracHdths 500
  const raw = pos({ depositCNS: 22_508_666n, pricePNS: 2587n, priceResiduePNSQ16: 35288n, lotLNS: 2600n, deltaPnlCNS: -845_999n, premiumPnlCNS: -10_530n });
  const mkt = { priceDecimals: 5, lotDecimals: 0, maintMarginHdths: 500n };
  const r = perplPositionRisk(raw, 2554n, mkt);
  it("matches an exact-rational recomputation (Python fractions) of Perpl's formula", () => {
    expect(r.side).toBe("Long");
    expect(r.sizeWad).toBe(2600n * WAD);
    expect(r.entryWad).toBe(25_865_384_521_484_375n); // 0.025865384521484375 exactly (2586 + 35288/65536) / 1e5
    expect(r.liqPriceWad).toBe(22_385_332_195_012_020n); // 0.02238533219501201…, rounded up (toward the mark)
    expect(r.bankruptcyPriceWad).toBe(17_212_255_290_715_145n); // 0.0172122552907151…, rounded up
    expect(r.mmrWad).toBe(13_449_999_951_171_875_000n); // 13.449999951171875 AUSD, exact
    expect(r.maintFractionWad).toBe(WAD / 5n); // testnet MON: 20 % of notional
    expect(r.unrealizedPnlWad).toBe(-856_529n * 10n ** 12n); // the view's own pnlCNS
    expect(r.liqDistanceBps).toBe(1235n); // 12.35 % down to the liquidation price
    expect(Number(r.leverageWad) / 1e18).toBeCloseTo(2.98774, 4);
  });
  it("−15 % liquidates (equity 11.69 < MMR 13.45), −5 % doesn't; +15 % is fine", () => {
    const s15 = perplShock(raw, 2554n, mkt, -1500n);
    expect(s15.outcome).toBe("liquidated");
    expect(s15.equityWad).toBe(11_691_536_244_140_625_000n);
    expect(perplShock(raw, 2554n, mkt, -500n).outcome).toBe("ok");
    expect(perplShock(raw, 2554n, mkt, 1500n).outcome).toBe("ok");
    expect(SHOCKS_BPS.map((b) => perplShock(raw, 2554n, mkt, b).outcome)).toEqual(["liquidated", "ok", "ok", "ok", "ok", "ok"]);
  });
  it("a 0 % shock reproduces the exchange's own PnL to within its rounding (≤ 1 CNS)", () => {
    const s0 = perplShock(raw, 2554n, mkt, 0n);
    const diff = s0.pnlWad - r.unrealizedPnlWad;
    expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(10n ** 12n);
  });
});

describe("rounding against the trader", () => {
  const mkt = { priceDecimals: 5, lotDecimals: 0, maintMarginHdths: 500n };
  const odd = { pricePNS: 2587n, priceResiduePNSQ16: 12345n, lotLNS: 7n, depositCNS: 77_777n };
  it("liquidation price: long rounds up, short rounds down (both toward the mark)", () => {
    const l = perplPositionRisk(pos(odd), 2554n, mkt).liqPriceWad;
    const s = perplPositionRisk(pos({ ...odd, positionType: 1 }), 2554n, mkt).liqPriceWad;
    // exact values (Fraction): long 0.01999..., short ...; check the direction via the remainder
    const E = (2586n * 65536n + 12345n) * 600n * 1_000_000n * 7n;
    const den = 65536n * 100000n * 500n * 1_000_000n * 7n;
    const longNum = (E - 77_777n * 65536n * 100000n * 500n) * WAD;
    expect(l * den >= longNum).toBe(true);
    expect((l - 1n) * den < longNum).toBe(true);
    const Es = (2587n * 65536n + 12345n) * 400n * 1_000_000n * 7n;
    const shortNum = (Es + 77_777n * 65536n * 100000n * 500n) * WAD;
    expect(s * den <= shortNum).toBe(true);
    expect((s + 1n) * den > shortNum).toBe(true);
  });
  it("funding: what's owed rounds up, what's received rounds down in size", () => {
    const apr = 123_456_789_012_345_678n; // ≈ 12.3 % APR
    const pays = fundingCostPerDayWad("Long", 2600n * WAD, 25_540_000_000_000_000n, apr);
    const gets = fundingCostPerDayWad("Short", 2600n * WAD, 25_540_000_000_000_000n, apr);
    const exactNum = apr * 2600n * WAD * 25_540_000_000_000_000n * 86_400n;
    const den = WAD * WAD * 31_536_000n;
    expect(pays * den >= exactNum && (pays - 1n) * den < exactNum).toBe(true);
    expect(gets).toBe(-(pays - 1n)); // the same magnitude, one wei smaller
  });
  it("a long liquidation price below 0 clamps to 0 (as the SDK does)", () => {
    const r = perplPositionRisk(pos({ pricePNS: 100n, lotLNS: 1n, depositCNS: 1_000_000_000n }), 100n, mkt);
    expect(r.liqPriceWad).toBe(0n);
    expect(r.liqDistanceBps).toBe(10_000n);
  });
});

describe("units", () => {
  it("onchain pct100k and API micros give the same APR (PERPL_EVENTS 'Units' 1: micros = pct100k · 10)", () => {
    expect(perplAprFromPct100k(-4n, 2580n)).toBe(perplAprFromMicros(-40n, 2580n));
    expect(perplAprFromPct100k(-4n, 2580n)).toBe(-488_930_232_558_139_534n); // ≈ −48.9 % (PERPL_EVENTS example), toward zero
    expect(perplAprFromMicros(30n, 2580n)).toBe(366_697_674_418_604_651n); // mainnet MON 8 Oct: rate 30 ⇒ 36.67 %
  });
  it("fees: 345 micros = 3.45 bps", () => {
    expect(perplFeeWad(345n)).toBe(345n * 10n ** 12n);
    expect(Number(perplFeeWad(345n)) / 1e18).toBeCloseTo(0.000345, 9);
  });
  it("side codes", () => {
    expect(perplSide(0)).toBe("Long");
    expect(perplSide(1)).toBe("Short");
    expect(() => perplSide(2)).toThrow();
    expect(() => perplPositionRisk(pos({ lotLNS: 0n }), 1n, { priceDecimals: 5, lotDecimals: 0, maintMarginHdths: 500n })).toThrow();
  });
  it("w helper sanity", () => expect(w(1)).toBe(WAD));
});
