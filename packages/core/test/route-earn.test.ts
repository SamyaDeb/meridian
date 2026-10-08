import { describe, expect, it } from "vitest";
import { pnsToWad, perplRateToAprWad } from "../src/perpl/units";
import {
  CadenceMeter,
  fundingPerDayFromAprWad,
  lcm,
  lockQuote,
  measureCadence,
  meridianEffectiveAprWad,
  meridianFundingPerDayWad,
  meridianLiq,
  perplFundingPerDayWad,
  perplPositionRisk,
  planBasis,
  type BasisVenue,
} from "../src/route";
import { SECONDS_PER_YEAR, WAD } from "../src/util/fixed";
import { fixtureJson, rng } from "./helpers";

const nominal = { blocks: 1n, elapsedMs: 300n }; // the chain at exactly fundingParams.blockTimeMs

describe("Meridian funding per block (MATH_SPEC §1.2, §1.4), measured cadence, never timestamps", () => {
  it("§1.7(b): I = 0.029, r = 3_472_222_222, 1,000,000 MON long for 1 day ≈ 8.70 AUSD, rounds up", () => {
    const i = { sizeWad: 1_000_000n * WAD, ratePerSecWad: 3_472_222_222n, indexWad: 29n * 10n ** 15n, paramBlockTimeMs: 300n, cadence: nominal };
    const owed = meridianFundingPerDayWad(i);
    const exactNum = i.sizeWad * i.ratePerSecWad * i.indexWad * 86_400n;
    expect(owed * WAD * WAD >= exactNum && (owed - 1n) * WAD * WAD < exactNum).toBe(true); // ceil of the exact value
    expect(Number(owed) / 1e18).toBeCloseTo(8.7, 2);
  });
  it("a short receives the same magnitude, rounded toward +∞ (receives ≤ exact)", () => {
    const base = { ratePerSecWad: 3_472_222_222n, indexWad: 29n * 10n ** 15n, paramBlockTimeMs: 300n, cadence: nominal };
    const pays = meridianFundingPerDayWad({ ...base, sizeWad: 1_000_000n * WAD });
    const gets = meridianFundingPerDayWad({ ...base, sizeWad: -1_000_000n * WAD });
    expect(gets <= 0n && -gets <= pays && pays + gets <= 1n).toBe(true);
  });
  it("slower blocks than the contract's blockTimeMs ⇒ less funding per real day (400 ms ⇒ ×0.75)", () => {
    const base = { sizeWad: 1_000_000n * WAD, ratePerSecWad: 3_472_222_222n, indexWad: 29n * 10n ** 15n, paramBlockTimeMs: 300n };
    const slow = meridianFundingPerDayWad({ ...base, cadence: { blocks: 100n, elapsedMs: 40_000n } });
    const fast = meridianFundingPerDayWad({ ...base, cadence: nominal });
    expect(slow * 4n - fast * 3n <= 4n && slow * 4n - fast * 3n >= -4n).toBe(true);
    expect(meridianEffectiveAprWad(3_472_222_222n, 300n, nominal)).toBe(3_472_222_222n * SECONDS_PER_YEAR); // nominal = rateToApr
    expect(meridianEffectiveAprWad(3_472_222_222n, 300n, { blocks: 3n, elapsedMs: 1_200n })).toBe((3_472_222_222n * SECONDS_PER_YEAR * 3n) / 4n);
  });
  it("cadence from block.number advance over the client clock; a lagging head is not progress", () => {
    expect(measureCadence({ block: 100n, atMs: 0 }, { block: 110n, atMs: 3_100 })).toEqual({ blocks: 10n, elapsedMs: 3_100n });
    expect(measureCadence({ block: 100n, atMs: 0 }, { block: 100n, atMs: 3_100 })).toBeUndefined();
    const m = new CadenceMeter(10_000);
    m.observe(1n, 0);
    m.observe(5n, 1_200);
    m.observe(4n, 1_300); // ignored
    m.observe(11n, 3_000);
    expect(m.cadence()).toEqual({ blocks: 10n, elapsedMs: 3_000n });
    m.observe(50n, 20_000);
    expect(m.cadence()).toBeUndefined(); // window holds one observation
  });
});

