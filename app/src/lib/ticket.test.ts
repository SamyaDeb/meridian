import { describe, expect, it } from "vitest";
import type { AccountSummary } from "@/data/types";
import {
  FLAG_IOC,
  FLAG_POST_ONLY,
  FLAG_REDUCE_ONLY,
  applyFill,
  decodeFlags,
  estimateFill,
  imForLots,
  lotsForPercent,
  lotsFromInput,
  minFilledLotsFor,
  orderFlags,
  postOnlyWouldCross,
  previewOrder,
  reduceOnlyLots,
  referencePrice,
  slippageLimitTick,
} from "./ticket";
import { priceToTick, tickToPrice } from "./orders";
import { PERP_LOT_SIZE_WAD as LOT, PERP_TICK_SIZE_WAD as TICK, WAD } from "./units";

const P = 27_046n * TICK; // 0.027046

describe("flags (IOrderBook: post-only 1, IOC 2, reduce-only 4)", () => {
  it("maps each toggle to its bit", () => {
    expect(FLAG_POST_ONLY).toBe(1);
    expect(FLAG_IOC).toBe(2);
    expect(FLAG_REDUCE_ONLY).toBe(4);
    expect(orderFlags({})).toBe(0);
    expect(orderFlags({ postOnly: true })).toBe(1);
    expect(orderFlags({ ioc: true })).toBe(2);
    expect(orderFlags({ reduceOnly: true })).toBe(4);
    expect(orderFlags({ postOnly: true, reduceOnly: true })).toBe(5);
    expect(orderFlags({ ioc: true, reduceOnly: true })).toBe(6);
  });
  it("rejects post-only + IOC", () => {
    expect(() => orderFlags({ postOnly: true, ioc: true })).toThrow(/Post-only/);
  });
  it("decode ∘ encode round-trips every valid combination", () => {
    for (const f of [0, 1, 2, 4, 5, 6]) expect(orderFlags(decodeFlags(f))).toBe(f);
  });
});

describe("size conversions", () => {
  it("MON and AUSD inputs floor to whole lots", () => {
    expect(lotsFromInput(250n * WAD, "MON", P, LOT)).toBe(2n);
    expect(lotsFromInput(99n * WAD, "MON", P, LOT)).toBe(0n);
    // 10 AUSD / 0.027046 = 369.7 MON → 3 lots
    expect(lotsFromInput(10n * WAD, "AUSD", P, LOT)).toBe(3n);
    expect(lotsFromInput(10n * WAD, "AUSD", 0n, LOT)).toBe(0n);
  });
  it("round trip lots → MON → lots is exact; MON → lots → MON never exceeds the input", () => {
    for (const lots of [0n, 1n, 7n, 1_000n]) expect(lotsFromInput(lots * LOT, "MON", P, LOT)).toBe(lots);
    for (const mon of [1n, 150n, 999n, 12_345n]) expect(lotsFromInput(mon * WAD, "MON", P, LOT) * LOT).toBeLessThanOrEqual(mon * WAD);
  });
  it("AUSD → lots → AUSD never exceeds the AUSD typed (user never trades more than asked)", () => {
    for (const a of [1n, 3n, 10n, 77n, 1_000n]) {
      const lots = lotsFromInput(a * WAD, "AUSD", P, LOT);
      expect((lots * LOT * P) / WAD).toBeLessThanOrEqual(a * WAD);
    }
  });
});

describe("lotsForPercent", () => {
  const imr = 2n * 10n ** 17n; // 5x cap
  it("IM of the result fits the budget for every pct (rounding up included)", () => {
    for (const pct of [1n, 25n, 50n, 75n, 100n]) {
      const free = 1_000n * WAD + 123_456n;
      const lots = lotsForPercent(free, 5n, imr, P, pct, LOT);
      expect(imForLots(lots, LOT, P, imr)).toBeLessThanOrEqual((free * pct) / 100n);
      // and one more lot would not fit (maximal)
      expect(imForLots(lots + 1n, LOT, P, imr)).toBeGreaterThan((free * pct) / 100n);
    }
  });
  it("leverage below the cap binds notional", () => {
    const lots = lotsForPercent(100n * WAD, 2n, imr, P, 100n, LOT);
    expect((lots * LOT * P) / WAD).toBeLessThanOrEqual(200n * WAD);
    expect(lots).toBe((200n * WAD * WAD) / P / LOT);
  });
  it("zero inputs give zero; pct clamps at 100", () => {
    expect(lotsForPercent(0n, 5n, imr, P, 100n, LOT)).toBe(0n);
    expect(lotsForPercent(100n * WAD, 5n, imr, P, 150n, LOT)).toBe(lotsForPercent(100n * WAD, 5n, imr, P, 100n, LOT));
  });
});

