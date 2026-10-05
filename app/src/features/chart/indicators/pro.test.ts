// Hand-computed fixtures for the pro indicators (each worked out in the comment above it).
import { describe, expect, it } from "vitest";
import { adx, atr, ichimoku, obv, stochastic, supertrend, trueRange, vwap, wilder, type Ohlcv } from "./pro";

const k = (o: number, h: number, l: number, c: number, volume = 1, time = 0): Ohlcv => ({ time, open: o, high: h, low: l, close: c, volume });

describe("true range / Wilder / ATR", () => {
  // bars: (H,L,C) = (10,8,9), (12,9,11), (11,7,8)
  // TR: 2, max(3,|12−9|=3,|9−9|=0)=3, max(4,|11−11|=0,|7−11|=4)=4
  const b = [k(9, 10, 8, 9), k(9, 12, 9, 11), k(11, 11, 7, 8)];
  it("TR", () => expect(trueRange(b)).toEqual([2, 3, 4]));
  // Wilder n=2: seed mean(2,3)=2.5, then (2.5·1 + 4)/2 = 3.25
  it("ATR(2) = 2.5 then 3.25", () => expect(atr(b, 2)).toEqual([undefined, 2.5, 3.25]));
  it("Wilder with a start offset and too little data", () => {
    expect(wilder([9, 1, 3], 2, 1)).toEqual([undefined, undefined, 2]);
    expect(wilder([1], 2)).toEqual([undefined]);
  });
});

describe("VWAP (UTC session)", () => {
  // day 0: typical (3,3,3)=3 vol 1, then typical (6,6,6)=6 vol 2 ⇒ (3+12)/3 = 5. Day 1 resets: typical 9 ⇒ 9.
  it("cumulates within a day and resets at UTC midnight", () => {
    const v = vwap([k(3, 3, 3, 3, 1, 0), k(6, 6, 6, 6, 2, 60), k(9, 9, 9, 9, 5, 86_400)]);
    expect(v).toEqual([3, 5, 9]);
  });
  it("no volume yet ⇒ undefined", () => expect(vwap([k(1, 1, 1, 1, 0)])).toEqual([undefined]));
});

describe("Stochastic", () => {
  // n=2, d=2. bar1: HH=12 LL=8 C=11 ⇒ 75; bar2: HH=12 LL=7 C=8 ⇒ 20; %D at bar2 = (75+20)/2 = 47.5
  it("%K and %D", () => {
    const s = stochastic([k(9, 10, 8, 9), k(9, 12, 9, 11), k(11, 11, 7, 8)], 2, 2);
    expect(s.k).toEqual([undefined, 75, 20]);
    expect(s.d).toEqual([undefined, undefined, 47.5]);
  });
  it("flat range ⇒ 50", () => expect(stochastic([k(1, 1, 1, 1), k(1, 1, 1, 1)], 2, 1).k[1]).toBe(50));
});

describe("OBV", () => {
  // closes 10, 11 (+5), 11 (0), 9 (−2) ⇒ 0, 5, 5, 3
  it("adds on up closes, subtracts on down, ignores flat", () => expect(obv([k(0, 0, 0, 10, 9), k(0, 0, 0, 11, 5), k(0, 0, 0, 11, 7), k(0, 0, 0, 9, 2)])).toEqual([0, 5, 5, 3]));
});

describe("ADX", () => {
  // strictly rising highs and lows by 1 each bar with range 2: +DM = 1, −DM = 0 every bar ⇒ +DI = 100·1/TR, −DI = 0,
  // DX = 100 ⇒ ADX = 100 once seeded.
  it("pure up-trend ⇒ −DI 0, ADX 100", () => {
    const b = Array.from({ length: 12 }, (_, i) => k(i, i + 2, i, i + 1));
    const r = adx(b, 3);
    expect(r.minusDi.filter((x) => x !== undefined).every((x) => x === 0)).toBe(true);
    expect(r.adx[r.adx.length - 1]).toBeCloseTo(100, 9);
  });
  it("bounded in [0, 100] on a zig-zag", () => {
    const b = Array.from({ length: 40 }, (_, i) => k(10, 10 + (i % 3), 8 - (i % 2), 9 + (i % 4) / 2));
    for (const v of adx(b, 5).adx) if (v !== undefined) expect(v >= 0 && v <= 100).toBe(true);
  });
});

describe("Ichimoku", () => {
  // t=2,k=3,s=4 on highs 1..5, lows 0..4: tenkan at i = (H_i + L_{i−1})/2 = (i+1 + i−1)/2 = i; kijun at i = (i+1 + i−2)/2 = i − 0.5
  it("midpoints and span A", () => {
    const b = Array.from({ length: 5 }, (_, i) => k(i, i + 1, i, i));
    const r = ichimoku(b, 2, 3, 4);
    expect(r.tenkan).toEqual([undefined, 1, 2, 3, 4]);
    expect(r.kijun).toEqual([undefined, undefined, 1.5, 2.5, 3.5]);
    expect(r.spanA).toEqual([undefined, undefined, 1.75, 2.75, 3.75]);
    expect(r.spanB[3]).toBe(2); // (4 + 0)/2
    expect(r.displacement).toBe(3);
  });
});

describe("Supertrend", () => {
  it("follows the lower band in an up-trend and flips down on a crash", () => {
    const up = Array.from({ length: 15 }, (_, i) => k(10 + i, 11 + i, 9 + i, 10.5 + i));
    const crash = [k(24, 24, 5, 5), k(5, 6, 4, 4.5)];
    const r = supertrend([...up, ...crash], 3, 1);
    const i = up.length - 1;
    expect(r.up[i]).toBe(true);
    expect(r.line[i]!).toBeLessThan(up[i]!.close);
    expect(r.up[r.up.length - 1]).toBe(false);
    expect(r.line[r.line.length - 1]!).toBeGreaterThan(4.5);
  });
});