describe("Perpl funding per interval (MFI.md §2: micros per funding_interval_sec; + ⇒ longs pay)", () => {
  const market143 = fixtureJson<{ calls: { results: { result: Record<string, string> }[] }[] }>("perpl/chain/market-143.json");
  const markPns = BigInt(market143.calls[1]!.results[0]!.result.markPNS!.replace(/n$/, ""));
  it("recorded mainnet mark (getPerpetualInfoV2) at rate 30 micros / 2,580 s: 1,000 MON long, rounds up", () => {
    const mark = pnsToWad(markPns, 6);
    expect(mark).toBe(25_298n * 10n ** 12n);
    const owed = perplFundingPerDayWad({ sizeWad: 1_000n * WAD, markWad: mark, rateMicros: 30, fundingIntervalSec: 2_580 });
    const exactNum = 1_000n * WAD * mark * 30n * 10n ** 12n * 86_400n;
    const den = WAD * WAD * 2_580n;
    expect(owed * den >= exactNum && (owed - 1n) * den < exactNum).toBe(true);
    expect(Number(owed) / 1e18).toBeCloseTo((1000 * 0.025298 * 30e-6 * 86400) / 2580, 9);
    expect(perplFundingPerDayWad({ sizeWad: -1_000n * WAD, markWad: mark, rateMicros: 30, fundingIntervalSec: 2_580 })).toBe(-(owed - 1n));
  });
  it("same money as the APR route within rounding; bad interval refused", () => {
    const apr = perplRateToAprWad(30, 2_580);
    const viaApr = fundingPerDayFromAprWad("long", 25_298n * 10n ** 15n, apr);
    const direct = perplFundingPerDayWad({ sizeWad: 1_000n * WAD, markWad: 25_298n * 10n ** 12n, rateMicros: 30, fundingIntervalSec: 2_580 });
    expect(direct - viaApr <= 2n && viaApr - direct <= 2n).toBe(true);
    expect(() => perplFundingPerDayWad({ sizeWad: 1n, markWad: 1n, rateMicros: 1, fundingIntervalSec: 0 })).toThrow();
  });
});

const pct = (x: bigint) => x * 10n ** 16n;
const M = (apr: bigint, fee = 5n * 10n ** 14n, step = 100n * WAD): BasisVenue => ({ aprWad: apr, takerFeeWad: fee, stepWad: step });
const P = (apr: bigint, fee = 345n * 10n ** 12n, step = WAD): BasisVenue => ({ aprWad: apr, takerFeeWad: fee, stepWad: step });