describe("slippage → limitTick / minFilledLots", () => {
  it("buy ceiling floors, sell floor ceils (rounded in the user's favour)", () => {
    const buy = slippageLimitTick(P, TICK, true, 50n); // 27046 · 1.005 = 27181.23 → 27181
    expect(buy).toBe(27_181);
    expect(tickToPrice(buy, TICK) * 10_000n).toBeLessThanOrEqual(P * 10_050n);
    const sell = slippageLimitTick(P, TICK, false, 50n); // 27046 · 0.995 = 26910.77 → 26911
    expect(sell).toBe(26_911);
    expect(tickToPrice(sell, TICK) * 10_000n).toBeGreaterThanOrEqual(P * 9_950n);
  });
  it("zero slippage = the reference tick both ways", () => {
    expect(slippageLimitTick(P, TICK, true, 0n)).toBe(27_046);
    expect(slippageLimitTick(P, TICK, false, 0n)).toBe(27_046);
  });
  it("rejects invalid slippage and out-of-range ticks", () => {
    expect(() => slippageLimitTick(P, TICK, true, 10_000n)).toThrow();
    expect(() => slippageLimitTick(P, TICK, true, -1n)).toThrow();
    expect(() => slippageLimitTick(10n ** 30n, TICK, true, 0n)).toThrow(/tick range/);
  });
  it("all-or-revert by default, 1 lot when partial fills are allowed", () => {
    expect(minFilledLotsFor(7n, false)).toBe(7n);
    expect(minFilledLotsFor(7n, true)).toBe(1n);
    expect(minFilledLotsFor(0n, true)).toBe(0n);
  });
  it("reference price: buys use the best ask, sells the best bid, mark when empty", () => {
    expect(referencePrice(true, 1n, 2n, 9n)).toBe(2n);
    expect(referencePrice(false, 1n, 2n, 9n)).toBe(1n);
    expect(referencePrice(true, 1n, undefined, 9n)).toBe(9n);
  });
  it("price ↔ tick round trip: bid ≤ price ≤ ask", () => {
    for (const px of [P, P + 1n, P + TICK - 1n]) {
      expect(tickToPrice(priceToTick(px, TICK, "bid"), TICK)).toBeLessThanOrEqual(px);
      expect(tickToPrice(priceToTick(px, TICK, "ask"), TICK)).toBeGreaterThanOrEqual(px);
    }
  });
});

describe("estimateFill", () => {
  const asks = [
    { priceWad: 100n * TICK, sizeWad: 2n * LOT },
    { priceWad: 101n * TICK, sizeWad: 1n * LOT },
    { priceWad: 105n * TICK, sizeWad: 10n * LOT },
  ];
  it("sweeps within the limit; average rounds up for a buy", () => {
    const f = estimateFill(asks, 4n, LOT, true, 104n * TICK);
    expect(f.filledLots).toBe(3n);
    expect(f.worstPriceWad).toBe(101n * TICK);
    const exact = (2n * 100n + 101n) * TICK; // Σ price per lot
    expect(f.avgPriceWad * 3n).toBeGreaterThanOrEqual(exact);
    expect(f.avgPriceWad * 3n - exact).toBeLessThan(3n);
  });
  it("sell average rounds down; nothing inside the limit fills nothing", () => {
    const bids = [{ priceWad: 3n * TICK, sizeWad: 1n * LOT }, { priceWad: 2n * TICK, sizeWad: 2n * LOT }];
    const f = estimateFill(bids, 3n, LOT, false, 2n * TICK);
    expect(f.filledLots).toBe(3n);
    expect(f.avgPriceWad * 3n).toBeLessThanOrEqual(7n * TICK);
    expect(estimateFill(bids, 3n, LOT, false, 4n * TICK).filledLots).toBe(0n);
  });
});