describe("basis plan", () => {
  it("short the higher-funding venue, long the lower; equal size floored to both steps; net after fees over 30 d", () => {
    const b = planBasis({ meridian: M(pct(11n)), perpl: P(pct(37n)), sizeWad: 1_250n * WAD, markWad: 25_000n * 10n ** 12n });
    expect([b.shortVenue, b.longVenue]).toEqual(["perpl", "meridian"]);
    expect(b.sizeWad).toBe(1_200n * WAD);
    expect(b.legs).toEqual([
      { venue: "perpl", side: "short", sizeWad: 1_200n * WAD },
      { venue: "meridian", side: "long", sizeWad: 1_200n * WAD },
    ]);
    expect(b.netExposureWad).toBe(0n);
    expect(b.grossAprWad).toBe(pct(26n));
    // 2·(0.0005 + 0.000345)·365/30 = 0.02056166… ⇒ rounds UP
    expect(b.feeDragAprWad).toBe(20_561_666_666_666_667n);
    expect(b.netAprWad).toBe(pct(26n) - 20_561_666_666_666_667n);
    expect(b.notionalWad).toBe(30n * WAD);
    expect(b.estPerDayWad).toBe((30n * WAD * b.netAprWad * 86_400n) / (WAD * SECONDS_PER_YEAR));
    expect(b.edge).toBe(true);
  });
  it("Meridian higher ⇒ short Meridian; no edge when fees eat the spread; tiny size ⇒ flagged, no edge", () => {
    expect(planBasis({ meridian: M(pct(20n)), perpl: P(pct(5n)), sizeWad: 100n * WAD, markWad: WAD }).shortVenue).toBe("meridian");
    const thin = planBasis({ meridian: M(pct(10n)), perpl: P(pct(11n)), sizeWad: 1_000n * WAD, markWad: WAD });
    expect(thin.netAprWad < 0n && thin.edge).toBe(false);
    const tiny = planBasis({ meridian: M(pct(1n)), perpl: P(pct(90n)), sizeWad: 99n * WAD, markWad: WAD });
    expect(tiny.sizeWad).toBe(0n);
    expect(tiny.flags).toContain("size-below-step");
    expect(tiny.edge).toBe(false);
    expect(planBasis({ meridian: M(pct(5n)), perpl: P(pct(5n)), sizeWad: 100n * WAD, markWad: WAD }).flags).toContain("no-spread");
  });
  it("property (seeded): net MON exposure is 0 (or flagged); size ≤ asked and on both steps; short leg has the higher APR", () => {
    const r = rng(2026);
    for (let n = 0; n < 1_000; n++) {
      const ms = 10n ** BigInt(r.int(15, 21));
      const ps = BigInt(r.int(1, 9)) * 10n ** BigInt(r.int(14, 19));
      const m = M(r.big(-pct(200n), pct(200n)), r.big(0n, 10n ** 16n), ms);
      const p = P(r.big(-pct(200n), pct(200n)), r.big(0n, 10n ** 16n), ps);
      const size = r.big(0n, 10n ** 25n);
      const b = planBasis({ meridian: m, perpl: p, sizeWad: size, markWad: r.big(1n, 10n ** 20n), horizonDays: BigInt(r.int(1, 90)) });
      expect(b.netExposureWad === 0n || b.flags.includes("net-exposure")).toBe(true);
      expect(b.netExposureWad).toBe(0n);
      expect(b.sizeWad <= size && b.sizeWad % ms === 0n && b.sizeWad % ps === 0n).toBe(true);
      expect(b.stepWad).toBe(lcm(ms, ps));
      const shortApr = b.shortVenue === "perpl" ? p.aprWad : m.aprWad;
      const longApr = b.longVenue === "perpl" ? p.aprWad : m.aprWad;
      expect(shortApr >= longApr).toBe(true);
      expect(b.netAprWad).toBe(b.grossAprWad - b.feeDragAprWad);
      if (b.edge) expect(b.netAprWad > 0n && b.sizeWad > 0n).toBe(true);
    }
  });
});