describe("pre-checks", () => {
  it("post-only crossing", () => {
    expect(postOnlyWouldCross(true, 10n, 5n, 10n)).toBe(true);
    expect(postOnlyWouldCross(true, 9n, 5n, 10n)).toBe(false);
    expect(postOnlyWouldCross(false, 5n, 5n, 10n)).toBe(true);
    expect(postOnlyWouldCross(false, 6n, 5n, undefined)).toBe(false);
  });
  it("reduce-only only shrinks, clamped to the position", () => {
    expect(reduceOnlyLots(5n * LOT, false, 9n, LOT)).toBe(5n);
    expect(reduceOnlyLots(5n * LOT, false, 2n, LOT)).toBe(2n);
    expect(reduceOnlyLots(5n * LOT, true, 2n, LOT)).toBe(0n); // same side would grow
    expect(reduceOnlyLots(0n, true, 2n, LOT)).toBe(0n);
    expect(reduceOnlyLots(-3n * LOT, true, 9n, LOT)).toBe(3n);
  });
});

describe("applyFill (MATH_SPEC §3.1)", () => {
  const flat = { size: 0n, openNotional: 0n, collateral: 100n * WAD };
  it("increase adds Δq·P; taker fee rounds up", () => {
    const r = applyFill(flat, LOT, P, 5n * 10n ** 14n);
    expect(r.size).toBe(LOT);
    expect(r.openNotional).toBe((LOT * P) / WAD);
    // fee = 2.7046 · 0.0005 = 0.0013523 AUSD exactly; rounds up only on a remainder
    expect(r.fee).toBe(1_352_300_000_000_000n);
    expect(r.collateral).toBe(100n * WAD - r.fee);
  });
  it("odd fee remainder rounds up, rebate rounds toward zero", () => {
    const up = applyFill(flat, LOT, P + 1n, 3n);
    expect(up.fee * WAD).toBeGreaterThanOrEqual(((LOT * (P + 1n)) / WAD) * 3n);
    const rebate = applyFill(flat, LOT, P + 1n, -3n);
    expect(rebate.fee).toBeLessThanOrEqual(0n);
    expect(-rebate.fee * WAD).toBeLessThanOrEqual(((LOT * (P + 1n)) / WAD) * 3n);
  });
  it("decrease realizes PnL rounded down; full close leaves ON = 0", () => {
    const long = applyFill(flat, 3n * LOT, P, 0n);
    const closed = applyFill(long, -3n * LOT, P + 1_000n * TICK, 0n);
    expect(closed.size).toBe(0n);
    expect(closed.openNotional).toBe(0n);
    expect(closed.realizedPnl).toBe((3n * LOT * 1_000n * TICK) / WAD);
  });
  it("partial decrease releases ON rounded toward +∞ (realized ↓) for a long and a short", () => {
    const long = { size: 3n * LOT, openNotional: 10n * WAD + 1n, collateral: 0n };
    const r = applyFill(long, -LOT, P, 0n);
    expect(r.openNotional * 3n).toBeLessThanOrEqual(2n * (10n * WAD + 1n)); // released rounded up
    const short = { size: -3n * LOT, openNotional: -(10n * WAD + 1n), collateral: 0n };
    const s = applyFill(short, LOT, P, 0n);
    expect(s.size).toBe(-2n * LOT);
    expect(s.realizedPnl).toBeLessThanOrEqual(-((LOT * P) / WAD) + (10n * WAD + 1n) / 3n);
  });
  it("flip closes the old side and opens the rest at P", () => {
    const long = applyFill(flat, LOT, P, 0n);
    const flipped = applyFill(long, -3n * LOT, P, 0n);
    expect(flipped.size).toBe(-2n * LOT);
    expect(flipped.openNotional).toBe(-(2n * LOT * P) / WAD);
  });
});

describe("previewOrder", () => {
  const base = {
    lotSize: LOT,
    priceWad: P,
    markWad: P,
    indexWad: P,
    ratePerSecondWad: 3_472_222_222n, // 10.95% APR interest-only (MATH_SPEC §1.7 b)
    blockTimeMs: 300n,
    imrWad: 2n * 10n ** 17n,
    mmrWad: 10n ** 17n,
    feeRateWad: 5n * 10n ** 14n,
  };
  const acct = (size: bigint, entry: bigint, collateral: bigint): AccountSummary => ({
    collateral,
    size,
    entryPrice: entry,
    unrealizedPnl: 0n,
    pendingFunding: 0n,
    equity: collateral,
    initialMargin: 0n,
    maintenanceMargin: 0n,
    reservedOrderMargin: 0n,
    liquidationPrice: 0n,
    liquidatable: false,
  });
  it("new long: notional, margin ↑, fee ↑, a liquidation price below entry, funding paid per block", () => {
    // 1,000 MON ≈ 27 AUSD notional on 10 AUSD collateral (~2.7x): liquidatable below entry
    const p = previewOrder({ ...base, account: acct(0n, 0n, 10n * WAD), isBid: true, lots: 10n });
    expect(p.sizeWad).toBe(10n * LOT);
    expect(p.notionalWad).toBe((10n * LOT * P) / WAD);
    expect(p.marginWad * 5n).toBeGreaterThanOrEqual(p.notionalWad);
    expect(p.feeWad).toBeGreaterThan(0n);
    expect(p.entryWad).toBe(P);
    expect(p.liqPriceWad).toBeDefined();
    expect(p.liqPriceWad!).toBeLessThan(P);
    // ΔF/block = r·I·0.3 s; 1000 MON long pays ceil(q·ΔF) > 0
    expect(p.fundingPerBlockWad).toBeGreaterThan(0n);
  });
  it("short earns funding when the rate is positive (negative = earned), liq above entry", () => {
    const p = previewOrder({ ...base, account: acct(0n, 0n, 100n * WAD), isBid: false, lots: 10n });
    expect(p.newSizeWad).toBe(-10n * LOT);
    expect(p.fundingPerBlockWad).toBeLessThanOrEqual(0n);
    expect(p.liqPriceWad!).toBeGreaterThan(P);
  });
  it("closing the whole position previews flat (no liq price, no funding)", () => {
    const p = previewOrder({ ...base, account: acct(10n * LOT, P, 100n * WAD), isBid: false, lots: 10n });
    expect(p.newSizeWad).toBe(0n);
    expect(p.liqPriceWad).toBeUndefined();
    expect(p.fundingPerBlockWad).toBe(0n);
  });
  it("over-collateralized long has no liquidation price (P ≤ 0)", () => {
    expect(previewOrder({ ...base, account: acct(0n, 0n, 100n * WAD), isBid: true, lots: 10n }).liqPriceWad).toBeUndefined();
  });
  it("no account behaves like a flat account with zero collateral", () => {
    const p = previewOrder({ ...base, account: undefined, isBid: true, lots: 1n });
    expect(p.newSizeWad).toBe(LOT);
  });
});

describe("chunk / closeLots", () => {
  it("chunks to MAX_BATCH with nothing lost or duplicated", async () => {
    const { chunk } = await import("./ticket");
    const ids = Array.from({ length: 70 }, (_, i) => BigInt(i));
    const c = chunk(ids, 32);
    expect(c.map((x) => x.length)).toEqual([32, 32, 6]);
    expect(c.flat()).toEqual(ids);
    expect(chunk([], 32)).toEqual([]);
    expect(() => chunk(ids, 0)).toThrow();
  });
  it("close % floors to lots; 100 % is the whole position for either side", async () => {
    const { closeLots } = await import("./ticket");
    expect(closeLots(7n * LOT, LOT, 50n)).toBe(3n);
    expect(closeLots(-7n * LOT, LOT, 100n)).toBe(7n);
    expect(closeLots(7n * LOT, LOT, 25n)).toBe(1n);
  });
});