describe("lock: fixed-rate quote from the swap book (MATH_SPEC §6, price = 1 + APR)", () => {
  const LOT = 1_000n * WAD; // swap lot (test input; SwapOrderBook.lotSize() onchain)
  const lv = (aprBps: bigint, lots: bigint) => ({ priceWad: WAD + aprBps * 10n ** 14n, sizeWad: lots * LOT });
  const bids = [lv(1_200n, 2n), lv(1_150n, 3n)];
  const asks = [lv(1_250n, 1n), lv(1_300n, 5n)];
  it("perp short (receives floating) sells the swap at the bids; fixed received rounds DOWN; fee subtracted", () => {
    const q = lockQuote({ perpSide: "short", perpSizeWad: -3_500n * WAD, bids, asks, swapLotWad: LOT, takerFeeAprWad: 2n * 10n ** 15n });
    expect(q.swapSide).toBe("sell");
    expect(q.sizeWad).toBe(3_000n * WAD); // floored to the 1,000 MON lot
    expect(q.unlockedWad).toBe(500n * WAD);
    expect(q.fixedAprWad).toBe((2n * 1_200n + 1n * 1_150n) * 10n ** 14n / 3n); // 11.8333…% ⇒ floor
    expect(q.netFixedAprWad).toBe(q.fixedAprWad! - 2n * 10n ** 15n);
  });
  it("perp long (pays floating) buys the swap at the asks; fixed paid rounds UP; fee added", () => {
    const q = lockQuote({ perpSide: "long", perpSizeWad: 3_000n * WAD, bids, asks, swapLotWad: LOT, takerFeeAprWad: 2n * 10n ** 15n });
    expect(q.swapSide).toBe("buy");
    const exact = (1n * 1_250n + 2n * 1_300n) * 10n ** 14n; // ÷ 3
    expect(q.fixedAprWad).toBe(exact / 3n + (exact % 3n === 0n ? 0n : 1n));
    expect(q.netFixedAprWad).toBe(q.fixedAprWad! + 2n * 10n ** 15n);
  });
  it("empty book ⇒ not available, everything floats", () => {
    expect(lockQuote({ perpSide: "short", perpSizeWad: -1_000n * WAD, bids: [], asks: [], swapLotWad: LOT, takerFeeAprWad: 0n })).toMatchObject({ available: false, sizeWad: 0n, unlockedWad: 1_000n * WAD, fixedAprWad: undefined });
  });
});

describe("liquidation views", () => {
  it("Meridian: MATH_SPEC §3.2 price + adverse distance (long 1 @ 1.00, C 0.2, mmr 10 % ⇒ 0.8889, 11.11 %)", () => {
    const l = meridianLiq({ sizeWad: WAD, entryWad: WAD, collateralWad: WAD / 5n, markWad: WAD, mmrWad: WAD / 10n });
    expect(l.liqPriceWad).toBe(888_888_888_888_888_889n); // long rounds up (warns early)
    expect(l.distanceBps).toBe(1_111n);
    expect(meridianLiq({ sizeWad: 0n, entryWad: WAD, collateralWad: 0n, markWad: WAD, mmrWad: WAD / 10n })).toEqual({ liqPriceWad: undefined, distanceBps: undefined });
  });
  it("Perpl: the recorded K5 accounts (getPositionV2) reproduce the monitor's liquidation prices", () => {
    type W = { expected: { positions: Record<string, string | number>[] } };
    const big = (v: string | number | undefined) => BigInt(String(v));
    for (const [file, pd, liq] of [
      ["perpl/chain/account-10143-k3-hedge.json", 5, 22_385_332_195_012_020n],
      ["perpl/chain/account-143-1076.json", 6, undefined],
    ] as const) {
      const p = fixtureJson<W>(file).expected.positions[0]!;
      const r = perplPositionRisk(
        { positionType: Number(p.positionType), depositCNS: big(p.depositCNS), pricePNS: big(p.pricePNS), priceResiduePNSQ16: big(p.priceResiduePNSQ16), lotLNS: big(p.lotLNS), deltaPnlCNS: big(p.deltaPnlCNS), premiumPnlCNS: big(p.premiumPnlCNS) },
        big(p.markPNS),
        { priceDecimals: pd, lotDecimals: Number(p.lotDecimals), maintMarginHdths: big(p.maintMarginHdths) },
      );
      if (liq !== undefined) expect(r.liqPriceWad).toBe(liq);
      else {
        // K5 proof §14: mainnet account 1076 liquidation 0.018084 (rounded up to Perpl's 6 price decimals), 28.51 % away
        expect((r.liqPriceWad + 10n ** 12n - 1n) / 10n ** 12n).toBe(18_084n);
        expect(r.liqDistanceBps).toBe(2_851n);
      }
    }
  });
});
